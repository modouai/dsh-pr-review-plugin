import test from 'node:test';
import assert from 'node:assert/strict';

import { createReviewRunner, userMessage } from '../review-runner.js';

function fakeRecord(files) {
  return {
    number: 1,
    headSha: 'abc',
    pull: { number: 1, repo: 'acme/demo', platform: 'github', title: 't' },
    files: files.map((path) => ({ path })),
    explanations: new Map(),
    report: null,
    reportUpdatedAt: 0,
    conclusion: null,
    conclusionAt: 0,
    run: null,
  };
}

function fakeCtx(onFollowup) {
  const created = [];
  const disposed = [];
  const restrictions = [];
  const mounts = [];
  const promptSections = [];
  const ctx = {
    created,
    disposed,
    restrictions,
    mounts,
    promptSections,
    get(name) {
      if (name === 'agentPresets') {
        return {
          async mount(agentCtx, id) {
            mounts.push({ agentCtx, id });
          },
        };
      }
      return undefined;
    },
    agents: {
      async create(options) {
        created.push(options);
        const agent = {
          id: options.sessionId,
          status: 'idle',
          followup(message) {
            onFollowup(message, agent, options);
          },
          async whenIdle() {},
        };
        await options.setup?.({
          systemPrompt: {
            section: (definition) => {
              // Mirror the host: systemPrompt.section() rejects a missing/non-finite order,
              // so a fake that accepts anything would hide a broken registration.
              if (!Number.isFinite(definition.order)) {
                throw new TypeError(`prompt section "${definition.name}" order must be a finite number`);
              }
              promptSections.push(definition);
              return () => {};
            },
          },
          tools: {
            schemas: () => [{ name: 'create_worktree' }, { name: 'review_get' }, { name: 'review_publish' }],
            restrict: (filter) => {
              restrictions.push(filter);
              return () => {};
            },
          },
        }, agent);
        return { agent, async dispose() { disposed.push(options.sessionId); } };
      },
    },
  };
  return ctx;
}

function runnerFor(record, ctx, overrides = {}) {
  return createReviewRunner({
    ctx,
    settings: {
      reviewAgentPreset: 'pr-review-readonly',
      reviewCoverageRetries: 2,
      reviewAgentMaxTokens: 8000,
      ...overrides,
    },
    record,
    selection: { provider: 'p', model: 'm' },
    cwd: '/repo',
  });
}

test('the runner creates a read-only review agent and sends the task prompt', async () => {
  const record = fakeRecord(['src/a.js']);
  const prompts = [];
  const ctx = fakeCtx((message) => {
    prompts.push(message.content[0].text);
    record.explanations.set('src/a.js', { status: 'done', explanation: { issues: [] }, updatedAt: Date.now() });
    record.report = { verdict: 'pass', summary: '报告', risks: [], order: [], focus: {} };
    record.reportUpdatedAt = Date.now();
    record.conclusion = { verdict: 'pass', summary: '结论', blockers: [], suggestions: [], nextSteps: [] };
    record.conclusionAt = Date.now();
  });
  await runnerFor(record, ctx).start();
  assert.equal(ctx.created.length, 1);
  assert.equal(ctx.created[0].meta.agentPreset, 'pr-review-readonly');
  assert.equal(ctx.created[0].meta.cwd, '/repo');
  assert.equal(ctx.created[0].agentOptions.provider, 'p');
  assert.equal(ctx.created[0].agentOptions.model, 'm');
  assert.equal(ctx.mounts.length, 1);
  assert.equal(ctx.mounts[0].id, 'pr-review-readonly');
  assert.deepEqual(ctx.restrictions, [{ deny: ['create_worktree', 'review_publish'] }]);
  assert.equal(ctx.promptSections.length, 1);
  assert.equal(ctx.promptSections[0].name, 'pr-review: readonly-agent');
  assert.equal(ctx.promptSections[0].order, 70);
  assert.match(ctx.promptSections[0].text, /review_update_conclusion/);
  assert.match(ctx.promptSections[0].text, /没有 review_publish/);
  assert.match(prompts[0], /review_list_files/);
  assert.match(prompts[0], /review_update_analysis/);
  assert.equal(record.run.status, 'done');
  assert.deepEqual(record.run.missingFiles, []);
  assert.equal(ctx.disposed.length, 1);
});

test('missing files trigger bounded follow-ups, then incomplete', async () => {
  const record = fakeRecord(['src/a.js', 'src/b.js']);
  const prompts = [];
  const ctx = fakeCtx((message) => { prompts.push(message.content[0].text); });
  await runnerFor(record, ctx, { reviewCoverageRetries: 1 }).start();
  assert.equal(prompts.length, 2, 'task + one coverage follow-up');
  assert.match(prompts[1], /src\/a\.js/);
  assert.equal(record.run.status, 'incomplete');
  assert.deepEqual(record.run.missingFiles, ['src/a.js', 'src/b.js']);
  assert.equal(ctx.disposed.length, 1);
});

test('a paths scope only requires the requested files', async () => {
  const record = fakeRecord(['src/a.js', 'src/b.js']);
  const ctx = fakeCtx(() => {
    record.explanations.set('src/a.js', { status: 'done', explanation: { issues: [] }, updatedAt: Date.now() });
    record.report = { verdict: 'pass', summary: '报告', risks: [], order: [], focus: {} };
    record.reportUpdatedAt = Date.now();
    record.conclusion = { verdict: 'pass', summary: '结论', blockers: [], suggestions: [], nextSteps: [] };
    record.conclusionAt = Date.now();
  });
  await createReviewRunner({
    ctx,
    settings: { reviewAgentPreset: 'pr-review-readonly', reviewCoverageRetries: 0 },
    record,
    selection: { provider: 'p', model: 'm' },
    cwd: '/repo',
    paths: ['src/a.js'],
  }).start();
  assert.equal(record.run.status, 'done');
  assert.deepEqual(record.run.missingFiles, []);
});

test('a pre-existing analysis does not satisfy this run coverage', async () => {
  const record = fakeRecord(['src/a.js']);
  record.explanations.set('src/a.js', { status: 'done', explanation: { issues: [{ point: '旧意见' }] }, updatedAt: 100 });
  const ctx = fakeCtx(() => {});
  await runnerFor(record, ctx, { reviewCoverageRetries: 0 }).start();
  assert.equal(record.run.status, 'incomplete');
  assert.deepEqual(record.run.missingFiles, ['src/a.js']);
});

test('agent errors mark the run error and still dispose', async () => {
  const record = fakeRecord(['src/a.js']);
  const ctx = fakeCtx(() => { throw new Error('agent failed'); });
  await runnerFor(record, ctx).start();
  assert.equal(record.run.status, 'error');
  assert.match(record.run.error, /agent failed/);
  assert.equal(ctx.disposed.length, 1);
});

test('userMessage uses the user source and a unique id', () => {
  const a = userMessage('x');
  const b = userMessage('x');
  assert.equal(a.role, 'user');
  assert.deepEqual(a.source, { kind: 'user' });
  assert.notEqual(a.id, b.id);
});

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

function fakeCtx(onFollowup, whenIdle = async () => {}) {
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
          async whenIdle() {
            await whenIdle();
          },
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

function runnerFor(record, ctx, overrides = {}, extra = {}) {
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
    ...extra,
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
  assert.match(prompts[0], /number: 1/);
  assert.equal(record.run.status, 'done');
  assert.deepEqual(record.run.missingFiles, []);
  assert.equal(ctx.disposed.length, 1);
});

test('the task prompt asks for a per-hunk walkthrough on every file analysis', async () => {
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
  assert.match(prompts[0], /walkthrough/);
  assert.match(prompts[0], /每个 hunk 写一条/);
  assert.match(prompts[0], /title/);
  assert.match(prompts[0], /startLine/);
  assert.match(prompts[0], /logic 只写整体/);
});

test('the task prompt asks for a readable logic narrative', async () => {
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
  assert.match(prompts[0], /`logic` 写给读代码的人看/);
  assert.match(prompts[0], /按执行顺序分行/);
  assert.match(prompts[0], /不要把多个函数名塞进一句/);
});

test('the runner exposes the created agent for PR binding', async () => {
  const record = fakeRecord(['src/a.js']);
  const seen = [];
  const ctx = fakeCtx((message) => {
    record.explanations.set('src/a.js', { status: 'done', explanation: { issues: [] }, updatedAt: Date.now() });
    record.report = { verdict: 'pass', summary: '报告', risks: [], order: [], focus: {} };
    record.reportUpdatedAt = Date.now();
    record.conclusion = { verdict: 'pass', summary: '结论', blockers: [], suggestions: [], nextSteps: [] };
    record.conclusionAt = Date.now();
  });
  await runnerFor(record, ctx, {}, { onAgent: (agent) => seen.push(agent.id) }).start();
  assert.equal(seen.length, 1);
  assert.equal(seen[0], record.run.agentSessionId);
});

test('the task prompt includes the previous conclusion items for re-judgement', async () => {
  const record = fakeRecord(['src/a.js']);
  record.round = 2;
  record.previousRound = {
    round: 1,
    items: [
      { kind: 'blocker', id: 'b-1', file: 'src/a.js', point: '旧问题', line: 3, index: 1 },
      { kind: 'suggestion', id: 's-2', file: 'src/a.js', point: '旧建议', line: 4, index: 2 },
    ],
  };
  let prompt = '';
  const ctx = fakeCtx((message) => { prompt = message.content[0].text; });
  await runnerFor(record, ctx, { reviewCoverageRetries: 0 }).start();
  assert.match(prompt, /上一轮（第 1 轮）结论中的 2 项/);
  assert.match(prompt, /#1 \[blocker\] src\/a\.js:3 旧问题/);
  assert.match(prompt, /#2 \[suggestion\] src\/a\.js:4 旧建议/);
  assert.match(prompt, /已修复的不要列出/);
  assert.match(prompt, /previousVerdicts/);
  assert.doesNotMatch(prompt, /baselineVerdicts/);
});

test('a same-round retry counts analyses written by the failed attempt', async () => {
  const record = fakeRecord(['src/a.js', 'src/b.js']);
  record.round = 3;
  record.run = { round: 3, headSha: 'abc', status: 'error' };
  record.explanations.set('src/a.js', { status: 'done', explanation: { issues: [] }, updatedAt: 100 });
  const ctx = fakeCtx(() => {});
  await runnerFor(record, ctx, { reviewCoverageRetries: 0 }).start();
  assert.equal(record.run.status, 'incomplete');
  assert.deepEqual(record.run.missingFiles, ['src/b.js'], 'only the file missing from the prior attempt');
  assert.equal(record.run.missingSections.length, 2, 'report/conclusion must still be written by this run');
});

test('a same-round retry with a different head re-analyzes every file', async () => {
  const record = fakeRecord(['src/a.js']);
  record.round = 3;
  record.run = { round: 3, headSha: 'old-head', status: 'error' };
  record.explanations.set('src/a.js', { status: 'done', explanation: { issues: [] }, updatedAt: 100 });
  const ctx = fakeCtx(() => {});
  await runnerFor(record, ctx, { reviewCoverageRetries: 0 }).start();
  assert.deepEqual(record.run.missingFiles, ['src/a.js']);
});

test('analyze=false asks only for report and conclusion', async () => {
  const record = fakeRecord(['src/a.js']);
  const prompts = [];
  const ctx = fakeCtx((message) => {
    prompts.push(message.content[0].text);
    record.report = { verdict: 'pass', summary: '报告', risks: [], order: [], focus: {} };
    record.reportUpdatedAt = Date.now();
    record.conclusion = { verdict: 'pass', summary: '结论', blockers: [], suggestions: [], nextSteps: [] };
    record.conclusionAt = Date.now();
  });
  await runnerFor(record, ctx, {}, { analyze: false }).start();
  assert.match(prompts[0], /只写总体报告/);
  assert.match(prompts[0], /本轮只要求 `review_update_report` 与 `review_update_conclusion`/);
  assert.equal(record.run.status, 'done');
  assert.deepEqual(record.run.missingFiles, []);
});

test('cancel resolves a pending whenIdle instead of hanging the run', async () => {
  const record = fakeRecord(['src/a.js']);
  const never = new Promise(() => {});
  const ctx = fakeCtx(() => {}, () => never);
  const runner = runnerFor(record, ctx, { reviewCoverageRetries: 0 });
  const task = runner.start();
  await new Promise((resolve) => setImmediate(resolve));
  await runner.cancel();
  await Promise.race([
    task,
    new Promise((_, reject) => setTimeout(() => reject(new Error('start did not return after cancel')), 1000)),
  ]);
  assert.equal(record.run.status, 'cancelled');
});

test('a missing global tool mask fails closed instead of running unguarded', async () => {
  const record = fakeRecord(['src/a.js']);
  const ctx = fakeCtx(() => {});
  ctx.agents.create = async (options) => {
    await options.setup?.({ systemPrompt: { section: () => () => {} } });
    return { agent: { id: 'a', followup() {}, async whenIdle() {} }, async dispose() {} };
  };
  await runnerFor(record, ctx).start();
  assert.equal(record.run.status, 'error');
  assert.match(record.run.error, /工具面不可用/);
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
  assert.equal(record.run.missingSections.length, 2);
  assert.equal(ctx.disposed.length, 1);
});

test('cancel writes a terminal run status instead of leaving running', async () => {
  const record = fakeRecord(['src/a.js']);
  let release;
  const idle = new Promise((resolve) => { release = resolve; });
  const ctx = fakeCtx(() => {}, () => idle);
  const runner = runnerFor(record, ctx, { reviewCoverageRetries: 0 });
  const task = runner.start();
  await new Promise((resolve) => setImmediate(resolve));
  await runner.cancel();
  assert.equal(record.run.status, 'cancelled');
  assert.match(record.run.error, /取消/);
  release();
  await task;
});

test('a pre-existing analysis does not satisfy this run coverage', async () => {
  const record = fakeRecord(['src/a.js']);
  record.explanations.set('src/a.js', { status: 'done', explanation: { issues: [{ point: '旧意见' }] }, updatedAt: 100 });
  const ctx = fakeCtx(() => {});
  await runnerFor(record, ctx, { reviewCoverageRetries: 0 }).start();
  assert.equal(record.run.status, 'incomplete');
  assert.deepEqual(record.run.missingFiles, ['src/a.js']);
});

test('a same-round retry still requires fresh report and conclusion', async () => {
  const record = fakeRecord(['src/a.js']);
  record.round = 3;
  record.run = { round: 3, headSha: 'abc', status: 'error' };
  record.explanations.set('src/a.js', { status: 'done', explanation: { issues: [] }, updatedAt: 100 });
  record.report = { verdict: 'pass', summary: '旧报告', risks: [], order: [], focus: {} };
  record.reportUpdatedAt = 100;
  record.conclusion = { verdict: 'pass', summary: '旧结论', blockers: [], suggestions: [], nextSteps: [] };
  record.conclusionAt = 100;
  const ctx = fakeCtx(() => {});
  await runnerFor(record, ctx, { reviewCoverageRetries: 0 }).start();
  assert.deepEqual(record.run.missingFiles, []);
  assert.equal(record.run.missingSections.length, 2);
  assert.equal(record.run.status, 'incomplete');
});

test('a same-round retry restates files missing from the failed attempt', async () => {
  const record = fakeRecord(['src/a.js', 'src/b.js']);
  record.round = 3;
  record.run = { round: 3, headSha: 'abc', status: 'error', missingFiles: ['src/b.js'] };
  record.explanations.set('src/a.js', { status: 'done', explanation: { issues: [] }, updatedAt: 100 });
  const prompts = [];
  const ctx = fakeCtx((message) => { prompts.push(message.content[0].text); });
  await runnerFor(record, ctx, { reviewCoverageRetries: 1 }).start();
  assert.deepEqual(record.run.missingFiles, ['src/b.js']);
  assert.match(prompts[0], /上次未完成：src\/b\.js/);
  assert.match(prompts[1], /src\/b\.js/);
  assert.match(prompts[0], /以下 1 个文件的分析会沿用/);
});

test('a same-round retry still counts a write-failed file as missing', async () => {
  const record = fakeRecord(['src/a.js', 'src/b.js']);
  record.round = 3;
  record.run = { round: 3, headSha: 'abc', status: 'error' };
  record.explanations.set('src/a.js', { status: 'done', explanation: { issues: [] }, updatedAt: 100 });
  record.explanations.set('src/b.js', { status: 'error', explanation: null, error: 'stale revision', updatedAt: 100 });
  const prompts = [];
  const ctx = fakeCtx((message) => { prompts.push(message.content[0].text); });
  await runnerFor(record, ctx, { reviewCoverageRetries: 1 }).start();
  assert.deepEqual(record.run.missingFiles, ['src/b.js']);
  assert.match(prompts[1], /写回失败/);
  assert.match(prompts[1], /stale revision/);
});

test('a cancelled prior run does not relax coverage', async () => {
  const record = fakeRecord(['src/a.js']);
  record.round = 3;
  record.run = { round: 3, headSha: 'abc', status: 'cancelled' };
  record.explanations.set('src/a.js', { status: 'done', explanation: { issues: [] }, updatedAt: 100 });
  const ctx = fakeCtx(() => {});
  await runnerFor(record, ctx, { reviewCoverageRetries: 0 }).start();
  assert.deepEqual(record.run.missingFiles, ['src/a.js']);
});

test('cancel during a pending create releases the fresh handle', async () => {
  const record = fakeRecord(['src/a.js']);
  const ctx = fakeCtx(() => {});
  const baseCreate = ctx.agents.create;
  ctx.agents.create = async (options) => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return baseCreate(options);
  };
  const runner = runnerFor(record, ctx, { reviewCoverageRetries: 0 });
  const task = runner.start();
  await new Promise((resolve) => setImmediate(resolve));
  await runner.cancel();
  await Promise.race([
    task,
    new Promise((_, reject) => setTimeout(() => reject(new Error('start did not return after cancel')), 1000)),
  ]);
  assert.equal(record.run.status, 'cancelled');
  assert.equal(ctx.disposed.length, 1);
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

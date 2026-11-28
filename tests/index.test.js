/**
 * Integration tests for the host half (index.js) against the conclusion-history
 * contract (§1/§3): legacy cache migration, async /conclude with stages and
 * cancellation, idempotent publishing, human versions + locked item ids and
 * auto-regeneration.
 *
 * The Host services (webServer / connection / llm / fetch) are faked; no network
 * and no real `~/.dsh/pr-review` cache is touched (HOME points at a temp dir).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { loadPrompt } from '../prompts.js';

const execFileAsync = promisify(execFile);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolve with the promise, or a sentinel value after `ms` (clears its timer either way). */
function within(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ status: -1, json: null }), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        resolve({ status: -2, json: null, error: String(error) });
      },
    );
  });
}

const CACHE_SLUG = 'forgejo-acme__demo.json';

function textResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return JSON.parse(body);
    },
    async text() {
      return body;
    },
  };
}

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    },
  };
}

/** Default fake fetch: only the pull-list poll is allowed, everything else fails loudly. */
async function defaultFetch(url) {
  const target = String(url);
  if (target.includes('/pulls?state=open')) return jsonResponse(200, []);
  throw new Error(`unexpected fetch in test: ${target}`);
}

/** LLM stream helper: yield one text answer and a stop finish chunk. */
function llmFromText(text) {
  return () => (async function* () {
    yield { type: 'text-delta', text };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })();
}

/** LLM stream that only completes after `ms` (or rejects when the call is aborted). */
function llmSlow(ms, text = '{}') {
  return (options) => (async function* () {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('This operation was aborted'));
      };
      if (options.signal.aborted) return onAbort();
      options.signal.addEventListener('abort', onAbort, { once: true });
    });
    yield { type: 'text-delta', text };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })();
}

function legacyReview(overrides = {}) {
  return {
    number: 1,
    status: 'done',
    headSha: 'abc123',
    startedAt: 100,
    finishedAt: 200,
    error: null,
    pull: {
      number: 1,
      title: 'PR 标题',
      body: '',
      author: 'dev',
      state: 'open',
      merged: false,
      additions: 1,
      deletions: 0,
      changedFiles: 1,
      headRef: 'feature',
      headSha: 'abc123',
      baseRef: 'main',
      baseSha: 'def456',
      url: 'https://git.example/acme/demo/pulls/1',
      platform: 'forgejo',
      repo: 'acme/demo',
    },
    files: [{ path: 'src/a.js', previousPath: '', status: 'modified', additions: 1, deletions: 0, changes: 1 }],
    report: {
      verdict: 'suggest',
      summary: '初步报告',
      risks: [{ severity: 'suggest', file: 'src/a.js', point: '风险一' }],
      order: [{ file: 'src/a.js', reason: '' }],
      focus: {},
    },
    explanations: [{
      file: 'src/a.js',
      status: 'done',
      error: null,
      explanation: { verdict: 'suggest', summary: '文件分析', issues: [{ severity: 'suggest', point: '注意', line: 1 }], suggestions: [] },
      chat: [],
      updatedAt: 150,
    }],
    pullChat: [],
    reportUpdatedAt: 0,
    conclusionEditedAt: 0,
    round: 1,
    published: [{ id: 555, url: 'https://git.example/comment/555', round: 1, publishedAt: 300, itemCount: 1 }],
    publishedItems: [{ kind: 'blocker', file: 'src/a.js', point: '旧问题' }],
    feedback: null,
    delta: null,
    previousRound: null,
    conclusionAt: 500,
    conclusion: {
      verdict: 'block',
      summary: '旧结论',
      blockers: [{ file: 'src/a.js', point: '旧问题' }],
      suggestions: [],
      nextSteps: ['旧下一步'],
    },
    comment: { id: 555, url: 'https://git.example/comment/555', publishedAt: 300 },
    ...overrides,
  };
}

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) this.body += String(chunk);
    },
  };
}

function makeReq(method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  return {
    method,
    url,
    headers: {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
    resume() {},
  };
}

/** Boot one plugin instance on faked Host services and a temp HOME cache. */
async function setup(options = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'dsh-pr-review-test-'));
  const cachePath = path.join(home, '.dsh', 'pr-review', CACHE_SLUG);
  await mkdir(path.dirname(cachePath), { recursive: true });
  const reviews = options.reviews === undefined ? { 1: legacyReview() } : options.reviews;
  // `cacheText` writes a pre-baked (possibly corrupt) cache instead of the legacy payload.
  await writeFile(cachePath, options.cacheText ?? JSON.stringify({ savedAt: 1, reviews }), 'utf8');

  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const previousFetch = globalThis.fetch;
  const fetchState = { handler: options.fetch ?? defaultFetch };
  globalThis.fetch = (...args) => fetchState.handler(...args);
  const llmState = { handler: options.llm ?? llmFromText('{}') };

  const routes = new Map();
  const cleanups = [];
  const toolRegistry = new Map();
  const promptContexts = [];
  const promptSections = [];
  const agentState = { mounts: [], restrictions: [], followups: [], disposed: [] };
  // Tools are executed exactly as the Host would expose them to an agent, so an agent
  // scenario can write through the real review_* handlers instead of faking a record.
  async function executeTool(name, args, agent) {
    const definition = toolRegistry.get(name);
    if (definition === undefined) throw new Error(`tool ${name} is not registered`);
    return definition.execute(args, { agent, signal: AbortSignal.timeout(5000) });
  }
  const agentPresets = options.agentPresets ?? {
    async register() {
      return () => {};
    },
    async mount(_agentCtx, id) {
      agentState.mounts.push(id);
    },
  };
  const agentsService = options.agents ?? {
    async create(createOptions) {
      let pending = Promise.resolve();
      const agent = {
        id: createOptions.sessionId,
        followup(message) {
          agentState.followups.push(message);
          if (typeof options.onAgentFollowup === 'function') {
            pending = pending.then(() => options.onAgentFollowup({ message, agent, executeTool, agentState }));
          }
        },
        async whenIdle() {
          await pending;
        },
      };
      await createOptions.setup?.({
        systemPrompt: {
          section(definition) {
            promptSections.push(definition);
            return () => {};
          },
        },
        tools: {
          schemas: () => [{ name: 'bash' }, { name: 'review_publish' }, { name: 'review_get' }],
          restrict(filter) {
            agentState.restrictions.push(filter);
            return () => {};
          },
        },
      });
      return {
        agent,
        async dispose() {
          agentState.disposed.push(agent.id);
        },
      };
    },
  };
  const ctx = {
    tools: {
      register(definition) {
        toolRegistry.set(definition.name, definition);
        return () => toolRegistry.delete(definition.name);
      },
    },
    effect(fn) {
      const cleanup = fn();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    },
    get(name) {
      if (name === 'tools') return ctx.tools;
      if (name === 'systemPrompt') return ctx.systemPrompt;
      if (name === 'agentPresets') return agentPresets;
      if (name === 'agents') return agentsService;
      return undefined;
    },
    agents: agentsService,
    agentPresets,
    systemPrompt: {
      section(definition) {
        promptSections.push(definition);
        return () => {};
      },
      context(definition) {
        if (options.promptContextThrows === true) throw new Error('prompt context rejected');
        promptContexts.push(definition);
        return () => {};
      },
    },
    on() {
      return () => {};
    },
    connection: {
      requestRejection() {
        return undefined;
      },
    },
    webServer: {
      register(entry) {
        routes.set(entry.path, entry.handler);
        return () => routes.delete(entry.path);
      },
    },
    llm: {
      stream: (streamOptions) => llmState.handler(streamOptions),
    },
  };

  const { apply } = await import('../index.js');
  apply(ctx, {
    platform: 'forgejo',
    baseUrl: 'https://git.example',
    repo: 'acme/demo',
    token: 'test-token',
    provider: 'test-provider',
    model: 'test-model',
    pollSeconds: 3600,
    commentLanguage: options.commentLanguage ?? 'zh',
    // The Agent only includes per-file analysis when autoAnalyze is on; most tests keep it
    // off to avoid the review-runner work unless the test is about that path.
    ...(options.useDefaultAutoAnalyze === true ? {} : { autoAnalyze: options.autoAnalyze === true }),
    ...(options.reviewCoverageRetries === undefined ? {} : { reviewCoverageRetries: options.reviewCoverageRetries }),
  });

  async function call(pathname, method = 'GET', body) {
    const url = new URL(pathname, 'http://localhost');
    const handler = routes.get(url.pathname);
    assert.ok(handler !== undefined, `route ${url.pathname} is registered`);
    const res = makeRes();
    await handler(makeReq(method, pathname, body), res);
    return { status: res.statusCode, json: res.body === '' ? null : JSON.parse(res.body) };
  }

  async function review(number = 1) {
    const response = await call(`/pr-review-api/review?number=${number}`);
    return response.json.review;
  }

  // Wait until the async cache load has put the legacy record in place.
  // Corrupt-cache and prune-only setups have no record 1 to wait for.
  if (options.skipLoadedCheck !== true) {
    let loaded = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      loaded = await review();
      if (loaded !== null) break;
      await delay(10);
    }
    assert.notEqual(loaded, null, 'legacy review record loaded from cache');
  }

  return {
    home,
    ctx,
    call,
    review,
    tools: toolRegistry,
    promptContexts,
    promptSections,
    /** Snapshot text the registered runtime-context provider returns for one session. */
    promptContext(sessionId = 'session-a', name = 'pr-review: focus') {
      const provider = promptContexts.find((entry) => entry.name === name);
      assert.ok(provider, `runtime context ${name} is registered`);
      return provider.text({ agent: { session: { id: sessionId } } });
    },
    async runTool(name, args = {}, agent = { session: { id: 'session-a' } }) {
      const definition = toolRegistry.get(name);
      assert.ok(definition, `tool ${name} is registered`);
      const value = await definition.execute(args, { agent, signal: AbortSignal.timeout(5000) });
      const blocks = definition.output.render(args, value);
      assert.ok(Array.isArray(blocks), 'output.render returns content blocks');
      return blocks.map((block) => String(block.text ?? '')).join('\n');
    },
    llmState,
    fetchState,
    agentState,
    async waitForConcluding(number = 1, timeout = 4000) {
      const deadline = Date.now() + timeout;
      let current = null;
      while (Date.now() < deadline) {
        current = await review(number);
        if (current !== null && current.concluding === null) return current;
        await delay(15);
      }
      throw new Error('timed out waiting for the conclusion job to finish');
    },
    async waitFor(number, predicate, timeout = 4000) {
      const deadline = Date.now() + timeout;
      let current = null;
      while (Date.now() < deadline) {
        current = await review(number);
        if (current !== null && predicate(current)) return current;
        await delay(15);
      }
      throw new Error('timed out waiting for the expected review state');
    },
    async dispose() {
      for (const cleanup of cleanups.reverse()) cleanup();
      process.env.HOME = previousHome;
      globalThis.fetch = previousFetch;
      await rm(home, { recursive: true, force: true });
    },
  };
}

test('migrates a legacy cache into roundHistory and serializes the new fields', async () => {
  const plugin = await setup();
  try {
    const review = await plugin.review();
    assert.equal(review.round, 1);
    assert.equal(review.roundHistory.length, 1);
    const round = review.roundHistory[0];
    assert.equal(round.round, 1);
    assert.equal(round.headSha, 'abc123');
    assert.equal(round.startedAt, 100);
    assert.equal(round.finishedAt, 200);
    assert.equal(round.conclusions.length, 1);
    assert.equal(round.conclusions[0].version, 1);
    assert.equal(round.conclusions[0].source, 'model');
    assert.equal(round.conclusions[0].createdAt, 500);
    assert.equal(round.conclusions[0].coverage, null);
    assert.equal(round.conclusions[0].conclusion.verdict, 'block');
    // Published ids of the current round move into the round entry.
    assert.deepEqual(round.publishedIds, [555]);
    // 复审对比不再挂结论阶段：轮次 entry 上没有 delta 字段。
    assert.ok(!('delta' in round));
    assert.equal(round.feedback, null);

    // Legacy items get stable ids; top-level fields mirror the newest version.
    assert.equal(typeof review.conclusion.blockers[0].id, 'string');
    assert.match(review.conclusion.blockers[0].id, /^b-[0-9a-f]{6}$/);
    assert.equal(review.published[0].version, 0);
    assert.deepEqual(review.humanItemIds, []);
    assert.equal(review.coverage, null);
    assert.equal(review.conclusionAt, 500);

    // /prs exposes the new config and prefers the conclusion verdict.
    const prs = await plugin.call('/pr-review-api/prs');
    assert.equal(prs.status, 200);
    assert.equal(prs.json.commentLanguage, 'zh');
    assert.equal(prs.json.reviews['1'].verdict, 'block');
  } finally {
    await plugin.dispose();
  }
});














test('a file chat applies findingOps to the merged findings list', async () => {
  const plugin = await setup({
    llm: llmFromText(JSON.stringify({
      answer: '好',
      findingOps: [
        { op: 'update', index: 2, point: '改写后的第二条', suggestion: '新修法' },
        { op: 'remove', index: 1 },
        { op: 'add', point: '新增意见', severity: 'block', line: 9 },
      ],
    })),
    reviews: {
      1: legacyReview({
        explanations: [{
          file: 'src/a.js',
          status: 'done',
          error: null,
          explanation: {
            verdict: 'suggest',
            summary: '文件分析',
            issues: [
              { severity: 'block', point: '第一条', suggestion: '修法一', line: 1 },
              { severity: 'suggest', point: '第二条', suggestion: '', line: 2 },
            ],
          },
          chat: [],
          updatedAt: 150,
        }],
      }),
    },
  });
  try {
    const chat = await plugin.call('/pr-review-api/chat', 'POST', { number: 1, message: '第二条不对', path: 'src/a.js' });
    assert.equal(chat.status, 200);
    assert.equal(chat.json.applied.length, 3);
    const review = await plugin.review();
    const entry = review.explanations.find((item) => item.file === 'src/a.js');
    assert.deepEqual(entry.explanation.issues, [
      { severity: 'suggest', point: '改写后的第二条', suggestion: '新修法', line: 2 },
      { severity: 'block', point: '新增意见', suggestion: '', line: 9 },
    ]);
    assert.ok(!('suggestions' in entry.explanation));
  } finally {
    await plugin.dispose();
  }
});

test('a file chat with legacy suggestionOps still rewrites findings', async () => {
  const plugin = await setup({
    llm: llmFromText(JSON.stringify({
      answer: '好',
      suggestionOps: [{ op: 'update', index: 1, text: '旧写法改写' }],
    })),
    reviews: {
      1: legacyReview({
        explanations: [{
          file: 'src/a.js',
          status: 'done',
          error: null,
          explanation: {
            verdict: 'suggest',
            summary: '文件分析',
            issues: [
              { severity: 'block', point: '第一条', suggestion: '修法一', line: 1 },
              { severity: 'suggest', point: '第二条', suggestion: '', line: 2 },
            ],
          },
          chat: [],
          updatedAt: 150,
        }],
      }),
    },
  });
  try {
    const chat = await plugin.call('/pr-review-api/chat', 'POST', { number: 1, message: '第一条不对', path: 'src/a.js' });
    assert.equal(chat.status, 200);
    assert.equal(chat.json.applied.length, 1);
    const review = await plugin.review();
    const entry = review.explanations.find((item) => item.file === 'src/a.js');
    assert.deepEqual(entry.explanation.issues[0], { severity: 'block', point: '旧写法改写', suggestion: '修法一', line: 1 });
  } finally {
    await plugin.dispose();
  }
});

test('a file chat edits the merged list review_update_analysis wrote and leaves no legacy key', async () => {
  const plugin = await setup({
    llm: llmFromText(JSON.stringify({
      answer: '好',
      findingOps: [{ op: 'update', index: 1, suggestion: '新修法' }],
    })),
  });
  try {
    // review_update_analysis 只写合并形状（issues[].suggestion）；随后的文件对话在同一个
    // 列表上按 1 起始的编号改写，写回仍不得出现 legacy suggestions 键。
    await plugin.runTool('review_update_analysis', {
      path: 'src/a.js',
      revision: 0,
      summary: '工具改写',
      issues: [{ point: '人写的问题', suggestion: '', line: 3, severity: 'block' }],
    });
    const chat = await plugin.call('/pr-review-api/chat', 'POST', { number: 1, message: '第二条补个修法', path: 'src/a.js' });
    assert.equal(chat.status, 200);
    assert.equal(chat.json.applied.length, 1);
    const review = await plugin.review();
    const entry = review.explanations.find((item) => item.file === 'src/a.js');
    assert.ok(!('suggestions' in entry.explanation));
    assert.deepEqual(entry.explanation.issues, [
      { severity: 'block', point: '人写的问题', suggestion: '新修法', line: 3 },
    ]);
  } finally {
    await plugin.dispose();
  }
});

test('a failed review is retried in the same round, never as a new round', async () => {
  // The poll sees the same head sha: retrying must not bump `round` or grow the history.
  const fetchWithSameHead = async (url) => {
    const target = String(url);
    if (target.includes('/pulls?state=open')) {
      return jsonResponse(200, [{
        number: 1,
        title: 'PR 标题',
        user: { login: 'dev' },
        head: { ref: 'feature', sha: 'abc123' },
        base: { ref: 'main', sha: 'def456' },
        additions: 1,
        deletions: 0,
        changed_files: 1,
        html_url: 'https://git.example/acme/demo/pulls/1',
      }]);
    }
    throw new Error(`unexpected fetch in retry test: ${target}`);
  };
  const plugin = await setup({
    reviews: { 1: legacyReview({ status: 'error', finishedAt: 1, error: '第一次审查失败' }) },
    fetch: fetchWithSameHead,
  });
  try {
    const review = await plugin.waitFor(1, (current) => current.status === 'error' && current.finishedAt > 1);
    assert.equal(review.round, 1, 'retry must stay in round 1');
    assert.equal(review.roundHistory.length, 1, 'retry must not append a round entry');
    assert.equal(review.roundHistory[0].conclusions.length, 1, 'the old conclusion version is kept');
  } finally {
    await plugin.dispose();
  }
});

test('/feedback reads implementer replies under the previous round without publishing this round', async () => {
  const previousConclusion = {
    verdict: 'block',
    summary: '上一轮结论',
    blockers: [{ file: 'src/a.js', point: '旧问题', id: 'b-abc123' }],
    suggestions: [],
    nextSteps: [],
  };
  const previousItems = [
    { index: 1, kind: 'blocker', file: 'src/a.js', point: '旧问题', id: 'b-abc123', key: 'b-abc123' },
  ];
  // Round 1 was published; round 2 is current and has NOT been published.
  const review = legacyReview({
    round: 2,
    conclusion: null,
    conclusionAt: 0,
    published: [{ id: 555, url: 'https://git.example/comment/555', round: 1, version: 1, publishedAt: 300, itemCount: 1 }],
    publishedItems: [],
    previousRound: { round: 1, headSha: 'abc123', conclusion: previousConclusion, items: previousItems },
    feedback: null,
    roundHistory: [
      {
        round: 1,
        headSha: 'abc123',
        startedAt: 100,
        finishedAt: 200,
        conclusions: [{ version: 1, createdAt: 500, source: 'model', conclusion: previousConclusion, coverage: null }],
        delta: null,
        feedback: null,
        publishedIds: [555],
      },
      { round: 2, headSha: 'abc123', startedAt: 600, finishedAt: 700, conclusions: [], delta: null, feedback: null, publishedIds: [] },
    ],
  });
  const comments = [
    { id: 555, user: { login: 'reviewer' }, created_at: '2026-01-01T00:00:00Z', body: '审查评论' },
    { id: 700, user: { login: 'dev' }, created_at: '2026-01-02T00:00:00Z', body: '**已修复** 第 1 条' },
  ];
  const plugin = await setup({
    reviews: { 1: review },
    fetch: async (url) => {
      const target = String(url);
      if (target.includes('/pulls?state=open')) return jsonResponse(200, []);
      if (target.includes('/issues/1/comments')) return jsonResponse(200, comments);
      throw new Error(`unexpected fetch in feedback test: ${target}`);
    },
    llm: llmFromText(JSON.stringify({
      items: [{ index: 1, status: 'fixed-claimed', reason: '已修复' }],
      notes: ['整体看过'],
    })),
  });
  try {
    const result = await plugin.call('/pr-review-api/feedback', 'POST', { number: 1 });
    assert.equal(result.status, 200);
    assert.equal(result.json.parsed, true);
    // Only the implementer's reply is kept, markdown intact for the client renderer.
    assert.equal(result.json.feedback.comments.length, 1);
    assert.equal(result.json.feedback.comments[0].body, '**已修复** 第 1 条');
    assert.equal(result.json.feedback.states['b-abc123'].status, 'fixed-claimed');

    const stored = await plugin.review();
    assert.equal(stored.round, 2);
    assert.equal(stored.published.length, 1, 'the current round stays unpublished');
    assert.equal(stored.feedback.states['b-abc123'].status, 'fixed-claimed');
  } finally {
    await plugin.dispose();
  }
});

test('/feedback reports no-previous-review before any comment is published', async () => {
  const plugin = await setup({
    reviews: { 1: legacyReview({ published: [], publishedItems: [], previousRound: null }) },
    fetch: async (url) => {
      const target = String(url);
      if (target.includes('/pulls?state=open')) return jsonResponse(200, []);
      throw new Error(`unexpected fetch in feedback test: ${target}`);
    },
  });
  try {
    const result = await plugin.call('/pr-review-api/feedback', 'POST', { number: 1 });
    assert.equal(result.status, 200);
    assert.equal(result.json.parsed, false);
    assert.equal(result.json.reason, 'no-previous-review');
  } finally {
    await plugin.dispose();
  }
});

test('registers the read-only review tools on the host registry', async () => {
  const plugin = await setup();
  try {
    for (const name of [
      'review_list_prs',
      'review_get',
      'review_get_report',
      'review_list_files',
      'review_get_analysis',
      'review_get_diff',
      'review_get_file',
      'review_list_rounds',
      'review_get_round',
      'review_get_comments',
      'review_update_analysis',
      'review_update_report',
      'review_update_conclusion',
      'review_run_agent',
      'review_publish',
      'review_get_links',
      'review_update_overview',
    ]) {
      assert.ok(plugin.tools.has(name), `tool ${name} is registered`);
    }
    for (const definition of plugin.tools.values()) {
      assert.equal(typeof definition.description, 'string');
      assert.equal(typeof definition.execute, 'function');
      assert.equal(typeof definition.output.render, 'function');
      assert.equal(definition.parameters.type, 'object');
    }
  } finally {
    await plugin.dispose();
  }
});

test('review_get and review_list_files read the loaded review', async () => {
  const plugin = await setup();
  try {
    const summary = await plugin.runTool('review_get');
    assert.match(summary, /PR #1/);
    assert.match(summary, /第 1 轮/);
    assert.match(summary, /已分析 1\/1/);
    assert.match(summary, /逐文件审查意见 1 条/);

    const files = await plugin.runTool('review_list_files');
    assert.match(files, /src\/a\.js/);
    assert.match(files, /已分析（1 条意见）/);
    assert.doesNotMatch(files, / \/ 建议/);

    const report = await plugin.runTool('review_get_report');
    assert.match(report, /初步报告/);
    assert.match(report, /风险一/);

    const analysis = await plugin.runTool('review_get_analysis', { path: 'src/a.js' });
    assert.match(analysis, /文件分析/);
    assert.match(analysis, /审查意见/);
  } finally {
    await plugin.dispose();
  }
});

test('review_get_analysis renders one findings section with inline suggestions', async () => {
  const plugin = await setup({
    reviews: {
      1: legacyReview({
        explanations: [{
          file: 'src/a.js',
          status: 'done',
          error: null,
          explanation: {
            verdict: 'suggest',
            summary: 's',
            issues: [
              { severity: 'block', point: '会崩', suggestion: '加判空', line: 3 },
              { severity: 'suggest', point: '补测试', suggestion: '', line: 0 },
            ],
          },
          chat: [],
          updatedAt: 150,
        }],
      }),
    },
  });
  try {
    const analysis = await plugin.runTool('review_get_analysis', { path: 'src/a.js' });
    assert.match(analysis, /审查意见：/);
    assert.match(analysis, /- \[block\] 会崩（行 3） —— 建议：加判空/);
    assert.match(analysis, /^- \[suggest\] 补测试$/m);
    assert.doesNotMatch(analysis, /改进建议：/);
  } finally {
    await plugin.dispose();
  }
});

test('/active binds a session to the PR the panel shows; tools default to it', async () => {
  const second = legacyReview({
    number: 2,
    headSha: 'def789',
    finishedAt: 300,
    pull: { ...legacyReview().pull, number: 2, title: '第二个 PR', headSha: 'def789', url: 'https://git.example/acme/demo/pulls/2' },
    files: [{ path: 'src/b.js', previousPath: '', status: 'modified', additions: 2, deletions: 0, changes: 2 }],
    explanations: [],
    conclusion: null,
    published: [],
    publishedItems: [],
    comment: null,
  });
  const plugin = await setup({ reviews: { 1: legacyReview(), 2: second } });
  try {
    const bound = await plugin.call('/pr-review-api/active', 'POST', { sessionId: 'session-a', number: 2 });
    assert.equal(bound.status, 200);
    assert.equal(bound.json.active, 2);

    const picked = await plugin.runTool('review_get');
    assert.match(picked, /PR #2/);

    const explicit = await plugin.runTool('review_get', { number: 1 });
    assert.match(explicit, /PR #1/);

    // Another session is not affected by that binding.
    const other = await plugin.runTool('review_get', {}, { session: { id: 'session-b' } });
    assert.match(other, /PR #2/, 'without a binding the newest review is used');
  } finally {
    await plugin.dispose();
  }
});

test('review_get_comments returns the platform comments oldest first', async () => {
  const plugin = await setup({
    fetch: async (url) => {
      const target = String(url);
      if (target.includes('/pulls?state=open')) return jsonResponse(200, []);
      if (target.includes('/issues/1/comments')) {
        return jsonResponse(200, [
          { id: 10, user: { login: 'dev' }, created_at: '2026-11-01T09:00:00Z', body: '第一条评论' },
          { id: 11, user: { login: 'reviewer' }, created_at: '2026-11-01T10:00:00Z', body: '**已修复**' },
        ]);
      }
      throw new Error(`unexpected fetch in comments test: ${target}`);
    },
  });
  try {
    const comments = await plugin.runTool('review_get_comments');
    assert.match(comments, /评论 2 条/);
    assert.ok(comments.indexOf('第一条评论') < comments.indexOf('已修复'), 'oldest comment comes first');
  } finally {
    await plugin.dispose();
  }
});

test('review_update_analysis writes with an optimistic lock and records audit', async () => {
  const plugin = await setup({
    reviews: {
      1: legacyReview({
        explanations: [{
          file: 'src/a.js',
          status: 'done',
          error: null,
          explanation: {
            verdict: 'suggest',
            summary: '文件分析',
            logic: '读取后逐段处理',
            issues: [{ severity: 'suggest', point: '注意', line: 1 }],
          },
          chat: [],
          updatedAt: 150,
        }],
      }),
    },
  });
  try {
    const summary = await plugin.runTool('review_get');
    assert.match(summary, /revision：0/);

    await assert.rejects(
      () => plugin.runTool('review_update_analysis', { path: 'src/a.js', revision: 7, summary: '过期写入' }),
      /revision/,
    );

    await assert.rejects(
      () => plugin.runTool('review_update_analysis', { path: 'src/missing.js', revision: 0, summary: 'x' }),
      /不在变更文件/,
    );

    const written = await plugin.runTool('review_update_analysis', {
      path: 'src/a.js',
      revision: 0,
      verdict: 'block',
      summary: '改写后的结论',
      issues: [{ point: '人写的问题', suggestion: '人写的修法', line: 3, severity: 'block' }],
    });
    assert.match(written, /已更新分析/);
    assert.match(written, /revision 1/);
    assert.match(written, /意见 1 条/);
    assert.doesNotMatch(written, / \/ 建议/);

    const stored = await plugin.review();
    assert.equal(stored.revision, 1);
    const explanation = stored.explanations[0].explanation;
    assert.equal(explanation.summary, '改写后的结论');
    assert.equal(explanation.logic, '读取后逐段处理', 'fields the call omits survive the rewrite');
    assert.deepEqual(explanation.issues, [
      { severity: 'block', point: '人写的问题', suggestion: '人写的修法', line: 3 },
    ]);
    assert.ok(!('suggestions' in explanation), 'no legacy suggestions key is written');
    assert.equal(stored.audit.length, 1);
    assert.equal(stored.audit[0].tool, 'review_update_analysis');
    assert.match(stored.audit[0].summary, /src\/a\.js/);

    // A stale revision is rejected after the write bumped the record.
    await assert.rejects(
      () => plugin.runTool('review_update_analysis', { path: 'src/a.js', revision: 0, summary: 'again' }),
      /revision 1/,
    );
  } finally {
    await plugin.dispose();
  }
});

test('review_update_report rewrites the report and marks the conclusion stale', async () => {
  const plugin = await setup({ reviews: { 1: legacyReview({ reportUpdatedAt: 0, conclusionAt: 500 }) } });
  try {
    const written = await plugin.runTool('review_update_report', {
      revision: 0,
      verdict: 'suggest',
      summary: '人写的总体摘要',
      risks: [{ severity: 'suggest', file: 'src/a.js', point: '人写的风险' }],
      order: [{ file: 'src/a.js', reason: '先看这里' }],
    });
    assert.match(written, /已更新总体报告/);

    const stored = await plugin.review();
    assert.equal(stored.revision, 1);
    assert.equal(stored.report.summary, '人写的总体摘要');
    assert.equal(stored.report.risks[0].point, '人写的风险');
    assert.equal(stored.report.order[0].reason, '先看这里');
    assert.ok(stored.reportUpdatedAt > 0, 'the report timestamp feeds staleness');

    const summary = await plugin.runTool('review_get');
    assert.match(summary, /revision：1/);
    assert.match(summary, /结论之后有新的报告/);
  } finally {
    await plugin.dispose();
  }
});

test('/active binds the panel focus to the runtime-context snapshot', async () => {
  const plugin = await setup();
  try {
    const result = await plugin.call('/pr-review-api/active', 'POST', {
      sessionId: 'session-a',
      number: 1,
      view: 'file',
      path: 'src/a.js',
      pane: 'analysis',
      round: 1,
    });
    assert.equal(result.status, 200);
    assert.equal(result.json.active, 1);

    const text = plugin.promptContext('session-a');
    assert.match(text, /<review-context>/);
    assert.match(text, /PR #1/);
    assert.match(text, /第 1 轮/);
    assert.match(text, /当前查看：文件 src\/a\.js/);
    assert.match(text, /revision：0/);

    // Another session has no binding, so it contributes nothing.
    assert.equal(plugin.promptContext('session-b'), '');

    // A binding whose review record is not loaded (yet) has nothing to describe.
    await plugin.call('/pr-review-api/active', 'POST', { sessionId: 'session-c', number: 42 });
    assert.equal(plugin.promptContext('session-c'), '');

    // Clearing the binding removes the snapshot.
    await plugin.call('/pr-review-api/active', 'POST', { sessionId: 'session-a' });
    assert.equal(plugin.promptContext('session-a'), '');
  } finally {
    await plugin.dispose();
  }
});

test('/focus makes the snapshot follow the panel', async () => {
  const plugin = await setup();
  try {
    // A focus report is itself a binding: it must work even if the panel's /active report was
    // released by a late cleanup request.
    await plugin.call('/pr-review-api/focus', 'POST', {
      sessionId: 'session-a',
      number: 1,
      view: 'overview',
    });
    assert.match(plugin.promptContext('session-a'), /当前查看：总览/);

    // Same focus again: the snapshot text is unchanged, so the host sees no new section.
    const same = await plugin.call('/pr-review-api/focus', 'POST', {
      sessionId: 'session-a',
      number: 1,
      view: 'overview',
    });
    assert.equal(same.json.active, 1);
    assert.match(plugin.promptContext('session-a'), /当前查看：总览/);
    // The host dedupes by comparing the contributed text, so an unchanged panel has to render
    // byte-identical text — otherwise every step would re-emit a snapshot.
    assert.equal(plugin.promptContext('session-a'), plugin.promptContext('session-a'));

    // Switching to a file changes the snapshot, so the agent learns what "this file" means.
    await plugin.call('/pr-review-api/focus', 'POST', {
      sessionId: 'session-a',
      number: 1,
      view: 'file',
      path: 'src/a.js',
      pane: 'diff',
    });
    assert.match(plugin.promptContext('session-a'), /当前查看：文件 src\/a\.js/);
    assert.match(plugin.promptContext('session-a'), /已分析（1 条意见）/);
    assert.doesNotMatch(plugin.promptContext('session-a'), / \/ 建议/);
  } finally {
    await plugin.dispose();
  }
});

test('a rejected runtime-context registration leaves the plugin usable', async () => {
  const plugin = await setup({ promptContextThrows: true });
  try {
    assert.equal(plugin.promptContexts.length, 0);
    // The panel and its tools keep working without a snapshot: the routes and data are the
    // contract, the context contribution is an enhancement.
    const bound = await plugin.call('/pr-review-api/active', 'POST', {
      sessionId: 'session-a',
      number: 1,
      view: 'overview',
    });
    assert.equal(bound.status, 200);
    const loaded = await plugin.call('/pr-review-api/review?number=1');
    assert.equal(loaded.status, 200);
    assert.notEqual(loaded.json.review, null);
  } finally {
    await plugin.dispose();
  }
});

test('the review-data system prompt section comes from prompts/review-data.md', async () => {
  const plugin = await setup();
  try {
    const section = plugin.promptSections.find((entry) => entry.name === 'pr-review: review-data');
    assert.ok(section !== undefined, 'review-data section is registered');
    assert.equal(section.text, loadPrompt('review-data'));
    assert.match(section.text, /review_update_overview/);
  } finally {
    await plugin.dispose();
  }
});

test('review_update_analysis writes with an optimistic lock and records audit', async () => {
  const plugin = await setup({
    reviews: {
      1: legacyReview({
        explanations: [{
          file: 'src/a.js',
          status: 'done',
          error: null,
          explanation: {
            verdict: 'suggest',
            summary: '文件分析',
            logic: '读取后逐段处理',
            issues: [{ severity: 'suggest', point: '注意', line: 1 }],
          },
          chat: [],
          updatedAt: 150,
        }],
      }),
    },
  });
  try {
    const summary = await plugin.runTool('review_get');
    assert.match(summary, /revision：0/);

    await assert.rejects(
      () => plugin.runTool('review_update_analysis', { path: 'src/a.js', revision: 7, summary: '过期写入' }),
      /revision/,
    );

    await assert.rejects(
      () => plugin.runTool('review_update_analysis', { path: 'src/missing.js', revision: 0, summary: 'x' }),
      /不在变更文件/,
    );

    const written = await plugin.runTool('review_update_analysis', {
      path: 'src/a.js',
      revision: 0,
      verdict: 'block',
      summary: '改写后的结论',
      issues: [{ point: '人写的问题', suggestion: '人写的修法', line: 3, severity: 'block' }],
    });
    assert.match(written, /已更新分析/);
    assert.match(written, /revision 1/);
    assert.match(written, /意见 1 条/);
    assert.doesNotMatch(written, / \/ 建议/);

    const stored = await plugin.review();
    assert.equal(stored.revision, 1);
    const explanation = stored.explanations[0].explanation;
    assert.equal(explanation.summary, '改写后的结论');
    assert.equal(explanation.logic, '读取后逐段处理', 'fields the call omits survive the rewrite');
    assert.deepEqual(explanation.issues, [
      { severity: 'block', point: '人写的问题', suggestion: '人写的修法', line: 3 },
    ]);
    assert.ok(!('suggestions' in explanation), 'no legacy suggestions key is written');
    assert.equal(stored.audit.length, 1);
    assert.equal(stored.audit[0].tool, 'review_update_analysis');
    assert.match(stored.audit[0].summary, /src\/a\.js/);

    // A stale revision is rejected after the write bumped the record.
    await assert.rejects(
      () => plugin.runTool('review_update_analysis', { path: 'src/a.js', revision: 0, summary: 'again' }),
      /revision 1/,
    );
  } finally {
    await plugin.dispose();
  }
});

test('review_update_report rewrites the report and marks the conclusion stale', async () => {
  const plugin = await setup({ reviews: { 1: legacyReview({ reportUpdatedAt: 0, conclusionAt: 500 }) } });
  try {
    const written = await plugin.runTool('review_update_report', {
      revision: 0,
      verdict: 'suggest',
      summary: '人写的总体摘要',
      risks: [{ severity: 'suggest', file: 'src/a.js', point: '人写的风险' }],
      order: [{ file: 'src/a.js', reason: '先看这里' }],
    });
    assert.match(written, /已更新总体报告/);

    const stored = await plugin.review();
    assert.equal(stored.revision, 1);
    assert.equal(stored.report.summary, '人写的总体摘要');
    assert.equal(stored.report.risks[0].point, '人写的风险');
    assert.equal(stored.report.order[0].reason, '先看这里');
    assert.ok(stored.reportUpdatedAt > 0, 'the report timestamp feeds staleness');

    const summary = await plugin.runTool('review_get');
    assert.match(summary, /revision：1/);
    assert.match(summary, /结论之后有新的报告/);
  } finally {
    await plugin.dispose();
  }
});

test('review_update_analysis normalizes the written explanation and drops the legacy suggestions argument', async () => {
  const plugin = await setup();
  try {
    // `suggestions` 参数已从 schema 移除：宿主不读它，旧调用方式的内容不会被当成独立
    // 建议保留——修法必须通过 issues[].suggestion 表达。写入统一经 normalizeExplanation
    // 归一为四键 issues，且不再产出 legacy suggestions 键。
    const written = await plugin.runTool('review_update_analysis', {
      path: 'src/a.js',
      revision: 0,
      verdict: 'block',
      summary: '旧参数改写',
      issues: [{ point: '阻塞意见', suggestion: '修法', line: 1, severity: 'block' }],
      suggestions: [{ point: '旧参数建议', line: 7 }],
    });
    assert.match(written, /意见 1 条/);
    assert.doesNotMatch(written, / \/ 建议/);

    const stored = await plugin.review();
    const explanation = stored.explanations[0].explanation;
    assert.deepEqual(explanation.issues, [
      { severity: 'block', point: '阻塞意见', suggestion: '修法', line: 1 },
    ]);
    assert.ok(!('suggestions' in explanation));
    assert.ok(!JSON.stringify(explanation).includes('旧参数建议'), 'the dropped argument must not survive anywhere');
  } finally {
    await plugin.dispose();
  }
});

test('review_update_analysis writes the per-segment walkthrough and keeps it across partial edits', async () => {
  const plugin = await setup();
  try {
    const walkthrough = [
      { title: 'loadConfig：读取配置', detail: '读取环境变量并合并默认值。', hunk: 1, context: { label: 'loadConfig', startLine: 10, endLine: 24 } },
      { title: 'applyPatch：应用覆盖', detail: '把覆盖项写回配置。', hunk: 2, context: null },
    ];
    const written = await plugin.runTool('review_update_analysis', {
      path: 'src/a.js',
      revision: 0,
      verdict: 'suggest',
      summary: '逐段分析写回',
      walkthrough,
    });
    assert.match(written, /逐段分析 2 段/);

    const stored = await plugin.review();
    assert.deepEqual(stored.explanations[0].explanation.walkthrough, walkthrough);

    // 只改 summary 的写回不能丢掉已有段落：walkthrough 未传即保留。
    const partial = await plugin.runTool('review_update_analysis', {
      path: 'src/a.js',
      revision: stored.revision,
      summary: '只改摘要',
    });
    assert.match(partial, /逐段分析 2 段/);
    const kept = await plugin.review();
    assert.deepEqual(kept.explanations[0].explanation.walkthrough, walkthrough);

    // 显式传空数组才是清空。
    await plugin.runTool('review_update_analysis', {
      path: 'src/a.js',
      revision: kept.revision,
      walkthrough: [],
    });
    const cleared = await plugin.review();
    assert.deepEqual(cleared.explanations[0].explanation.walkthrough, []);
  } finally {
    await plugin.dispose();
  }
});

test('review_get_analysis surfaces the walkthrough to the conversation', async () => {
  const plugin = await setup();
  try {
    await plugin.runTool('review_update_analysis', {
      path: 'src/a.js',
      revision: 0,
      walkthrough: [{ title: 'loadConfig：读取配置', detail: '读取环境变量并合并默认值。', hunk: 1 }],
    });
    const text = await plugin.runTool('review_get_analysis', { path: 'src/a.js' });
    assert.match(text, /逐段分析：/);
    assert.match(text, /loadConfig：读取配置（hunk 1）：读取环境变量并合并默认值。/);
  } finally {
    await plugin.dispose();
  }
});

test('review_update_conclusion rewrites the current conclusion (the next publish body)', async () => {
  const plugin = await setup();
  try {
    const written = await plugin.runTool('review_update_conclusion', {
      revision: 0,
      verdict: 'suggest',
      summary: '人工调整后的摘要',
      blockers: [],
      suggestions: [{ point: '只保留这一条建议', file: 'src/a.js', line: 2 }],
      nextSteps: ['合并前确认边界'],
    });
    assert.match(written, /已更新当前轮结论/);
    assert.match(written, /修改建议 1 条/);

    const stored = await plugin.review();
    assert.equal(stored.revision, 1);
    assert.equal(stored.conclusion.verdict, 'suggest');
    assert.equal(stored.conclusion.summary, '人工调整后的摘要');
    assert.equal(stored.conclusion.blockers.length, 0);
    assert.equal(stored.conclusion.suggestions.length, 1);
    assert.equal(stored.conclusion.suggestions[0].point, '只保留这一条建议');
    assert.ok(typeof stored.conclusion.suggestions[0].id === 'string');
    assert.deepEqual(stored.conclusion.nextSteps, ['合并前确认边界']);
    assert.ok(stored.conclusionEditedAt > 0);
    assert.ok(stored.humanItemIds.includes(stored.conclusion.suggestions[0].id));

    const round = stored.roundHistory[stored.roundHistory.length - 1];
    assert.equal(round.conclusions.length, 2, 'a human version is appended to the round history');
    assert.equal(round.conclusions[1].source, 'human');
    assert.equal(stored.audit[0].tool, 'review_update_conclusion');

    await assert.rejects(
      () => plugin.runTool('review_update_conclusion', { revision: 0, summary: 'again' }),
      /revision 1/,
    );
  } finally {
    await plugin.dispose();
  }
});

test('review_update_conclusion creates the first conclusion for a round without one', async () => {
  const plugin = await setup({
    reviews: { 1: legacyReview({ conclusion: null, conclusionAt: 0 }) },
  });
  try {
    const text = await plugin.runTool('review_update_conclusion', { revision: 0, summary: 'x' });
    assert.match(text, /已写入当前轮结论/);
    const review = await plugin.review();
    assert.equal(review.conclusion.summary, 'x');
  } finally {
    await plugin.dispose();
  }
});

test('review_update_report creates the first report for a round without one', async () => {
  const plugin = await setup({
    reviews: { 1: legacyReview({ report: null }) },
  });
  try {
    const text = await plugin.runTool('review_update_report', { revision: 0, summary: '新报告', risks: [] });
    assert.match(text, /已写入总体报告/);
    const review = await plugin.review();
    assert.equal(review.report.summary, '新报告');
  } finally {
    await plugin.dispose();
  }
});

test('a restored incomplete agent run stays visible through review_get', async () => {
  const plugin = await setup({
    reviews: {
      1: legacyReview({
        run: {
          status: 'incomplete',
          agentSessionId: 'agent-1',
          startedAt: 1,
          finishedAt: 2,
          missingFiles: ['src/a.js'],
          missingSections: ['最终结论（review_update_conclusion）'],
          error: '审查未完成：1 个文件、1 个收口项缺失',
        },
      }),
    },
  });
  try {
    const review = await plugin.review();
    assert.equal(review.run.status, 'incomplete');
    assert.deepEqual(review.run.missingFiles, ['src/a.js']);
    assert.deepEqual(review.run.missingSections, ['最终结论（review_update_conclusion）']);
  } finally {
    await plugin.dispose();
  }
});

test('a run left running by a restart is restored as an interruption', async () => {
  const plugin = await setup({
    reviews: { 1: legacyReview({ run: { status: 'running', agentSessionId: 'agent-1', startedAt: 1 } }) },
  });
  try {
    const review = await plugin.review();
    assert.equal(review.run.status, 'error');
    assert.match(review.run.error, /应用重启/);
  } finally {
    await plugin.dispose();
  }
});

test('review_get_links returns the PR and latest comment links', async () => {
  const plugin = await setup();
  try {
    const text = await plugin.runTool('review_get_links');
    assert.match(text, /PR #1/);
    assert.match(text, /https:\/\/git\.example\/acme\/demo\/pulls\/1/);
    assert.match(text, /https:\/\/git\.example\/comment\/555/);
  } finally {
    await plugin.dispose();
  }
});

test('review_publish posts the current conclusion as a PR comment', async () => {
  const plugin = await setup({
    fetch: async (url, init) => {
      const target = String(url);
      if (target.includes('/pulls?state=open')) return jsonResponse(200, []);
      if (target.includes('/issues/1/comments') && init?.method === 'POST') {
        return jsonResponse(201, { id: 901, html_url: 'https://git.example/comment/901' });
      }
      throw new Error(`unexpected fetch in publish tool test: ${target}`);
    },
  });
  try {
    const text = await plugin.runTool('review_publish');
    assert.match(text, /已发布审查评论/);
    assert.match(text, /https:\/\/git\.example\/comment\/901/);

    const stored = await plugin.review();
    assert.ok(stored.published.some((entry) => entry.id === 901));
    assert.equal(stored.comment.id, 901);

    // The same round/version cannot be published twice without force.
    await assert.rejects(() => plugin.runTool('review_publish'), /已经发布过/);
    const forced = await plugin.runTool('review_publish', { force: true });
    assert.match(forced, /已发布审查评论/);
  } finally {
    await plugin.dispose();
  }
});


test('review_publish honours includeIds for a partial comment', async () => {
  const captured = [];
  const plugin = await setup({
    reviews: {
      1: legacyReview({
        conclusion: {
          verdict: 'suggest',
          summary: '部分发布测试',
          blockers: [],
          suggestions: [
            { point: '保留的建议', file: 'src/a.js', line: 1 },
            { point: '不要发的建议', file: 'src/a.js', line: 2 },
          ],
          nextSteps: ['旧下一步'],
        },
        published: [],
        publishedItems: [],
        comment: null,
      }),
    },
    fetch: async (url, init) => {
      const target = String(url);
      if (target.includes('/pulls?state=open')) return jsonResponse(200, []);
      if (target.includes('/issues/1/comments') && init?.method === 'POST') {
        captured.push(JSON.parse(String(init.body)));
        return jsonResponse(201, { id: 902, html_url: 'https://git.example/comment/902' });
      }
      throw new Error(`unexpected fetch in partial publish test: ${target}`);
    },
  });
  try {
    const stored = await plugin.review();
    const [keep] = stored.conclusion.suggestions;
    assert.ok(typeof keep.id === 'string' && keep.id !== '');

    const roundText = await plugin.runTool('review_get_round', { round: 1 });
    assert.match(roundText, new RegExp(`\\[${keep.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`));

    const written = await plugin.runTool('review_publish', { includeIds: [keep.id] });
    assert.match(written, /已发布审查评论/);
    assert.match(written, /本次仅纳入 1 条勾选条目/);
    assert.equal(captured.length, 1);
    assert.match(captured[0].body, /保留的建议/);
    assert.doesNotMatch(captured[0].body, /不要发的建议/);
    assert.match(captured[0].body, /旧下一步/);

    // Selecting nothing is rejected instead of publishing an empty review.
    await assert.rejects(
      () => plugin.runTool('review_publish', { includeIds: ['missing-id'], force: true }),
      /至少选择一条/,
    );
  } finally {
    await plugin.dispose();
  }
});

function overviewFixture() {
  return legacyReview({
    report: {
      verdict: 'suggest',
      summary: '初筛报告',
      risks: [
        { severity: 'suggest', file: 'src/a.js', point: '建议级风险' },
        { severity: 'block', file: 'src/a.js', point: '阻塞级风险' },
      ],
      order: [{ file: 'src/a.js', reason: '' }],
      focus: {},
    },
    explanations: [{
      file: 'src/a.js',
      status: 'done',
      error: null,
      explanation: {
        verdict: 'suggest',
        summary: '文件分析',
        issues: [
          { severity: 'suggest', point: '建议级意见' },
          { severity: 'block', point: '阻塞级意见' },
        ],
        suggestions: [{ point: '文件建议' }],
      },
      chat: [],
      updatedAt: 150,
    }],
    conclusion: {
      verdict: 'suggest',
      summary: '旧结论',
      blockers: [],
      suggestions: [{ file: 'src/a.js', point: '结论建议' }],
      nextSteps: ['旧下一步'],
    },
  });
}

test('review_update_overview rewrites the whole overview in one call and clears stale', async () => {
  const plugin = await setup({ reviews: { 1: overviewFixture() } });
  try {
    const written = await plugin.runTool('review_update_overview', {
      revision: 0,
      verdict: 'pass',
      summary: '整体通过',
      blockers: [],
      suggestions: [],
      nextSteps: [],
      clearFindings: 'all',
    });
    assert.match(written, /已更新总览/);
    assert.match(written, /初筛风险 0 条/);
    assert.match(written, /逐文件审查意见 0 条/);
    assert.match(written, /已清理/);
    // 结论层的「修改建议 N 条」保留；逐文件层不再出现「/ 建议 N 条」计数。
    assert.match(written, /修改建议 0 条/);
    assert.doesNotMatch(written, / \/ 建议 \d+ 条/);

    // Schema 收敛后弃用的 `suggestions` scope 不再由工具层承诺。
    assert.deepEqual(
      plugin.tools.get('review_update_overview').parameters.properties.clearFindings.enum,
      ['none', 'suggest', 'all'],
    );

    const stored = await plugin.review();
    assert.equal(stored.revision, 1);
    assert.equal(stored.report.verdict, 'pass');
    assert.equal(stored.report.summary, '整体通过');
    assert.equal(stored.report.risks.length, 0);
    assert.equal(stored.conclusion.verdict, 'pass');
    assert.equal(stored.conclusion.suggestions.length, 0);
    assert.equal(stored.conclusion.nextSteps.length, 0);
    assert.equal(stored.explanations[0].explanation.issues.length, 0);
    assert.equal(stored.explanations[0].explanation.suggestions, undefined);
    const round = stored.roundHistory[stored.roundHistory.length - 1];
    assert.equal(round.conclusions[round.conclusions.length - 1].source, 'human');
    assert.equal(stored.audit[0].tool, 'review_update_overview');

    // The fresh human conclusion clears the stale marker.
    const summary = await plugin.runTool('review_get');
    assert.match(summary, /初筛风险 0/);
    assert.doesNotMatch(summary, /结论之后有新的/);

    // The next comment carries no suggestion or risk sections any more.
    const preview = await plugin.call('/pr-review-api/comment/preview', 'POST', { number: 1 });
    assert.equal(preview.status, 200);
    assert.doesNotMatch(preview.json.markdown, /\[建议\]/);
    assert.doesNotMatch(preview.json.markdown, /#### .*初筛风险/);
    assert.doesNotMatch(preview.json.markdown, /#### .*逐文件审查发现/);
  } finally {
    await plugin.dispose();
  }
});

test('review_update_overview clearFindings keeps block items for narrower scopes', async () => {
  // Merged-shape fixture: one block finding and one suggest finding, each carrying its own
  // suggestion, plus one block and one suggest initial risk.
  const mergedFixture = () => legacyReview({
    report: {
      verdict: 'suggest',
      summary: '初筛报告',
      risks: [
        { severity: 'block', file: 'src/a.js', point: '阻塞级风险' },
        { severity: 'suggest', file: 'src/a.js', point: '建议级风险' },
      ],
      order: [{ file: 'src/a.js', reason: '' }],
      focus: {},
    },
    explanations: [{
      file: 'src/a.js',
      status: 'done',
      error: null,
      explanation: {
        verdict: 'suggest',
        summary: '文件分析',
        issues: [
          { severity: 'block', point: '阻塞', suggestion: '', line: 1 },
          { severity: 'suggest', point: '改进', suggestion: '修法', line: 2 },
        ],
      },
      chat: [],
      updatedAt: 150,
    }],
    conclusion: {
      verdict: 'suggest',
      summary: '旧结论',
      blockers: [],
      suggestions: [],
      nextSteps: ['旧下一步'],
    },
  });

  const clearWith = async (scope) => {
    const plugin = await setup({ reviews: { 1: mergedFixture() } });
    try {
      await plugin.runTool('review_update_overview', { revision: 0, clearFindings: scope });
      const stored = await plugin.review();
      return {
        issues: stored.explanations[0].explanation.issues,
        risks: stored.report.risks.map((item) => item.severity),
      };
    } finally {
      await plugin.dispose();
    }
  };

  // `suggest` clears suggest-severity findings and risks; block items on both layers survive.
  const suggestCleared = await clearWith('suggest');
  assert.deepEqual(suggestCleared.issues, [{ severity: 'block', point: '阻塞', suggestion: '', line: 1 }]);
  assert.deepEqual(suggestCleared.risks, ['block']);

  // `all` clears every finding and every initial risk.
  const allCleared = await clearWith('all');
  assert.deepEqual(allCleared.issues, []);
  assert.deepEqual(allCleared.risks, []);

  // The tool schema narrowed with the merge: the deprecated `suggestions` scope is no longer
  // promised at the tool layer (callers pass `suggest`, asserted against the enum above in
  // the overview-rewrite test). The harness executes tools without schema validation though,
  // so this call still reaches the function-level alias shim — pinned here: the alias must
  // keep behaving exactly like `suggest` (clear suggest findings/risks, keep block).
  const aliasCleared = await clearWith('suggestions');
  assert.deepEqual(aliasCleared.issues, [{ severity: 'block', point: '阻塞', suggestion: '', line: 1 }]);
  assert.deepEqual(aliasCleared.risks, ['block']);

  // `none` and unknown scopes clear nothing (defense against typo'd callers).
  for (const scope of ['none', 'whatever']) {
    const untouched = await clearWith(scope);
    assert.deepEqual(untouched.issues, [
      { severity: 'block', point: '阻塞', suggestion: '', line: 1 },
      { severity: 'suggest', point: '改进', suggestion: '修法', line: 2 },
    ]);
    assert.deepEqual(untouched.risks, ['block', 'suggest']);
  }
});

test('clearFindings clears tool-written findings and the legacy suggestions argument stays dropped', async () => {
  const plugin = await setup();
  try {
    // Task 6 起 review_update_analysis 只写合并形状：旧 `suggestions` 参数被整体忽略，
    // 「模型后来补的建议」不会进列表，也不会有 legacy 键落库。
    await plugin.runTool('review_update_analysis', {
      path: 'src/a.js',
      revision: 0,
      verdict: 'block',
      summary: '人工改写',
      issues: [{ point: '阻塞意见', suggestion: '修法', line: 1, severity: 'block' }],
      suggestions: [{ point: '模型后来补的建议', line: 2 }],
    });

    // 清空必须清得干净且计数如实：只有 1 条意见可清（旧参数建议从未进列表）。
    const written = await plugin.runTool('review_update_overview', { revision: 1, clearFindings: 'all' });
    assert.match(written, /已清理：意见 1 条、风险 1 条/);

    const stored = await plugin.review();
    const explanation = stored.explanations[0].explanation;
    assert.deepEqual(explanation.issues, []);
    assert.equal(explanation.suggestions, undefined);
    const analysis = await plugin.runTool('review_get_analysis', { path: 'src/a.js' });
    assert.doesNotMatch(analysis, /模型后来补的建议/);
    assert.doesNotMatch(analysis, /审查意见：/);
  } finally {
    await plugin.dispose();
  }
});

// ---------- cache durability, list truncation, pruning, explain dedupe ----------

test('an unreadable cache is archived aside and surfaced rather than silently overwritten', async () => {
  const plugin = await setup({ cacheText: '{"reviews": {', skipLoadedCheck: true });
  try {
    let prs = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      prs = await plugin.call('/pr-review-api/prs');
      if (String(prs.json.cacheError) !== '') break;
      await delay(10);
    }
    assert.equal(prs.status, 200);
    assert.match(String(prs.json.cacheError), /另存为/);
    const dir = path.join(plugin.home, '.dsh', 'pr-review');
    const files = await readdir(dir);
    assert.equal(files.some((name) => name.includes('.corrupt-')), true, 'corrupt cache kept for recovery');
    assert.equal(files.includes(CACHE_SLUG), false, 'the unreadable file is moved, not left to be overwritten');
  } finally {
    await plugin.dispose();
  }
});

test('cache saves go through a temp file and leave no stray files behind', async () => {
  const plugin = await setup();
  try {
    const before = await plugin.review();
    await plugin.runTool('review_update_report', {
      revision: before.revision,
      verdict: 'pass',
      summary: '缓存写入测试',
    });
    await delay(950); // scheduleSave debounce
    const dir = path.join(plugin.home, '.dsh', 'pr-review');
    const files = await readdir(dir);
    assert.deepEqual(files, [CACHE_SLUG], 'only the cache file remains (temp file was renamed away)');
    const payload = JSON.parse(await readFile(path.join(dir, CACHE_SLUG), 'utf8'));
    assert.ok(payload.reviews['1'], 'cache parses and still carries the review');
  } finally {
    await plugin.dispose();
  }
});

test('the pull list flags when older open pull requests were cut off', async () => {
  const pulls = Array.from({ length: 21 }, (_, index) => ({
    number: index + 2,
    title: `PR ${index + 2}`,
    user: { login: 'dev' },
    head: { ref: 'feature', sha: '' },
    base: { ref: 'main' },
    updated_at: '',
    created_at: '',
    additions: 0,
    deletions: 0,
    changed_files: 0,
    html_url: '',
  }));
  const fetchHandler = async (url) => {
    const target = String(url);
    if (target.includes('/pulls?state=open')) return jsonResponse(200, pulls);
    throw new Error(`unexpected fetch in test: ${target}`);
  };
  const plugin = await setup({ fetch: fetchHandler });
  try {
    let list = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      list = (await plugin.call('/pr-review-api/prs')).json;
      if (list.lastPollAt > 0) break;
      await delay(10);
    }
    assert.equal(list.prs.length, 20, 'the list is capped at the newest 20');
    assert.equal(list.prs[0].number, 2);
    assert.equal(list.truncatedList, true, 'the cut-off is flagged for the panel');
  } finally {
    await plugin.dispose();
  }
});

test('the cache prunes the oldest unpublished reviews and keeps published history', async () => {
  const reviews = {};
  for (let number = 2; number <= 52; number += 1) {
    reviews[number] = legacyReview({
      number,
      headSha: `h${number}`,
      finishedAt: number * 10,
      published: [],
      publishedItems: [],
      comment: null,
    });
  }
  // Oldest record of all, but published: must survive the prune.
  reviews[100] = legacyReview({
    number: 100,
    headSha: 'h100',
    finishedAt: 1,
    published: [{ id: 900, url: 'https://git.example/comment/900', round: 1, publishedAt: 1, itemCount: 1 }],
  });
  const plugin = await setup({ reviews, skipLoadedCheck: true });
  try {
    let list = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      list = (await plugin.call('/pr-review-api/prs')).json;
      if (list.lastPollAt > 0) break;
      await delay(10);
    }
    const kept = Object.keys(list.reviews).map(Number);
    assert.equal(kept.length, 50, 'the cache is capped at 50 records');
    assert.equal(kept.includes(2), false, 'oldest unpublished record was pruned');
    assert.equal(kept.includes(3), false);
    assert.equal(kept.includes(52), true, 'newest record survives');
    assert.equal(kept.includes(100), true, 'published history is never pruned');
  } finally {
    await plugin.dispose();
  }
});


// ---------- batch file analysis ----------

/** A finished review with two files and no per-file analyses yet. */
function unanalyzedReview() {
  return legacyReview({
    files: [
      { path: 'src/a.js', previousPath: '', status: 'modified', additions: 1, deletions: 0, changes: 1 },
      { path: 'src/b.js', previousPath: '', status: 'modified', additions: 1, deletions: 1, changes: 2 },
    ],
    explanations: [],
    report: {
      verdict: 'suggest',
      summary: '报告',
      risks: [],
      order: [{ file: 'src/a.js', reason: '' }, { file: 'src/b.js', reason: '' }],
      focus: {},
    },
    conclusion: null,
    conclusionAt: 0,
    comment: null,
    published: [],
    publishedItems: [],
  });
}

const BATCH_DIFF = [
  'diff --git a/src/a.js b/src/a.js',
  '--- a/src/a.js',
  '+++ b/src/a.js',
  '@@ -1 +1 @@',
  '-a',
  '+b',
  'diff --git a/src/b.js b/src/b.js',
  '--- a/src/b.js',
  '+++ b/src/b.js',
  '@@ -1 +1 @@',
  '-c',
  '+d',
].join('\n');

/** Fetch fake for the batch tests: diff plus file contents for both files. */
async function batchFetch(url) {
  const target = String(url);
  if (target.includes('/pulls?state=open')) return jsonResponse(200, []);
  if (target.includes('/pulls/1.diff')) return textResponse(200, BATCH_DIFF);
  // b's content is unavailable on purpose: the analysis must fall back to the diff.
  if (target.includes('/contents/src/b.js')) return jsonResponse(404, { message: 'not found' });
  if (target.includes('/contents/')) {
    return jsonResponse(200, {
      encoding: 'base64',
      content: Buffer.from('const a = 1;\n', 'utf8').toString('base64'),
      size: 13,
    });
  }
  throw new Error(`unexpected fetch in test: ${target}`);
}

const BATCH_EXPLANATION = JSON.stringify({
  verdict: 'suggest',
  summary: '讲解',
  logic: '逻辑',
  changes: '改动',
  issues: [],
  suggestions: [],
});

/** Fetch fake for tests that force a new round: detail, files, diff and file contents. */
async function roundReviewFetch(url) {
  const target = String(url);
  if (target.includes('/pulls?state=open')) return jsonResponse(200, []);
  if (target.endsWith('/pulls/1.diff')) return textResponse(200, BATCH_DIFF);
  if (target.includes('/pulls/1/files')) {
    return jsonResponse(200, [
      { filename: 'src/a.js', status: 'modified', additions: 1, deletions: 0, changes: 1 },
      { filename: 'src/b.js', status: 'modified', additions: 1, deletions: 1, changes: 2 },
    ]);
  }
  if (target.includes('/contents/')) {
    return jsonResponse(200, {
      encoding: 'base64',
      content: Buffer.from('const value = 1;\n', 'utf8').toString('base64'),
      size: 17,
    });
  }
  if (/\/pulls\/1$/.test(target)) {
    return jsonResponse(200, {
      number: 1,
      title: 'PR 标题',
      body: '',
      user: { login: 'dev' },
      state: 'open',
      merged: false,
      additions: 2,
      deletions: 1,
      changed_files: 2,
      head: { ref: 'feature', sha: 'newsha' },
      base: { ref: 'main', sha: 'def456' },
      html_url: 'https://git.example/acme/demo/pulls/1',
    });
  }
  throw new Error(`unexpected fetch in test: ${target}`);
}

/** Fetch fake for several pull requests at once (analysis slot tests). */
async function multiPrFetch(url) {
  const target = String(url);
  if (target.includes('/pulls?state=open')) return jsonResponse(200, []);
  if (target.includes('/contents/')) {
    return jsonResponse(200, {
      encoding: 'base64',
      content: Buffer.from('const value = 1;\n', 'utf8').toString('base64'),
      size: 17,
    });
  }
  if (target.includes('.diff')) return textResponse(200, BATCH_DIFF);
  if (/\/pulls\/\d+\/files(?:\?.*)?$/.test(target)) {
    return jsonResponse(200, [
      { filename: 'src/a.js', status: 'modified', additions: 1, deletions: 0, changes: 1 },
      { filename: 'src/b.js', status: 'modified', additions: 1, deletions: 1, changes: 2 },
    ]);
  }
  const detail = /\/pulls\/(\d+)(?:\?.*)?$/.exec(target);
  if (detail !== null) {
    const number = Number(detail[1]);
    return jsonResponse(200, {
      number,
      title: `PR ${number}`,
      body: '',
      user: { login: 'dev' },
      state: 'open',
      merged: false,
      additions: 2,
      deletions: 1,
      changed_files: 2,
      head: { ref: 'feature', sha: `sha${number}` },
      base: { ref: 'main', sha: 'def456' },
      html_url: `https://git.example/acme/demo/pulls/${number}`,
    });
  }
  throw new Error(`unexpected fetch in test: ${target}`);
}

/** A finished, unanalyzed review record for one pull request number. */
function unanalyzedPr(number) {
  const review = unanalyzedReview();
  return {
    ...review,
    number,
    pull: { ...review.pull, number, title: `PR ${number}`, url: `https://git.example/acme/demo/pulls/${number}` },
  };
}












test('restored legacy cache folds suggestions into suggest findings', async () => {
  const restored = legacyReview({
    files: [{ path: 'src/a.js', previousPath: '', status: 'modified', additions: 1, deletions: 0, changes: 1 }],
    explanations: [{
      file: 'src/a.js',
      status: 'done',
      error: null,
      // The legacy shape: a separate `suggestions` list next to `issues`.
      explanation: {
        verdict: 'block',
        summary: '旧分析',
        issues: [{ severity: 'block', point: '旧问题', line: 1 }],
        suggestions: [{ text: '旧的独立建议', line: 4 }],
      },
      chat: [],
      updatedAt: 150,
    }],
  });
  const plugin = await setup({ fetch: batchFetch, reviews: { 1: restored } });
  try {
    const review = await plugin.review();
    const entry = review.explanations.find((item) => item.file === 'src/a.js');
    assert.deepEqual(entry.explanation.issues, [
      { severity: 'block', point: '旧问题', suggestion: '', line: 1 },
      { severity: 'suggest', point: '旧的独立建议', suggestion: '', line: 4 },
    ]);
    assert.equal(entry.explanation.suggestions, undefined);
  } finally {
    await plugin.dispose();
  }
});

test('a restored legacy record persists the merged shape with no suggestions key', async () => {
  const legacy = legacyReview({
    conclusion: null,
    explanations: [{
      file: 'src/a.js',
      status: 'done',
      error: null,
      // The legacy shape: `issues` next to a separate string `suggestions` list.
      explanation: {
        verdict: 'block',
        summary: '旧分析',
        issues: [{ severity: 'block', point: '旧问题', line: 3 }],
        suggestions: ['补个测试'],
      },
      chat: [],
      updatedAt: 150,
    }],
  });
  const plugin = await setup({ reviews: { 1: legacy } });
  let payload;
  try {
    // Any write schedules a save; review_update_report leaves the explanations untouched,
    // so the persisted bytes reflect exactly what restore normalized into memory.
    await plugin.runTool('review_update_report', { revision: 0, summary: '初筛报告' });
    const cacheFile = path.join(plugin.home, '.dsh', 'pr-review', CACHE_SLUG);
    // Poll for the saved content instead of sleeping past the 800ms debounce: the cache
    // file already exists (the legacy pre-save bytes), so only the merged shape proves
    // the rewrite landed, however slow the flush is.
    const deadline = Date.now() + 5000;
    payload = null;
    while (payload === null && Date.now() < deadline) {
      await delay(50);
      try {
        const parsed = JSON.parse(await readFile(cacheFile, 'utf8'));
        const explanation = parsed.reviews?.['1']?.explanations?.[0]?.explanation;
        if (explanation !== undefined && !JSON.stringify(parsed).includes('"suggestions"')) payload = parsed;
      } catch {
        // Save not landed yet (or mid-rename); keep polling.
      }
    }
    assert.notEqual(payload, null, 'the debounced save rewrote the cache with the merged shape');
    const saved = payload.reviews['1'].explanations[0].explanation;
    assert.deepEqual(saved.issues, [
      { severity: 'block', point: '旧问题', suggestion: '', line: 3 },
      { severity: 'suggest', point: '补个测试', suggestion: '', line: 0 },
    ]);
    assert.equal(JSON.stringify(payload).includes('"suggestions"'), false, 'no suggestions key survives on disk');
  } finally {
    await plugin.dispose();
  }

  // Re-restoring the round-tripped cache yields the identical merged shape (no oscillation).
  const second = await setup({ cacheText: JSON.stringify(payload) });
  try {
    const review = await second.review();
    const entry = review.explanations.find((item) => item.file === 'src/a.js');
    assert.deepEqual(entry.explanation.issues, payload.reviews['1'].explanations[0].explanation.issues);
    assert.equal(entry.explanation.suggestions, undefined);
  } finally {
    await second.dispose();
  }
});




// ---------- DSH plugin conventions ----------

test('Config schema fills defaults and rejects invalid values', async () => {
  const { Config } = await import('../index.js');
  const filled = Config({ platform: 'github' });
  assert.equal(filled.platform, 'github');
  assert.equal(filled.pollSeconds, 60);
  assert.equal(filled.commentLanguage, 'zh');
  assert.equal(filled.autoReview, true);
  assert.equal(filled.autoAnalyze, true);
  assert.equal(filled.reasoningEffort, 'off');
  assert.equal(Config({ platform: 'gitea' }).platform, 'gitea');
  assert.equal(Config({ platform: 'forgejo' }).platform, 'forgejo');
  assert.equal(Config({ platform: 'gitlab' }).platform, 'gitlab');
  assert.equal(Config({ platform: 'gitee' }).platform, 'gitee');
  assert.equal(Config({ platform: 'gitcode' }).platform, 'gitcode');
  assert.equal(Config({ platform: 'atomgit' }).platform, 'atomgit');
  assert.equal(Config({ platform: 'codeup' }).platform, 'codeup');
  assert.equal(Config({ platform: 'codeup' }).organizationId, '');
  assert.equal(Config({ platform: 'codeup' }).projectId, '');
  assert.throws(() => Config({ platform: 'bitbucket' }), /platform/);
  assert.throws(() => Config({ pollSeconds: 5 }), /pollSeconds/);
  assert.throws(() => Config({ reasoningEffort: 'ultra' }), /reasoningEffort/);
});

test('tool failures carry stable HarnessError codes', async () => {
  const plugin = await setup();
  try {
    await assert.rejects(
      plugin.runTool('review_update_analysis', { path: '', revision: 0 }),
      (error) => {
        assert.equal(error.code, 'INVALID_ARGS');
        return true;
      },
    );
    await assert.rejects(
      plugin.runTool('review_update_analysis', { path: 'src/a.js', revision: 99 }),
      (error) => {
        assert.equal(error.code, 'STALE_REVISION');
        return true;
      },
    );
  } finally {
    await plugin.dispose();
  }
});

test('gitea is an alias for the Forgejo adapter and keeps the same cache slug', async () => {
  const { resolveProviderConfig, resolveToken } = await import('../providers.js');
  const gitea = resolveProviderConfig({ platform: 'gitea', baseUrl: 'https://codeberg.org', repo: 'forgejo/forgejo' });
  const forgejo = resolveProviderConfig({ platform: 'forgejo', baseUrl: 'https://codeberg.org', repo: 'forgejo/forgejo' });
  assert.equal(gitea.platform, 'forgejo', 'cache slug stays forgejo, so old caches keep loading');
  assert.equal(gitea.label, 'Gitea/Forgejo forgejo/forgejo');
  assert.deepEqual(gitea, forgejo);
  const github = resolveProviderConfig({ platform: 'github', repo: 'acme/demo' });
  assert.equal(github.platform, 'github');
  assert.equal(github.baseUrl, 'https://api.github.com');

  const previous = { gitea: process.env.GITEA_TOKEN, forgejo: process.env.FORGEJO_TOKEN };
  process.env.GITEA_TOKEN = 'gitea-token';
  process.env.FORGEJO_TOKEN = 'forgejo-token';
  try {
    const token = await resolveToken({}, { platform: 'forgejo', baseUrl: 'https://git.example', repo: 'acme/demo' });
    assert.equal(token, 'gitea-token', 'GITEA_TOKEN wins over FORGEJO_TOKEN');
  } finally {
    if (previous.gitea === undefined) delete process.env.GITEA_TOKEN;
    else process.env.GITEA_TOKEN = previous.gitea;
    if (previous.forgejo === undefined) delete process.env.FORGEJO_TOKEN;
    else process.env.FORGEJO_TOKEN = previous.forgejo;
  }
});

// ---------- evidence verification (two-pass review) ----------

/** Prompt text of one model request, however many content blocks it carries. */
function promptTextOf(options) {
  return (options?.messages ?? [])
    .flatMap((message) => message.content ?? [])
    .map((block) => String(block.text ?? ''))
    .join('\n');
}

/** One fake LLM answer: triage for the first call, verifier output for the second. */
function llmTriageThenVerify(triage, verify) {
  let call = 0;
  return () => {
    call += 1;
    const text = call === 1 ? JSON.stringify(triage) : (typeof verify === 'string' ? verify : JSON.stringify(verify));
    return (async function* () {
      yield { type: 'text-delta', text };
      yield { type: 'finish', reason: { kind: 'stop' } };
    })();
  };
}






























// ---------- agent engine (plugin level) ----------

/** A real git workspace whose HEAD is the PR head, so the runner can create a worktree. */
async function makeGitWorkspace() {
  const dir = await mkdtemp(path.join(tmpdir(), 'dsh-pr-review-ws-'));
  await execFileAsync('git', ['init', '-q', dir]);
  await execFileAsync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  await execFileAsync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  await execFileAsync('git', ['-C', dir, 'remote', 'add', 'origin', 'https://git.example/acme/demo.git']);
  await mkdir(path.join(dir, 'src'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'a.js'), 'const value = 1;\n', 'utf8');
  await execFileAsync('git', ['-C', dir, 'add', '.']);
  await execFileAsync('git', ['-C', dir, 'commit', '-qm', 'head']);
  const { stdout } = await execFileAsync('git', ['-C', dir, 'rev-parse', 'HEAD']);
  return { dir, headSha: stdout.trim() };
}

function agentFetch(headSha) {
  return async (url) => {
    const target = String(url);
    if (target.includes('/pulls?state=open')) return jsonResponse(200, []);
    if (target.endsWith('/pulls/1.diff')) return textResponse(200, BATCH_DIFF);
    if (target.includes('/pulls/1/files')) {
      return jsonResponse(200, [{ filename: 'src/a.js', status: 'modified', additions: 1, deletions: 0, changes: 1 }]);
    }
    if (target.includes('/contents/')) {
      return jsonResponse(200, {
        encoding: 'base64',
        content: Buffer.from('const value = 1;\n', 'utf8').toString('base64'),
        size: 17,
      });
    }
    if (/\/pulls\/1(?:\?.*)?$/.test(target)) {
      return jsonResponse(200, {
        number: 1,
        title: 'PR 标题',
        body: '',
        user: { login: 'dev' },
        state: 'open',
        merged: false,
        additions: 1,
        deletions: 0,
        changed_files: 1,
        head: { ref: 'feature', sha: headSha },
        base: { ref: 'main', sha: 'def456' },
        html_url: 'https://git.example/acme/demo/pulls/1',
      });
    }
    throw new Error(`unexpected fetch in test: ${target}`);
  };
}

function revisionOf(text) {
  const match = /revision：(\d+)/.exec(String(text));
  assert.ok(match !== null, `review_get returned a revision: ${String(text).slice(0, 200)}`);
  return Number(match[1]);
}

test('agent engine runs through the plugin, binds writes to its PR, and refuses publish', async () => {
  const workspace = await makeGitWorkspace();
  const base = legacyReview();
  const second = {
    ...base,
    number: 2,
    headSha: 'sha2',
    finishedAt: 9999,
    pull: { ...base.pull, number: 2, title: 'PR 2', headSha: 'sha2', url: 'https://git.example/acme/demo/pulls/2' },
  };
  let publishError = null;
  const plugin = await setup({
    reviews: { 1: base, 2: second },
    fetch: agentFetch(workspace.headSha),
    onAgentFollowup: async ({ agent, executeTool }) => {
      // No `number`: the runner must resolve the bound PR, not the most recently finished one.
      const first = await executeTool('review_get', {}, agent);
      await executeTool('review_update_analysis', {
        path: 'src/a.js',
        revision: revisionOf(first),
        verdict: 'suggest',
        summary: '有一个建议',
        issues: [{ point: 'agent finding', severity: 'suggest', line: 1 }],
      }, agent);
      const secondGet = await executeTool('review_get', {}, agent);
      await executeTool('review_update_report', {
        revision: revisionOf(secondGet),
        verdict: 'pass',
        summary: 'Agent 报告',
        risks: [],
        order: [],
        focus: {},
      }, agent);
      const thirdGet = await executeTool('review_get', {}, agent);
      await executeTool('review_update_conclusion', {
        revision: revisionOf(thirdGet),
        verdict: 'pass',
        summary: 'Agent 结论',
        blockers: [],
        suggestions: [],
        nextSteps: [],
        previousVerdicts: [{ index: 1, status: 'fixed' }],
      }, agent);
      try {
        await executeTool('review_publish', {}, agent);
      } catch (error) {
        publishError = error;
      }
    },
  });
  try {
    const context = await plugin.call(`/pr-review-api/context?cwd=${encodeURIComponent(workspace.dir)}`);
    assert.equal(context.status, 200);
    assert.equal(context.json.supported, true);
    const started = await plugin.call('/pr-review-api/review', 'POST', { number: 1, force: true });
    assert.equal(started.json.started, true);
    const done = await plugin.waitFor(1, (review) => review.status !== 'reviewing', 8000);
    assert.equal(done.status, 'done', JSON.stringify(done.run));
    assert.equal(done.report.summary, 'Agent 报告');
    assert.equal(done.conclusion.summary, 'Agent 结论');
    assert.equal(done.run.status, 'done');
    assert.equal(done.run.headIsolated, true);
    assert.deepEqual(done.run.missingFiles, []);
    assert.deepEqual(done.run.missingSections, []);
    // The later-finished PR 2 is untouched: the agent was bound to #1.
    const other = await plugin.review(2);
    assert.equal(other.report.summary, '初步报告');
    assert.equal(other.revision, 0);
    assert.ok(publishError !== null, 'publish from the runner session is rejected');
    assert.match(String(publishError.message), /不能发布/);
    assert.deepEqual(plugin.agentState.mounts, ['pr-review-readonly']);
    assert.deepEqual(plugin.agentState.restrictions, [{ deny: ['bash', 'review_publish'] }]);
    assert.equal(plugin.agentState.disposed.length, 1);
  } finally {
    await plugin.dispose();
    await rm(workspace.dir, { recursive: true, force: true });
  }
});

test('agent engine fails closed when the PR head worktree cannot be created', async () => {
  const plugin = await setup({
    fetch: agentFetch('missing-sha'),
    onAgentFollowup: async () => {
      throw new Error('the agent must not start without an isolated head worktree');
    },
  });
  try {
    const started = await plugin.call('/pr-review-api/review', 'POST', { number: 1, force: true });
    assert.equal(started.json.started, true);
    const failed = await plugin.waitFor(1, (review) => review.status !== 'reviewing', 8000);
    assert.equal(failed.status, 'error');
    assert.match(failed.error, /工作区/);
    assert.equal(failed.run.status, 'error');
    assert.deepEqual(failed.run.missingFiles, []);
    assert.equal(plugin.agentState.followups.length, 0);
  } finally {
    await plugin.dispose();
  }
});

test('a reviewing agent run is persisted so a restart does not drop the PR', async () => {
  const workspace = await makeGitWorkspace();
  const plugin = await setup({
    reviewCoverageRetries: 0,
    fetch: agentFetch(workspace.headSha),
    onAgentFollowup: async () => {
      await delay(1200);
    },
  });
  try {
    await plugin.call(`/pr-review-api/context?cwd=${encodeURIComponent(workspace.dir)}`);
    const started = await plugin.call('/pr-review-api/review', 'POST', { number: 1, force: true });
    assert.equal(started.json.started, true);
    const cachePath = path.join(plugin.home, '.dsh', 'pr-review', CACHE_SLUG);
    let persisted = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        const data = JSON.parse(await readFile(cachePath, 'utf8'));
        const entry = data.reviews?.['1'];
        if (entry?.status === 'reviewing') {
          persisted = entry;
          break;
        }
      } catch {
        // The cache file may not exist yet.
      }
      await delay(50);
    }
    assert.ok(persisted !== null, 'reviewing record is written to the cache');
    assert.equal(persisted.run.status, 'running');
    const finished = await plugin.waitFor(1, (review) => review.status !== 'reviewing', 8000);
    assert.equal(finished.status, 'incomplete');
  } finally {
    await plugin.dispose();
    await rm(workspace.dir, { recursive: true, force: true });
  }
});



test('a reviewing record saved before restart is restored as a retryable error', async () => {
  const plugin = await setup({
    reviews: { 1: legacyReview({ status: 'reviewing', run: { status: 'running', round: 1, headSha: 'abc123', startedAt: 1 } }) },
  });
  try {
    const review = await plugin.review();
    assert.equal(review.status, 'error');
    assert.match(review.error, /应用重启/);
    assert.equal(review.run.status, 'error');
    assert.match(review.run.error, /应用重启/);
  } finally {
    await plugin.dispose();
  }
});

test('the delta compares the previous conclusion items, not per-file findings', async () => {
  const conclusion = { verdict: 'block', summary: '旧结论', blockers: [{ file: 'src/a.js', point: '旧问题' }], suggestions: [], nextSteps: [] };
  const currentConclusion = {
    verdict: 'block',
    summary: '新结论',
    blockers: [{ file: 'src/a.js', point: '旧问题' }],
    suggestions: [],
    nextSteps: [],
  };
  const record = legacyReview({
    round: 2,
    previousRound: {
      round: 1,
      headSha: 'abc123',
      conclusion,
      items: [
        { kind: 'blocker', id: 'b-old', file: 'src/a.js', point: '旧问题', line: 1, index: 1 },
        { kind: 'suggestion', id: 's-old', file: 'src/a.js', point: '旧建议', line: 2, index: 2 },
      ],
    },
    conclusion: currentConclusion,
    conclusionAt: 600,
    // 逐文件 findings 故意保留 20 条，确认它不再进入结论层对比。
    roundHistory: [
      {
        round: 1,
        headSha: 'abc123',
        startedAt: 100,
        finishedAt: 200,
        conclusions: [{ version: 1, createdAt: 300, source: 'model', conclusion, coverage: null }],
        feedback: null,
        publishedIds: [],
        findings: Array.from({ length: 20 }, (_, index) => ({
          index: index + 1, file: 'src/a.js', severity: 'suggest', point: `逐文件意见 ${index + 1}`, line: 1, suggestion: '',
        })),
      },
      {
        round: 2,
        headSha: 'newsha',
        startedAt: 400,
        finishedAt: 0,
        conclusions: [{
          version: 1,
          createdAt: 600,
          source: 'model',
          conclusion: currentConclusion,
          coverage: null,
          previousVerdicts: [
            { index: 1, status: 'still-open' },
            { index: 2, status: 'fixed' },
          ],
        }],
        feedback: null,
        publishedIds: [],
      },
    ],
  });
  const plugin = await setup({ reviews: { 1: record } });
  try {
    const review = await plugin.review();
    assert.equal(review.delta.baselineRound, 1);
    assert.deepEqual(review.delta.resolved.map((item) => item.point), ['旧建议'], JSON.stringify(review.delta));
    assert.deepEqual(review.delta.stillOpen.map((item) => item.previous.point), ['旧问题']);
    assert.deepEqual(review.delta.pending, []);
    assert.deepEqual(review.delta.undetermined, []);
  } finally {
    await plugin.dispose();
  }
});

test('a conclusion delta without previousVerdicts never reports an omitted item as fixed', async () => {
  const conclusion = { verdict: 'block', summary: '旧结论', blockers: [{ file: 'src/a.js', point: '旧问题' }], suggestions: [], nextSteps: [] };
  const currentConclusion = { verdict: 'block', summary: '新结论', blockers: [{ file: 'src/a.js', point: '旧问题' }], suggestions: [], nextSteps: [] };
  const record = legacyReview({
    round: 2,
    previousRound: {
      round: 1,
      headSha: 'abc123',
      conclusion,
      items: [
        { kind: 'blocker', id: 'b-old', file: 'src/a.js', point: '旧问题', line: 1, index: 1 },
        { kind: 'suggestion', id: 's-old', file: 'src/a.js', point: '旧建议', line: 2, index: 2 },
      ],
    },
    conclusion: currentConclusion,
    conclusionAt: 600,
    roundHistory: [
      {
        round: 1,
        headSha: 'abc123',
        startedAt: 100,
        finishedAt: 200,
        conclusions: [{ version: 1, createdAt: 300, source: 'model', conclusion, coverage: null }],
        feedback: null,
        publishedIds: [],
      },
      {
        round: 2,
        headSha: 'newsha',
        startedAt: 400,
        finishedAt: 0,
        conclusions: [{ version: 1, createdAt: 600, source: 'model', conclusion: currentConclusion, coverage: null }],
        feedback: null,
        publishedIds: [],
      },
    ],
  });
  const plugin = await setup({ reviews: { 1: record } });
  try {
    const review = await plugin.review();
    assert.deepEqual(review.delta.resolved, []);
    assert.deepEqual(review.delta.stillOpen.map((item) => item.previous.point), ['旧问题']);
    assert.deepEqual(review.delta.undetermined.map((item) => item.point), ['旧建议']);
  } finally {
    await plugin.dispose();
  }
});

test('review_update_conclusion persists previous-round verdicts for the conclusion delta', async () => {
  const previousConclusion = { verdict: 'block', summary: '旧结论', blockers: [{ file: 'src/a.js', point: '旧问题' }], suggestions: [], nextSteps: [] };
  const record = legacyReview({
    round: 2,
    previousRound: {
      round: 1,
      headSha: 'abc123',
      conclusion: previousConclusion,
      items: [
        { kind: 'blocker', id: 'b-old', file: 'src/a.js', point: '旧问题', line: 1, index: 1 },
        { kind: 'suggestion', id: 's-old', file: 'src/a.js', point: '旧建议', line: 2, index: 2 },
      ],
    },
    conclusion: null,
    conclusionAt: 0,
    roundHistory: [
      {
        round: 1,
        headSha: 'abc123',
        startedAt: 100,
        finishedAt: 200,
        conclusions: [{ version: 1, createdAt: 300, source: 'model', conclusion: previousConclusion, coverage: null }],
        feedback: null,
        publishedIds: [],
      },
      { round: 2, headSha: 'newsha', startedAt: 400, finishedAt: 0, conclusions: [], feedback: null, publishedIds: [] },
    ],
  });
  const plugin = await setup({ reviews: { 1: record } });
  try {
    const before = await plugin.review();
    await plugin.runTool('review_update_conclusion', {
      revision: before.revision,
      verdict: 'block',
      summary: '新结论',
      blockers: [{ file: 'src/a.js', point: '旧问题' }],
      suggestions: [],
      nextSteps: [],
      previousVerdicts: [
        { index: 1, status: 'still-open' },
        { index: 2, status: 'fixed' },
      ],
    });
    const after = await plugin.review();
    assert.deepEqual(after.delta.resolved.map((item) => item.point), ['旧建议']);
    assert.deepEqual(after.delta.stillOpen.map((item) => item.previous.point), ['旧问题']);
    assert.equal(after.roundHistory[1].conclusions[0].previousVerdicts.length, 2);
  } finally {
    await plugin.dispose();
  }
});

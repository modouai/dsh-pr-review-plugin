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
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
      return undefined;
    },
    systemPrompt: {
      section() {
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
    autoReconclude: options.autoReconclude === true,
    evidenceVerify: options.evidenceVerify !== false,
    // Batch analysis is opt-in per test: its background model calls would otherwise race
    // the assertions of the review/conclusion tests. The schema default is `true`;
    // `useDefaultAutoAnalyze` omits the key to exercise that default end to end.
    ...(options.useDefaultAutoAnalyze === true ? {} : { autoAnalyze: options.autoAnalyze === true }),
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
    assert.equal(round.delta, null);
    assert.equal(round.feedback, null);

    // Legacy items get stable ids; top-level fields mirror the newest version.
    assert.equal(typeof review.conclusion.blockers[0].id, 'string');
    assert.match(review.conclusion.blockers[0].id, /^b-[0-9a-f]{6}$/);
    assert.equal(review.published[0].version, 0);
    assert.deepEqual(review.humanItemIds, []);
    assert.equal(review.concluding, null);
    assert.equal(review.concludeError, null);
    assert.equal(review.coverage, null);
    assert.equal(review.conclusionAt, 500);

    // /prs exposes the new config and prefers the conclusion verdict.
    const prs = await plugin.call('/pr-review-api/prs');
    assert.equal(prs.status, 200);
    assert.equal(prs.json.commentLanguage, 'zh');
    assert.equal(prs.json.autoReconclude, false);
    assert.equal(prs.json.reviews['1'].verdict, 'block');
  } finally {
    await plugin.dispose();
  }
});

test('force review opens round 2: previousRound, cleared state, and delta on the next conclusion', async () => {
  const diffText = 'diff --git a/src/a.js b/src/a.js\n@@ -1 +1 @@\n-a\n+b\n';
  const fetchHandler = async (url) => {
    const target = String(url);
    if (target.includes('/pulls?state=open')) return jsonResponse(200, []);
    if (target.endsWith('/pulls/1.diff')) return textResponse(200, diffText);
    if (target.includes('/pulls/1/files')) {
      return jsonResponse(200, [{ filename: 'src/a.js', status: 'modified', additions: 1, deletions: 0, changes: 1 }]);
    }
    if (/\/pulls\/1$/.test(target)) {
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
        head: { ref: 'feature', sha: 'newsha' },
        base: { ref: 'main', sha: 'def456' },
        html_url: 'https://git.example/acme/demo/pulls/1',
      });
    }
    throw new Error(`unexpected fetch in test: ${target}`);
  };
  const reportReply = JSON.stringify({
    verdict: 'suggest',
    summary: '第二轮报告',
    risks: [],
    order: [{ file: 'src/a.js', reason: '' }],
    focus: {},
  });
  const conclusionReply = JSON.stringify({
    verdict: 'block',
    summary: '第二轮结论',
    blockers: [{ file: 'src/a.js', point: '旧问题' }],
    suggestions: [],
    nextSteps: [],
  });
  const plugin = await setup({ fetch: fetchHandler });
  try {
    plugin.llmState.handler = (streamOptions) => {
      const promptText = JSON.stringify(streamOptions.messages);
      const reply = promptText.includes('作为合并前的最终审查结论') ? conclusionReply : reportReply;
      return llmFromText(reply)(streamOptions);
    };

    // Round 1 already has a conclusion; force opens round 2.
    const forced = await plugin.call('/pr-review-api/review', 'POST', { number: 1, force: true });
    assert.equal(forced.status, 200);
    const secondRound = await plugin.waitFor(1, (current) => current.status === 'done' && current.roundHistory.length === 2);

    assert.equal(secondRound.round, 2);
    assert.equal(secondRound.roundHistory.length, 2);
    assert.deepEqual(secondRound.roundHistory.map((round) => round.round), [1, 2]);
    const openRound = secondRound.roundHistory[1];
    assert.equal(openRound.round, 2);
    assert.equal(openRound.finishedAt > 0, true);
    assert.deepEqual(openRound.conclusions, []);
    assert.equal(openRound.delta, null);
    assert.equal(openRound.feedback, null);
    assert.deepEqual(openRound.publishedIds, []);
    assert.equal(secondRound.conclusion, null);
    assert.equal(secondRound.delta, null);
    assert.equal(secondRound.feedback, null);
    assert.deepEqual(secondRound.publishedItems, []);
    assert.deepEqual(secondRound.humanItemIds, []);
    assert.equal(secondRound.coverage, null);
    // Published history is never dropped when a new round starts.
    assert.equal(secondRound.published.length, 1);
    // Round 1 stays intact in the history (its conclusion and published comment).
    assert.equal(secondRound.roundHistory[0].conclusions.length, 1);
    assert.equal(secondRound.roundHistory[0].conclusions[0].conclusion.verdict, 'block');
    assert.deepEqual(secondRound.roundHistory[0].publishedIds, [555]);

    // Generating round 2's conclusion produces the re-review delta.
    await plugin.call('/pr-review-api/conclude', 'POST', { number: 1 });
    const reviewed = await plugin.waitForConcluding();
    assert.equal(reviewed.roundHistory[1].conclusions.length, 1);
    assert.equal(reviewed.conclusion.verdict, 'block');
    assert.notEqual(reviewed.delta, null);
    assert.equal(reviewed.delta.round, 2);
    assert.equal(reviewed.delta.previousRound, 1);
    assert.equal(reviewed.delta.stillOpen.length, 1);
    assert.equal(reviewed.delta.stillOpen[0].point, '旧问题');
    assert.deepEqual(reviewed.delta.resolved, []);
  } finally {
    await plugin.dispose();
  }
});

test('the overview delta previews from per-file findings before any conclusion exists', async () => {
  const record = legacyReview({
    round: 2,
    conclusion: null,
    conclusionAt: 0,
    comment: null,
    delta: null,
    published: [],
    publishedItems: [],
    previousRound: {
      round: 1,
      headSha: 'abc123',
      conclusion: { verdict: 'block', summary: '第一轮结论', blockers: [{ file: 'src/a.js', point: '旧问题' }], suggestions: [], nextSteps: [] },
      items: [
        { kind: 'blocker', file: 'src/a.js', point: '旧问题' },
        { kind: 'suggestion', file: 'src/a.js', point: '旧建议' },
      ],
    },
    explanations: [{
      file: 'src/a.js',
      status: 'done',
      error: null,
      // The finished analysis re-finds the round-1 blocker; the suggestion was not seen again.
      explanation: { verdict: 'block', summary: '复现', issues: [{ severity: 'block', point: '旧问题', line: 1 }], suggestions: [] },
      chat: [],
      updatedAt: 150,
    }],
  });
  const plugin = await setup({ reviews: { 1: record } });
  try {
    const review = await plugin.review();
    assert.equal(review.conclusion, null);
    assert.notEqual(review.delta, null);
    assert.equal(review.delta.preview, true);
    assert.equal(review.delta.round, 2);
    assert.equal(review.delta.previousRound, 1);
    // 早期「已修复」= 本轮未再发现：the suggestion was not re-found by the finished analysis.
    assert.deepEqual(review.delta.resolved, [{ kind: 'suggestion', file: 'src/a.js', point: '旧建议' }]);
    assert.deepEqual(review.delta.stillOpen, [{ kind: 'blocker', file: 'src/a.js', point: '旧问题' }]);
    assert.equal(typeof review.delta.comparedAt, 'number');
    // The preview is derived only: the persisted history entry stays empty.
    assert.equal(review.roundHistory[0].delta, null);
  } finally {
    await plugin.dispose();
  }
});

test('a persisted round delta wins over the per-file preview', async () => {
  const persisted = {
    round: 2,
    previousRound: 1,
    resolved: [],
    stillOpen: [{ kind: 'blocker', file: 'src/a.js', point: '旧问题' }],
    comparedAt: 1234,
  };
  const record = legacyReview({
    round: 2,
    delta: persisted,
    previousRound: { round: 1, headSha: 'abc123', conclusion: null, items: [{ kind: 'blocker', file: 'src/a.js', point: '旧问题' }] },
    // The analysis re-finds the same point, but conclude's delta must be returned untouched.
    explanations: [{
      file: 'src/a.js',
      status: 'done',
      error: null,
      explanation: { verdict: 'block', summary: '复现', issues: [{ severity: 'block', point: '旧问题', line: 1 }], suggestions: [] },
      chat: [],
      updatedAt: 150,
    }],
  });
  const plugin = await setup({ reviews: { 1: record } });
  try {
    const review = await plugin.review();
    assert.deepEqual(review.delta, persisted);
    assert.equal(review.delta.preview, undefined);
  } finally {
    await plugin.dispose();
  }
});

test('no preview delta without previous items or without finished analyses', async () => {
  // previousRound: null, even though the one analysis is done.
  const noPrevious = legacyReview({});
  // previousRound exists, but the file has not been analysed yet: nothing may be
  // reported as resolved while its analysis is still pending.
  const notAnalyzed = legacyReview({
    number: 2,
    previousRound: { round: 1, headSha: 'abc123', conclusion: null, items: [{ kind: 'blocker', file: 'src/a.js', point: '旧问题' }] },
    explanations: [{
      file: 'src/a.js',
      status: 'pending',
      error: null,
      explanation: null,
      chat: [],
      updatedAt: 0,
    }],
  });
  const plugin = await setup({ reviews: { 1: noPrevious, 2: notAnalyzed } });
  try {
    assert.equal((await plugin.review(1)).delta, null);
    assert.equal((await plugin.review(2)).delta, null);
  } finally {
    await plugin.dispose();
  }
});

test('an all-clean round with every analysis done shows every previous item as resolved', async () => {
  const files = [
    { path: 'src/a.js', previousPath: '', status: 'modified', additions: 1, deletions: 0, changes: 1 },
    { path: 'src/b.js', previousPath: '', status: 'modified', additions: 1, deletions: 0, changes: 1 },
  ];
  const cleanExplanation = { verdict: 'pass', summary: '没有发现', issues: [], suggestions: [] };
  const record = legacyReview({
    round: 2,
    conclusion: null,
    conclusionAt: 0,
    comment: null,
    delta: null,
    files,
    published: [],
    publishedItems: [],
    previousRound: {
      round: 1,
      headSha: 'abc123',
      conclusion: null,
      items: [
        { kind: 'blocker', file: 'src/a.js', point: '旧问题' },
        { kind: 'suggestion', file: 'src/b.js', point: '旧建议' },
      ],
    },
    explanations: [
      { file: 'src/a.js', status: 'done', error: null, explanation: cleanExplanation, chat: [], updatedAt: 150 },
      { file: 'src/b.js', status: 'done', error: null, explanation: cleanExplanation, chat: [], updatedAt: 150 },
    ],
  });
  const plugin = await setup({ reviews: { 1: record } });
  try {
    const review = await plugin.review();
    // Zero findings plus full coverage is the honest「全部已修复」case.
    assert.equal(review.delta.preview, true);
    assert.deepEqual(review.delta.resolved, [
      { kind: 'blocker', file: 'src/a.js', point: '旧问题' },
      { kind: 'suggestion', file: 'src/b.js', point: '旧建议' },
    ]);
    assert.deepEqual(review.delta.stillOpen, []);
  } finally {
    await plugin.dispose();
  }
});

test('zero findings with an analysis still pending stays hidden', async () => {
  const record = legacyReview({
    round: 2,
    conclusion: null,
    conclusionAt: 0,
    comment: null,
    delta: null,
    files: [
      { path: 'src/a.js', previousPath: '', status: 'modified', additions: 1, deletions: 0, changes: 1 },
      { path: 'src/b.js', previousPath: '', status: 'modified', additions: 1, deletions: 0, changes: 1 },
    ],
    previousRound: {
      round: 1,
      headSha: 'abc123',
      conclusion: null,
      items: [{ kind: 'blocker', file: 'src/a.js', point: '旧问题' }],
    },
    explanations: [
      // Only one of two files analysed, and it found nothing: not yet honest to report resolved.
      { file: 'src/a.js', status: 'done', error: null, explanation: { verdict: 'pass', summary: '没有发现', issues: [], suggestions: [] }, chat: [], updatedAt: 150 },
    ],
  });
  const plugin = await setup({ reviews: { 1: record } });
  try {
    assert.equal((await plugin.review()).delta, null);
  } finally {
    await plugin.dispose();
  }
});

test('a done entry without an explanation body never completes the preview coverage', async () => {
  // startAnalysisBatch treats `done` with a null explanation as an empty analysis and
  // requeues it; the preview must count the same way, or a restored record whose bodies
  // are still missing would be misjudged as fully analysed and claim「全部已修复」.
  const onlyFileDoneWithoutBody = legacyReview({
    round: 2,
    conclusion: null,
    conclusionAt: 0,
    comment: null,
    delta: null,
    published: [],
    publishedItems: [],
    previousRound: {
      round: 1,
      headSha: 'abc123',
      conclusion: null,
      items: [{ kind: 'blocker', file: 'src/a.js', point: '旧问题' }],
    },
    explanations: [
      { file: 'src/a.js', status: 'done', error: null, explanation: null, chat: [], updatedAt: 150 },
    ],
  });
  const doneWithoutBodyPlusPending = legacyReview({
    number: 2,
    files: [
      { path: 'src/a.js', previousPath: '', status: 'modified', additions: 1, deletions: 0, changes: 1 },
      { path: 'src/b.js', previousPath: '', status: 'modified', additions: 1, deletions: 0, changes: 1 },
    ],
    round: 2,
    conclusion: null,
    conclusionAt: 0,
    comment: null,
    delta: null,
    published: [],
    publishedItems: [],
    previousRound: {
      round: 1,
      headSha: 'abc123',
      conclusion: null,
      items: [{ kind: 'blocker', file: 'src/a.js', point: '旧问题' }],
    },
    explanations: [
      { file: 'src/a.js', status: 'done', error: null, explanation: null, chat: [], updatedAt: 150 },
    ],
  });
  const plugin = await setup({ reviews: { 1: onlyFileDoneWithoutBody, 2: doneWithoutBodyPlusPending } });
  try {
    // The only file reports done with a null body: under done-only counting this single
    // record already reaches full coverage and would resolve the previous item.
    assert.equal((await plugin.review(1)).delta, null);
    // The done-without-body file plus a not-yet-analysed file stays hidden too.
    assert.equal((await plugin.review(2)).delta, null);
  } finally {
    await plugin.dispose();
  }
});

test('async /conclude: returns started, rejects duplicates with 409, appends a model version', async () => {
  const conclusionJson = JSON.stringify({
    verdict: 'block',
    summary: '新结论',
    blockers: [
      { file: 'src/a.js', point: '旧问题仍然存在' },
      { file: 'src/ghost.js', point: '幻想的文件问题' },
    ],
    suggestions: [],
    nextSteps: ['修'],
  });
  const plugin = await setup({ llm: llmSlow(120, conclusionJson) });
  try {
    const started = await plugin.call('/pr-review-api/conclude', 'POST', { number: 1 });
    assert.equal(started.status, 200);
    assert.deepEqual(started.json, { ok: true, started: true });

    const reviewWhileRunning = await plugin.review();
    assert.notEqual(reviewWhileRunning.concluding, null);
    assert.ok(['collect', 'model', 'parse', 'write'].includes(reviewWhileRunning.concluding.stage));

    const duplicate = await plugin.call('/pr-review-api/conclude', 'POST', { number: 1 });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.json.error.code, 'concluding');

    const review = await plugin.waitForConcluding();
    assert.equal(review.concluding, null);
    assert.equal(review.concludeError, null);

    const round = review.roundHistory[0];
    assert.equal(round.conclusions.length, 2);
    const latest = round.conclusions[1];
    assert.equal(latest.version, 2);
    assert.equal(latest.source, 'model');
    assert.deepEqual(latest.coverage, { analyzed: 1, total: 1, unanalyzed: [] });
    assert.deepEqual(review.coverage, latest.coverage);
    assert.equal(review.conclusion.verdict, 'block');
    assert.equal(review.conclusion.summary, '新结论');
    assert.deepEqual(review.conclusion.nextSteps, ['修']);

    // Merge kept the old id for the reworded finding and marked the unknown file.
    assert.equal(review.conclusion.blockers[0].id, latest.conclusion.blockers[0].id);
    assert.equal(review.conclusion.blockers[1].file, '');
    assert.match(review.conclusion.blockers[1].point, /^（未定位：src\/ghost\.js）/);
    // No previousRound yet → no delta.
    assert.equal(review.delta, null);
    assert.equal(round.delta, null);
    // Top-level mirrors the newest version.
    assert.deepEqual(review.conclusion, latest.conclusion);
    assert.equal(review.conclusionAt, latest.createdAt);
    // Nothing was published by generating a conclusion.
    assert.equal(review.published.length, 1);
  } finally {
    await plugin.dispose();
  }
});

test('/conclude/cancel aborts the job and records a 已取消 error without a new version', async () => {
  const plugin = await setup({ llm: llmSlow(5000) });
  try {
    const idle = await plugin.call('/pr-review-api/conclude/cancel', 'POST', { number: 1 });
    assert.equal(idle.status, 200);
    assert.equal(idle.json.cancelled, false);

    const started = await plugin.call('/pr-review-api/conclude', 'POST', { number: 1 });
    assert.equal(started.json.started, true);
    await delay(30);

    const cancelled = await plugin.call('/pr-review-api/conclude/cancel', 'POST', { number: 1 });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.json.cancelled, true);

    const review = await plugin.waitForConcluding();
    assert.equal(review.roundHistory[0].conclusions.length, 1);
    assert.match(review.concludeError, /已取消/);
    assert.match(review.error, /已取消/);

    // A later successful run clears both the error and the cancelled state.
    plugin.llmState.handler = llmFromText(JSON.stringify({ verdict: 'suggest', summary: '重来', blockers: [], suggestions: [], nextSteps: [] }));
    await plugin.call('/pr-review-api/conclude', 'POST', { number: 1 });
    const regenerated = await plugin.waitForConcluding();
    assert.equal(regenerated.concludeError, null);
    assert.equal(regenerated.error, null);
    assert.equal(regenerated.roundHistory[0].conclusions.length, 2);
  } finally {
    await plugin.dispose();
  }
});

test('publish preview + idempotency + force append + concurrent publishing lock', async () => {
  let commentId = 900;
  const fetchHandler = async (url, fetchOptions = {}) => {
    const target = String(url);
    if (target.includes('/pulls?state=open')) return jsonResponse(200, []);
    if (target.includes('/issues/1/comments') && fetchOptions.method === 'POST') {
      commentId += 1;
      return jsonResponse(201, { id: commentId, html_url: `https://git.example/comment/${commentId}` });
    }
    throw new Error(`unexpected fetch in test: ${target}`);
  };
  const plugin = await setup({
    commentLanguage: 'zh',
    llm: llmFromText(JSON.stringify({
      verdict: 'block',
      summary: '新结论',
      blockers: [{ file: 'src/a.js', point: '旧问题仍然存在' }],
      suggestions: [],
      nextSteps: ['修'],
    })),
    fetch: fetchHandler,
  });
  try {
    await plugin.call('/pr-review-api/conclude', 'POST', { number: 1 });
    await plugin.waitForConcluding();

    // Preview has no side effects and carries the new footer/coverage language.
    const preview = await plugin.call('/pr-review-api/comment/preview', 'POST', { number: 1 });
    assert.equal(preview.status, 200);
    assert.equal(preview.json.language, 'zh');
    assert.match(preview.json.markdown, /由 DeepSeek harness PR 审查插件生成/);
    assert.match(preview.json.markdown, /覆盖：已分析 1\/1 个变更文件。/);
    assert.match(preview.json.markdown, /- \[ \] 修/);
    const unchanged = await plugin.review();
    assert.equal(unchanged.published.length, 1);

    const first = await plugin.call('/pr-review-api/comment', 'POST', { number: 1 });
    assert.equal(first.status, 200);
    assert.equal(first.json.published.length, 2);
    const firstEntry = first.json.published[1];
    assert.equal(firstEntry.round, 1);
    assert.equal(firstEntry.version, 2);
    assert.equal(firstEntry.itemCount, 1);
    let review = await plugin.review();
    assert.equal(review.published.length, 2);
    assert.deepEqual(review.roundHistory[0].publishedIds, [555, firstEntry.id]);
    assert.equal(review.publishedItems[0].id, review.conclusion.blockers[0].id);
    assert.equal(review.feedback, null);
    assert.equal(review.publishing, false);

    // The same round+version is refused unless force is explicit.
    const duplicate = await plugin.call('/pr-review-api/comment', 'POST', { number: 1 });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.json.error.code, 'already-published');
    const forced = await plugin.call('/pr-review-api/comment', 'POST', { number: 1, force: true });
    assert.equal(forced.status, 200);
    assert.equal(forced.json.published.length, 3);
    // Append semantics: earlier comments are never overwritten.
    assert.equal(forced.json.published[1].id, firstEntry.id);

    // Concurrent publishes: the second request hits the publishing lock.
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    plugin.fetchState.handler = async (url, fetchOptions = {}) => {
      const target = String(url);
      if (target.includes('/issues/1/comments') && fetchOptions.method === 'POST') {
        await gate;
        commentId += 1;
        return jsonResponse(201, { id: commentId, html_url: `https://git.example/comment/${commentId}` });
      }
      return fetchHandler(url, fetchOptions);
    };
    const pending = plugin.call('/pr-review-api/comment', 'POST', { number: 1, force: true });
    await delay(40);
    // If the lock were missing, the second request would queue behind the gate,
    // so bound the wait instead of deadlocking the test.
    const blocked = await within(plugin.call('/pr-review-api/comment', 'POST', { number: 1, force: true }), 1500);
    release();
    const pendingResult = await pending;
    await delay(30);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.json.error.code, 'publishing');
    assert.equal(pendingResult.status, 200);
    review = await plugin.review();
    assert.equal(review.publishing, false);
  } finally {
    await plugin.dispose();
  }
});

test('publish selection: /comment/preview includeIds filters markdown, returns full items, ignores bad ids', async () => {
  let commentId = 700;
  const sentBodies = [];
  const fetchHandler = async (url, fetchOptions = {}) => {
    const target = String(url);
    if (target.includes('/pulls?state=open')) return jsonResponse(200, []);
    if (target.includes('/issues/1/comments') && fetchOptions.method === 'POST') {
      commentId += 1;
      const payload = JSON.parse(String(fetchOptions.body ?? '{}'));
      sentBodies.push(String(payload.body ?? ''));
      return jsonResponse(201, { id: commentId, html_url: `https://git.example/comment/${commentId}` });
    }
    throw new Error(`unexpected fetch in test: ${target}`);
  };
  const conclusionReply = JSON.stringify({
    verdict: 'block',
    summary: '选择性发布结论',
    blockers: [
      { id: 'b-keep01', file: 'src/a.js', line: 10, point: '问题一' },
      { id: 'b-drop02', file: 'src/a.js', line: 20, point: '问题二' },
    ],
    suggestions: [{ id: 's-keep03', file: 'src/a.js', line: 30, point: '建议一' }],
    nextSteps: ['先修问题一'],
  });
  const plugin = await setup({ llm: llmFromText(conclusionReply), fetch: fetchHandler });
  try {
    await plugin.call('/pr-review-api/conclude', 'POST', { number: 1 });
    const review = await plugin.waitForConcluding();
    const ids = review.conclusion.blockers.map((item) => item.id).concat(review.conclusion.suggestions.map((item) => item.id));
    assert.deepEqual(ids, ['b-keep01', 'b-drop02', 's-keep03']);
    assert.deepEqual(review.conclusion.blockers.map((item) => item.line), [10, 20]);

    // No includeIds → unchanged preview, but the full item list is returned for checkboxes.
    const full = await plugin.call('/pr-review-api/comment/preview', 'POST', { number: 1 });
    assert.equal(full.status, 200);
    assert.equal(full.json.items.length, 3);
    assert.deepEqual(full.json.items[0], { id: 'b-keep01', kind: 'blocker', file: 'src/a.js', point: '问题一', line: 10 });
    assert.deepEqual(full.json.items[2], { id: 's-keep03', kind: 'suggestion', file: 'src/a.js', point: '建议一', line: 30 });
    assert.match(full.json.markdown, /问题一/);
    assert.match(full.json.markdown, /问题二/);
    assert.match(full.json.markdown, /建议一/);
    assert.match(full.json.markdown, /`src\/a\.js:10`/);
    // The header pins the reviewed commit + round + conclusion version, and the appendix
    // carries the review content that does not fit in the numbered body.
    assert.match(full.json.markdown, /`commit abc123` · 第 1 轮 · 结论 v2/);
    assert.match(full.json.markdown, /<details>/);
    assert.match(full.json.markdown, /#### 逐文件审查发现/);
    assert.match(full.json.markdown, /#### 总体初筛风险/);

    // Selection keeps only the chosen ids (unknown ids ignored), items list stays full.
    const selected = await plugin.call('/pr-review-api/comment/preview', 'POST', {
      number: 1,
      includeIds: ['b-keep01', 's-keep03', 'bogus-id'],
    });
    assert.equal(selected.status, 200);
    assert.equal(selected.json.items.length, 3);
    assert.match(selected.json.markdown, /问题一/);
    assert.doesNotMatch(selected.json.markdown, /问题二/);
    assert.match(selected.json.markdown, /建议一/);
    assert.match(selected.json.markdown, /`src\/a\.js:10`/);
    assert.match(selected.json.markdown, /`src\/a\.js:30`/);
    assert.match(selected.json.markdown, /- \[ \] 先修问题一/);
    // A partial selection says what it left out (never reads as "no blockers").
    assert.match(selected.json.markdown, /本次评论仅纳入 2\/3 条审查意见/);
    assert.match(selected.json.markdown, /本次评论未纳入 1 条阻塞项/);

    // Empty selection: no numbered items, but summary/verdict/nextSteps survive.
    const empty = await plugin.call('/pr-review-api/comment/preview', 'POST', { number: 1, includeIds: [] });
    assert.equal(empty.status, 200);
    assert.match(empty.json.markdown, /选择性发布结论/);
    assert.match(empty.json.markdown, /- \[ \] 先修问题一/);
    // The empty preview explains the exclusion instead of claiming "no blockers".
    assert.match(empty.json.markdown, /本次评论仅纳入 0\/3 条审查意见/);
    assert.match(empty.json.markdown, /本次评论未纳入 2 条阻塞项/);
    assert.match(empty.json.markdown, /本次评论未纳入 1 条修改建议/);
    assert.doesNotMatch(empty.json.markdown, /问题二|建议一/);
    assert.equal(sentBodies.length, 0);

    // Publishing honours the selection; publishedItems/itemCount follow what was posted.
    const first = await plugin.call('/pr-review-api/comment', 'POST', { number: 1, includeIds: ['b-keep01'] });
    assert.equal(first.status, 200);
    assert.equal(first.json.published[1].itemCount, 1);
    assert.match(sentBodies[0], /问题一/);
    assert.doesNotMatch(sentBodies[0], /问题二|建议一/);
    let reviewNow = await plugin.review();
    assert.equal(reviewNow.publishedItems.length, 1);
    assert.equal(reviewNow.publishedItems[0].id, 'b-keep01');
    assert.equal(reviewNow.publishedItems[0].line, 10);

    // Switching the selection does not change the version: still already-published without force.
    const duplicate = await plugin.call('/pr-review-api/comment', 'POST', { number: 1, includeIds: ['s-keep03'] });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.json.error.code, 'already-published');

    // force appends another comment with the new selection.
    const forced = await plugin.call('/pr-review-api/comment', 'POST', { number: 1, force: true, includeIds: ['s-keep03'] });
    assert.equal(forced.status, 200);
    assert.equal(forced.json.published.length, 3);
    assert.equal(forced.json.published[2].itemCount, 1);
    assert.match(sentBodies[1], /建议一/);
    assert.doesNotMatch(sentBodies[1], /^\d+\. .*问题一/m);
    assert.doesNotMatch(sentBodies[1], /问题二/);
    reviewNow = await plugin.review();
    assert.equal(reviewNow.publishedItems.length, 1);
    assert.equal(reviewNow.publishedItems[0].id, 's-keep03');

    // Publishing an empty selection is rejected: a comment with no items would mislead.
    const emptyPublish = await plugin.call('/pr-review-api/comment', 'POST', { number: 1, force: true, includeIds: [] });
    assert.equal(emptyPublish.status, 400);
    assert.equal(emptyPublish.json.error.code, 'empty-selection');
    assert.equal(sentBodies.length, 2);
  } finally {
    await plugin.dispose();
  }
});

test('English comment language for the publish preview', async () => {
  const plugin = await setup({
    commentLanguage: 'en',
    llm: llmFromText(JSON.stringify({ verdict: 'suggest', summary: 'ok', blockers: [], suggestions: [], nextSteps: [] })),
    fetch: async (url) => {
      if (String(url).includes('/pulls?state=open')) return jsonResponse(200, []);
      throw new Error(`unexpected fetch in test: ${String(url)}`);
    },
  });
  try {
    await plugin.call('/pr-review-api/conclude', 'POST', { number: 1 });
    await plugin.waitForConcluding();
    const preview = await plugin.call('/pr-review-api/comment/preview', 'POST', { number: 1 });
    assert.equal(preview.status, 200);
    assert.equal(preview.json.language, 'en');
    assert.match(preview.json.markdown, /Generated by DeepSeek harness PR review plugin/);
    assert.doesNotMatch(preview.json.markdown, /由 DeepSeek/);
  } finally {
    await plugin.dispose();
  }
});

test('human edit appends a human version and locks the edited item across regeneration', async () => {
  const plugin = await setup({
    llm: llmFromText(JSON.stringify({
      verdict: 'block',
      summary: '新结论',
      blockers: [{ file: 'src/a.js', point: '旧问题仍然存在' }],
      suggestions: [],
      nextSteps: ['修'],
    })),
  });
  try {
    await plugin.call('/pr-review-api/conclude', 'POST', { number: 1 });
    await plugin.waitForConcluding();
    const before = await plugin.review();
    const itemId = before.conclusion.blockers[0].id;

    // The overview chat edits blocker #1 → a human version + a locked id.
    plugin.llmState.handler = llmFromText(JSON.stringify({
      answer: '已按你的要求改写',
      suggestionOps: [{ op: 'update', target: 'blocker', index: 1, text: '人工改写后的阻塞项' }],
    }));
    const chat = await plugin.call('/pr-review-api/chat', 'POST', { number: 1, message: '改写第一条阻塞项' });
    assert.equal(chat.status, 200);
    assert.deepEqual(chat.json.applied, [{ op: 'update', target: 'blocker', index: 1 }]);

    let review = await plugin.review();
    const humanRound = review.roundHistory[0];
    assert.equal(humanRound.conclusions.length, 3);
    const humanVersion = humanRound.conclusions[2];
    assert.equal(humanVersion.source, 'human');
    assert.equal(humanVersion.conclusion.blockers[0].point, '人工改写后的阻塞项');
    assert.equal(humanVersion.conclusion.blockers[0].id, itemId);
    assert.deepEqual(review.humanItemIds, [itemId]);
    assert.ok(review.conclusionEditedAt > 0);
    assert.deepEqual(review.conclusion, humanVersion.conclusion);
    assert.equal(review.conclusionAt, humanVersion.createdAt);

    // The next model generation drops every blocker; the locked item must survive.
    plugin.llmState.handler = llmFromText(JSON.stringify({
      verdict: 'suggest',
      summary: '模型忘了旧条目',
      blockers: [],
      suggestions: [],
      nextSteps: [],
    }));
    await plugin.call('/pr-review-api/conclude', 'POST', { number: 1 });
    review = await plugin.waitForConcluding();
    assert.equal(review.roundHistory[0].conclusions.length, 4);
    const modelVersion = review.roundHistory[0].conclusions[3];
    assert.equal(modelVersion.source, 'model');
    assert.equal(modelVersion.conclusion.blockers.length, 1);
    assert.equal(modelVersion.conclusion.blockers[0].id, itemId);
    assert.equal(modelVersion.conclusion.blockers[0].point, '人工改写后的阻塞项');
  } finally {
    await plugin.dispose();
  }
});

test('autoReconclude regenerates in the background after the report is edited', async () => {
  const conclusionReply = JSON.stringify({
    verdict: 'suggest',
    summary: '自动重生成的结论',
    blockers: [],
    suggestions: [],
    nextSteps: [],
  });
  const chatReply = JSON.stringify({
    answer: '已更新风险',
    suggestionOps: [{ op: 'update', target: 'risk', index: 1, text: '改写后的风险一' }],
  });
  const plugin = await setup({ autoReconclude: true });
  try {
    // Answer chat prompts with the ops reply, conclusion prompts with the conclusion.
    plugin.llmState.handler = (streamOptions) => {
      const promptText = JSON.stringify(streamOptions.messages);
      return llmFromText(promptText.includes('作为合并前的最终审查结论') ? conclusionReply : chatReply)(streamOptions);
    };
    const chat = await plugin.call('/pr-review-api/chat', 'POST', { number: 1, message: '把第一条风险改一下' });
    assert.equal(chat.status, 200);
    assert.deepEqual(chat.json.applied, [{ op: 'update', target: 'risk', index: 1 }]);

    const review = await plugin.waitFor(1, (current) => current.roundHistory[0].conclusions.length >= 2);
    const latest = review.roundHistory[0].conclusions[review.roundHistory[0].conclusions.length - 1];
    assert.equal(latest.source, 'model');
    assert.equal(latest.conclusion.summary, '自动重生成的结论');
    assert.equal(review.concluding, null);
    assert.equal(review.report.risks[0].point, '改写后的风险一');
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
      'review_conclude',
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

    const files = await plugin.runTool('review_list_files');
    assert.match(files, /src\/a\.js/);
    assert.match(files, /已分析/);

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
  const plugin = await setup();
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
      issues: [{ point: '人写的问题', line: 3, severity: 'block' }],
      suggestions: [{ point: '改成分片读取', line: 5 }],
    });
    assert.match(written, /已更新分析/);
    assert.match(written, /revision 1/);
    assert.match(written, /意见 1 条 \/ 建议 1 条/);

    const stored = await plugin.review();
    assert.equal(stored.revision, 1);
    assert.equal(stored.explanations[0].explanation.summary, '改写后的结论');
    assert.equal(stored.explanations[0].explanation.issues[0].point, '人写的问题');
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

test('review_update_analysis writes with an optimistic lock and records audit', async () => {
  const plugin = await setup();
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
      issues: [{ point: '人写的问题', line: 3, severity: 'block' }],
      suggestions: [{ point: '改成分片读取', line: 5 }],
    });
    assert.match(written, /已更新分析/);
    assert.match(written, /revision 1/);
    assert.match(written, /意见 1 条 \/ 建议 1 条/);

    const stored = await plugin.review();
    assert.equal(stored.revision, 1);
    assert.equal(stored.explanations[0].explanation.summary, '改写后的结论');
    assert.equal(stored.explanations[0].explanation.issues[0].point, '人写的问题');
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

test('review_update_conclusion refuses when the round has no conclusion yet', async () => {
  const plugin = await setup({
    reviews: { 1: legacyReview({ conclusion: null, conclusionAt: 0 }) },
  });
  try {
    await assert.rejects(
      () => plugin.runTool('review_update_conclusion', { revision: 0, summary: 'x' }),
      /还没有最终结论/,
    );
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

test('review_conclude starts the background conclusion job', async () => {
  const plugin = await setup();
  try {
    const text = await plugin.runTool('review_conclude');
    assert.match(text, /已开始生成结论/);
    const settled = await plugin.waitForConcluding(1);
    assert.notEqual(settled, null);
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
    assert.match(written, /逐文件意见 0 条/);
    assert.match(written, /已清理/);

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

  // `suggestions` is the deprecated pre-merge alias: it now behaves like `suggest`.
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

test('clearOverviewFindings drops the legacy suggestions key review_update_analysis can write back', async () => {
  const plugin = await setup();
  try {
    // review_update_analysis still accepts the legacy `suggestions` parameter and writes
    // it straight into memory next to `issues` — exactly the pre-merge shape.
    await plugin.runTool('review_update_analysis', {
      path: 'src/a.js',
      revision: 0,
      verdict: 'block',
      summary: '人工改写',
      issues: [{ point: '阻塞意见', line: 1, severity: 'block' }],
      suggestions: [{ point: '模型后来补的建议', line: 2 }],
    });

    // Clearing everything must drop the key, not just hide the findings: otherwise every
    // reader folds the leftover suggestions straight back and the cleared count lies.
    const written = await plugin.runTool('review_update_overview', { revision: 1, clearFindings: 'all' });
    assert.match(written, /已清理：意见 2 条、风险 1 条/);

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
  const plugin = await setup({
    llm: llmFromText(JSON.stringify({ verdict: 'pass', summary: '结论', blockers: [], suggestions: [], nextSteps: [] })),
  });
  try {
    await plugin.call('/pr-review-api/conclude', 'POST', { number: 1 });
    await plugin.waitForConcluding();
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

test('duplicate explain requests for one file share a single model call', async () => {
  const diffText = [
    'diff --git a/src/a.js b/src/a.js',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1,2 +1,3 @@',
    ' line one',
    '-old',
    '+new',
    '+more',
  ].join('\n');
  const fetchHandler = async (url) => {
    const target = String(url);
    if (target.includes('/pulls?state=open')) return jsonResponse(200, []);
    if (target.includes('/pulls/1.diff')) return textResponse(200, diffText);
    if (target.includes('/contents/src/a.js')) {
      return jsonResponse(200, {
        path: 'src/a.js',
        encoding: 'base64',
        content: Buffer.from('line one\nnew\nmore\n', 'utf8').toString('base64'),
        size: 18,
      });
    }
    throw new Error(`unexpected fetch in test: ${target}`);
  };
  let modelCalls = 0;
  const llm = () => {
    modelCalls += 1;
    return (async function* () {
      await delay(60);
      yield {
        type: 'text-delta',
        text: JSON.stringify({ verdict: 'suggest', summary: '讲解', logic: '逻辑', issues: [], suggestions: [] }),
      };
      yield { type: 'finish', reason: { kind: 'stop' } };
    })();
  };
  const plugin = await setup({ fetch: fetchHandler, llm });
  try {
    const [first, second] = await Promise.all([
      plugin.call('/pr-review-api/explain', 'POST', { number: 1, path: 'src/a.js', force: true }),
      plugin.call('/pr-review-api/explain', 'POST', { number: 1, path: 'src/a.js', force: true }),
    ]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.deepEqual(first.json.explanation, second.json.explanation);
    assert.equal(modelCalls, 1, 'the second request awaited the in-flight call');
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

test('autoAnalyze explains every file of a finished round, one model call at a time', async () => {
  let active = 0;
  let peak = 0;
  const prompts = [];
  const llm = (options) => {
    const prompt = JSON.stringify(options.messages);
    if (!prompt.includes('正在审查文件')) return llmFromText('{}')(options);
    prompts.push(prompt);
    active += 1;
    peak = Math.max(peak, active);
    return (async function* () {
      try {
        await delay(200);
        yield { type: 'text-delta', text: BATCH_EXPLANATION };
        yield { type: 'finish', reason: { kind: 'stop' } };
      } finally {
        active -= 1;
      }
    })();
  };
  const plugin = await setup({ fetch: batchFetch, llm, reviews: { 1: unanalyzedReview() }, autoAnalyze: true });
  try {
    // The panel's first read starts the batch and reports it before the files finish.
    const started = await plugin.review();
    assert.notEqual(started.analyzing, null, 'the finished round starts a batch');
    assert.equal(started.analyzing.total, 2);

    const done = await plugin.waitFor(1, (current) => current.analyzing === null
      && (current.explanations ?? []).every((entry) => entry.status === 'done')
      && (current.explanations ?? []).length === 2);
    assert.deepEqual(done.explanations.map((entry) => entry.file).sort(), ['src/a.js', 'src/b.js']);
    assert.equal(prompts.length, 2, 'one model call per file');
    assert.equal(peak, 1, 'files are analyzed one at a time');
    assert.ok(prompts[0].includes('src/a.js'), 'the batch follows the file list order');
    assert.ok(prompts[1].includes('src/b.js'));
    assert.ok(prompts[0].includes('const a = 1'), 'each file gets its own full content');
    assert.ok(prompts[1].includes('完整内容不可用'), 'unreadable content falls back to the diff only');
  } finally {
    await plugin.dispose();
  }
});

test('autoAnalyze off leaves files untouched; the manual analyze route fills and retries them', async () => {
  let failOnce = true;
  const prompts = [];
  const llm = (options) => {
    const prompt = JSON.stringify(options.messages);
    if (!prompt.includes('正在审查文件')) return llmFromText('{}')(options);
    prompts.push(prompt);
    if (prompt.includes('src/b.js') && failOnce) {
      failOnce = false;
      return (async function* () {
        throw new Error('model exploded');
      })();
    }
    return llmFromText(BATCH_EXPLANATION)(options);
  };
  const plugin = await setup({ fetch: batchFetch, llm, reviews: { 1: unanalyzedReview() } });
  try {
    const idle = await plugin.review();
    assert.equal(idle.analyzing, null);
    assert.deepEqual(idle.explanations, []);
    await delay(60);
    const untouched = await plugin.review();
    assert.deepEqual(untouched.explanations, [], 'manual mode never analyzes on its own');
    assert.equal(prompts.length, 0);

    // The host serializes the setting so the panel knows to offer the button.
    const prs = await plugin.call('/pr-review-api/prs');
    assert.equal(prs.json.autoAnalyze, false);

    const started = await plugin.call('/pr-review-api/analyze', 'POST', { number: 1 });
    assert.equal(started.status, 200);
    assert.equal(started.json.started, true);

    const firstPass = await plugin.waitFor(1, (current) => current.analyzing === null
      && (current.explanations ?? []).length === 2);
    const byFile = new Map(firstPass.explanations.map((entry) => [entry.file, entry]));
    assert.equal(byFile.get('src/a.js').status, 'done');
    assert.equal(byFile.get('src/b.js').status, 'error');
    assert.match(byFile.get('src/b.js').error, /model exploded/);

    const retried = await plugin.call('/pr-review-api/analyze', 'POST', { number: 1 });
    assert.equal(retried.json.started, true);
    await plugin.waitFor(1, (current) => current.analyzing === null
      && (current.explanations ?? []).length === 2
      && (current.explanations ?? []).every((entry) => entry.status === 'done'));
    assert.equal(prompts.filter((prompt) => prompt.includes('src/b.js')).length, 2, 'the failed file is retried');
    assert.equal(prompts.filter((prompt) => prompt.includes('src/a.js')).length, 1, 'a finished file is not paid for twice');
  } finally {
    await plugin.dispose();
  }
});

test('a new round cancels the batch and drops its in-flight answer', async () => {
  const reportReply = JSON.stringify({
    verdict: 'suggest',
    summary: '第二轮报告',
    risks: [],
    order: [{ file: 'src/a.js', reason: '' }, { file: 'src/b.js', reason: '' }],
    focus: {},
  });
  let aborted = false;
  const explainPrompts = [];
  const llm = (options) => {
    const prompt = JSON.stringify(options.messages);
    if (!prompt.includes('正在审查文件')) return llmFromText(reportReply)(options);
    explainPrompts.push(prompt);
    // llmSlow rejects on abort; record it so the test can prove the call was cancelled,
    // not merely ignored after it finished.
    options.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    return llmSlow(200, BATCH_EXPLANATION)(options);
  };
  const plugin = await setup({ fetch: roundReviewFetch, llm, reviews: { 1: unanalyzedReview() } });
  try {
    const started = await plugin.call('/pr-review-api/analyze', 'POST', { number: 1 });
    assert.equal(started.json.started, true);
    await delay(30);

    const forced = await plugin.call('/pr-review-api/review', 'POST', { number: 1, force: true });
    assert.equal(forced.status, 200);
    await plugin.waitFor(1, (current) => current.round === 2 && current.status === 'done' && current.analyzing === null);
    // Let the rejected round-1 call settle.
    await delay(50);
    // This test covers the abort path only (the provider rejects on the signal). The
    // epoch-only paths — a provider that ignores the abort, and a manual explain that
    // holds no signal — are covered by the two tests below.
    assert.equal(aborted, true, 'the round-1 model call was aborted, not left running');
    assert.equal(explainPrompts.length, 1, 'the batch stopped instead of starting the next file');

    const after = await plugin.review();
    assert.equal(after.round, 2);
    assert.deepEqual(after.explanations, [], 'the round-1 answer did not land in round 2');
    assert.equal(after.analyzing, null);
  } finally {
    await plugin.dispose();
  }
});

test('a fresh explain for the new round does not join the stale in-flight call', async () => {
  const reportReply = JSON.stringify({
    verdict: 'suggest',
    summary: '第二轮报告',
    risks: [],
    order: [{ file: 'src/a.js', reason: '' }, { file: 'src/b.js', reason: '' }],
    focus: {},
  });
  let explains = 0;
  const llm = (options) => {
    const prompt = JSON.stringify(options.messages);
    if (!prompt.includes('正在审查文件')) return llmFromText(reportReply)(options);
    explains += 1;
    return (async function* () {
      await delay(150);
      yield { type: 'text-delta', text: BATCH_EXPLANATION };
      yield { type: 'finish', reason: { kind: 'stop' } };
    })();
  };
  const plugin = await setup({ fetch: roundReviewFetch, llm, reviews: { 1: unanalyzedReview() } });
  try {
    await plugin.call('/pr-review-api/analyze', 'POST', { number: 1 });
    await delay(30);

    // The round-1 answer for src/a.js is still in flight when round 2 starts.
    await plugin.call('/pr-review-api/review', 'POST', { number: 1, force: true });
    await plugin.waitFor(1, (current) => current.round === 2 && current.status === 'done');

    const asked = await plugin.call('/pr-review-api/explain', 'POST', { number: 1, path: 'src/a.js' });
    assert.equal(asked.status, 200);
    assert.notEqual(asked.json.explanation, null, 'the new round answered instead of reusing the discarded call');
    const done = await plugin.waitFor(1, (current) => (current.explanations ?? []).some(
      (entry) => entry.file === 'src/a.js' && entry.status === 'done',
    ));
    assert.equal(done.round, 2);
    assert.equal(explains, 2, 'the new round paid for its own model call');
  } finally {
    await plugin.dispose();
  }
});

test('a cancelled call cannot write into the new round even if the provider ignores the abort', async () => {
  const reportReply = JSON.stringify({
    verdict: 'suggest',
    summary: '第二轮报告',
    risks: [],
    order: [{ file: 'src/a.js', reason: '' }, { file: 'src/b.js', reason: '' }],
    focus: {},
  });
  const llm = (options) => {
    const prompt = JSON.stringify(options.messages);
    if (!prompt.includes('正在审查文件')) return llmFromText(reportReply)(options);
    // The fake stream never reads options.signal: the cancellation contract inside
    // callModel (plus the discarded-result check) has to drop this late text.
    return (async function* () {
      await delay(150);
      yield { type: 'text-delta', text: BATCH_EXPLANATION };
      yield { type: 'finish', reason: { kind: 'stop' } };
    })();
  };
  const plugin = await setup({ fetch: roundReviewFetch, llm, reviews: { 1: unanalyzedReview() } });
  try {
    await plugin.call('/pr-review-api/analyze', 'POST', { number: 1 });
    await delay(30);
    await plugin.call('/pr-review-api/review', 'POST', { number: 1, force: true });
    await plugin.waitFor(1, (current) => current.round === 2 && current.status === 'done');
    // Let the answer the provider still sends arrive after the round was cleared.
    await delay(300);

    const after = await plugin.review();
    assert.equal(after.round, 2);
    assert.deepEqual(after.explanations, [], 'the late answer never reached the new round');
  } finally {
    await plugin.dispose();
  }
});

test('a manual explain in flight is discarded when a new round starts', async () => {
  const reportReply = JSON.stringify({
    verdict: 'suggest',
    summary: '第二轮报告',
    risks: [],
    order: [{ file: 'src/a.js', reason: '' }, { file: 'src/b.js', reason: '' }],
    focus: {},
  });
  const llm = (options) => {
    const prompt = JSON.stringify(options.messages);
    if (!prompt.includes('正在审查文件')) return llmFromText(reportReply)(options);
    return (async function* () {
      await delay(150);
      yield { type: 'text-delta', text: BATCH_EXPLANATION };
      yield { type: 'finish', reason: { kind: 'stop' } };
    })();
  };
  const plugin = await setup({ fetch: roundReviewFetch, llm, reviews: { 1: unanalyzedReview() } });
  try {
    // A click-driven explain holds no batch job and no signal; only the epoch can stop it.
    const pending = plugin.call('/pr-review-api/explain', 'POST', { number: 1, path: 'src/a.js' });
    await delay(30);
    await plugin.call('/pr-review-api/review', 'POST', { number: 1, force: true });
    const answer = await pending;
    assert.equal(answer.status, 200);
    assert.equal(answer.json.explanation, null, 'the stale manual answer was discarded');

    await plugin.waitFor(1, (current) => current.round === 2 && current.status === 'done');
    await delay(200);
    const after = await plugin.review();
    assert.deepEqual(after.explanations, [], 'the manual answer did not land in the new round');
  } finally {
    await plugin.dispose();
  }
});

test('a new round reads the new head instead of the cached file content', async () => {
  const reportReply = JSON.stringify({
    verdict: 'suggest',
    summary: '第二轮报告',
    risks: [],
    order: [{ file: 'src/a.js', reason: '' }],
    focus: {},
  });
  const prompts = [];
  const fetchHandler = async (url) => {
    const target = String(url);
    if (target.includes('/pulls?state=open')) return jsonResponse(200, []);
    if (target.includes('/pulls/1.diff')) return textResponse(200, BATCH_DIFF);
    if (target.includes('/pulls/1/files')) {
      return jsonResponse(200, [{ filename: 'src/a.js', status: 'modified', additions: 1, deletions: 1, changes: 2 }]);
    }
    if (target.includes('/contents/')) {
      const ref = /[?&]ref=([^&]+)/.exec(target)?.[1] ?? '';
      const body = ref === 'sha-two' ? 'const fresh = 2;\n' : 'const old = 1;\n';
      return jsonResponse(200, { encoding: 'base64', content: Buffer.from(body, 'utf8').toString('base64'), size: body.length });
    }
    if (/\/pulls\/1$/.test(target)) {
      return jsonResponse(200, {
        number: 1,
        title: 'PR 标题',
        body: '',
        user: { login: 'dev' },
        state: 'open',
        merged: false,
        additions: 1,
        deletions: 1,
        changed_files: 1,
        head: { ref: 'feature', sha: 'sha-two' },
        base: { ref: 'main', sha: 'def456' },
        html_url: 'https://git.example/acme/demo/pulls/1',
      });
    }
    throw new Error(`unexpected fetch in test: ${target}`);
  };
  const llm = (options) => {
    const prompt = JSON.stringify(options.messages);
    if (!prompt.includes('正在审查文件')) return llmFromText(reportReply)(options);
    prompts.push(prompt);
    return llmFromText(BATCH_EXPLANATION)(options);
  };
  const plugin = await setup({ fetch: fetchHandler, llm, reviews: { 1: unanalyzedReview() } });
  try {
    // Round 1 reads the old head and caches its content.
    await plugin.call('/pr-review-api/explain', 'POST', { number: 1, path: 'src/a.js' });
    assert.ok(prompts[0].includes('const old = 1'));

    await plugin.call('/pr-review-api/review', 'POST', { number: 1, force: true });
    await plugin.waitFor(1, (current) => current.round === 2 && current.status === 'done');

    await plugin.call('/pr-review-api/explain', 'POST', { number: 1, path: 'src/a.js' });
    assert.ok(prompts[1].includes('const fresh = 2'), 'the new round read the new head');
    assert.equal(prompts[1].includes('const old = 1'), false, 'the previous head stayed cached');
  } finally {
    await plugin.dispose();
  }
});

test('a stale malformed answer is discarded instead of reported as a failure', async () => {
  const reportReply = JSON.stringify({
    verdict: 'suggest',
    summary: '第二轮报告',
    risks: [],
    order: [{ file: 'src/a.js', reason: '' }],
    focus: {},
  });
  const llm = (options) => {
    const prompt = JSON.stringify(options.messages);
    if (!prompt.includes('正在审查文件')) return llmFromText(reportReply)(options);
    return (async function* () {
      await delay(120);
      yield { type: 'text-delta', text: 'not json' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    })();
  };
  const plugin = await setup({ fetch: roundReviewFetch, llm, reviews: { 1: unanalyzedReview() } });
  try {
    const pending = plugin.call('/pr-review-api/explain', 'POST', { number: 1, path: 'src/a.js' });
    await delay(30);
    await plugin.call('/pr-review-api/review', 'POST', { number: 1, force: true });
    const answer = await pending;
    assert.equal(answer.status, 200, 'a stale parse failure is not a failure of the new round');
    assert.equal(answer.json.explanation, null);

    await plugin.waitFor(1, (current) => current.round === 2 && current.status === 'done');
    const after = await plugin.review();
    assert.deepEqual(after.explanations, []);
  } finally {
    await plugin.dispose();
  }
});

test('an automatic batch continues past a failed file and never retries it on polls', async () => {
  let explainCalls = 0;
  const llm = (options) => {
    const prompt = JSON.stringify(options.messages);
    if (!prompt.includes('正在审查文件')) return llmFromText('{}')(options);
    explainCalls += 1;
    if (prompt.includes('src/b.js')) {
      return (async function* () {
        throw new Error('boom');
      })();
    }
    return llmFromText(BATCH_EXPLANATION)(options);
  };
  const plugin = await setup({ fetch: batchFetch, llm, reviews: { 1: unanalyzedReview() }, autoAnalyze: true });
  try {
    const done = await plugin.waitFor(1, (current) => current.analyzing === null
      && (current.explanations ?? []).length === 2);
    const byFile = new Map(done.explanations.map((entry) => [entry.file, entry]));
    assert.equal(byFile.get('src/a.js').status, 'done', 'the batch kept going after the failure');
    assert.equal(byFile.get('src/b.js').status, 'error');
    assert.match(byFile.get('src/b.js').error, /boom/);

    // The panel keeps polling; the automatic path must not retry the failed file.
    const before = explainCalls;
    await plugin.review();
    await plugin.review();
    await delay(50);
    assert.equal(explainCalls, before, 'an error entry is left for the manual retry');
  } finally {
    await plugin.dispose();
  }
});

test('the schema default turns batch analysis on without an explicit option', async () => {
  const llm = (options) => (
    JSON.stringify(options.messages).includes('正在审查文件')
      ? llmFromText(BATCH_EXPLANATION)(options)
      : llmFromText('{}')(options)
  );
  const plugin = await setup({
    fetch: batchFetch,
    llm,
    reviews: { 1: unanalyzedReview() },
    useDefaultAutoAnalyze: true,
  });
  try {
    // The panel is told the effective default too, so manual mode and the button agree.
    const prs = await plugin.call('/pr-review-api/prs');
    assert.equal(prs.json.autoAnalyze, true);

    const done = await plugin.waitFor(1, (current) => current.analyzing === null
      && (current.explanations ?? []).length === 2
      && (current.explanations ?? []).every((entry) => entry.status === 'done'));
    assert.deepEqual(done.explanations.map((entry) => entry.file).sort(), ['src/a.js', 'src/b.js']);
  } finally {
    await plugin.dispose();
  }
});

test('a restored entry without an explanation is analyzed again', async () => {
  const restored = legacyReview({
    files: [{ path: 'src/a.js', previousPath: '', status: 'modified', additions: 1, deletions: 0, changes: 1 }],
    // Legacy caches can carry `done` with a null body; it is not an analysis yet.
    explanations: [{ file: 'src/a.js', status: 'done', error: null, explanation: null, chat: [], updatedAt: 150 }],
  });
  const llm = (options) => (
    JSON.stringify(options.messages).includes('正在审查文件')
      ? llmFromText(BATCH_EXPLANATION)(options)
      : llmFromText('{}')(options)
  );
  const plugin = await setup({ fetch: batchFetch, llm, reviews: { 1: restored }, autoAnalyze: true });
  try {
    const done = await plugin.waitFor(1, (current) => (current.explanations ?? []).some(
      (entry) => entry.file === 'src/a.js' && entry.status === 'done' && entry.explanation !== null,
    ));
    assert.equal(done.analyzing, null);
  } finally {
    await plugin.dispose();
  }
});

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
        unverified: [],
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

test('failed batches release their analysis slots for later batches', async () => {
  const llm = (options) => {
    const prompt = JSON.stringify(options.messages);
    if (!prompt.includes('正在审查文件')) return llmFromText('{}')(options);
    if (prompt.includes('PR #1：') || prompt.includes('PR #2：')) {
      return (async function* () {
        throw new Error('model exploded');
      })();
    }
    return llmFromText(BATCH_EXPLANATION)(options);
  };
  const plugin = await setup({
    fetch: multiPrFetch,
    llm,
    reviews: { 1: unanalyzedPr(1), 2: unanalyzedPr(2), 3: unanalyzedPr(3) },
  });
  try {
    await plugin.call('/pr-review-api/analyze', 'POST', { number: 1 });
    await plugin.call('/pr-review-api/analyze', 'POST', { number: 2 });
    // Both batches only finish if every rejected call gave its slot back; a leak would
    // starve them (and the third batch below) at the two-slot ceiling.
    await plugin.waitFor(1, (current) => current.analyzing === null && (current.explanations ?? []).length === 2);
    await plugin.waitFor(2, (current) => current.analyzing === null && (current.explanations ?? []).length === 2);

    await plugin.call('/pr-review-api/analyze', 'POST', { number: 3 });
    const done = await plugin.waitFor(3, (current) => current.analyzing === null
      && (current.explanations ?? []).length === 2
      && (current.explanations ?? []).every((entry) => entry.status === 'done'));
    assert.equal(done.explanations.length, 2);
  } finally {
    await plugin.dispose();
  }
});

test('aborted batches release their analysis slots for later batches', async () => {
  const reportReply = JSON.stringify({
    verdict: 'suggest',
    summary: '报告',
    risks: [],
    order: [{ file: 'src/a.js', reason: '' }, { file: 'src/b.js', reason: '' }],
    focus: {},
  });
  let analyzeThird = false;
  const llm = (options) => {
    const prompt = JSON.stringify(options.messages);
    if (!prompt.includes('正在审查文件')) return llmFromText(reportReply)(options);
    if (analyzeThird && prompt.includes('PR #3：')) return llmFromText(BATCH_EXPLANATION)(options);
    return llmSlow(10_000, BATCH_EXPLANATION)(options);
  };
  const plugin = await setup({
    fetch: multiPrFetch,
    llm,
    reviews: { 1: unanalyzedPr(1), 2: unanalyzedPr(2), 3: unanalyzedPr(3) },
  });
  try {
    await plugin.call('/pr-review-api/analyze', 'POST', { number: 1 });
    await plugin.call('/pr-review-api/analyze', 'POST', { number: 2 });
    // Both calls are in flight and hold the two slots when the rounds roll.
    await delay(50);
    await plugin.call('/pr-review-api/review', 'POST', { number: 1, force: true });
    await plugin.call('/pr-review-api/review', 'POST', { number: 2, force: true });
    await plugin.waitFor(1, (current) => current.round === 2 && current.status === 'done');
    await plugin.waitFor(2, (current) => current.round === 2 && current.status === 'done');

    analyzeThird = true;
    await plugin.call('/pr-review-api/analyze', 'POST', { number: 3 });
    const done = await plugin.waitFor(3, (current) => current.analyzing === null
      && (current.explanations ?? []).length === 2
      && (current.explanations ?? []).every((entry) => entry.status === 'done'));
    assert.equal(done.explanations.length, 2);
  } finally {
    await plugin.dispose();
  }
});

test('the analysis slot ceiling caps concurrent model calls at two', async () => {
  let active = 0;
  let peak = 0;
  const llm = (options) => {
    const prompt = JSON.stringify(options.messages);
    if (!prompt.includes('正在审查文件')) return llmFromText('{}')(options);
    active += 1;
    peak = Math.max(peak, active);
    return (async function* () {
      try {
        await delay(60);
        yield { type: 'text-delta', text: BATCH_EXPLANATION };
        yield { type: 'finish', reason: { kind: 'stop' } };
      } finally {
        active -= 1;
      }
    })();
  };
  const plugin = await setup({
    fetch: multiPrFetch,
    llm,
    reviews: { 1: unanalyzedPr(1), 2: unanalyzedPr(2), 3: unanalyzedPr(3), 4: unanalyzedPr(4) },
  });
  try {
    for (const number of [1, 2, 3, 4]) {
      const started = await plugin.call('/pr-review-api/analyze', 'POST', { number });
      assert.equal(started.json.started, true);
    }
    for (const number of [1, 2, 3, 4]) {
      await plugin.waitFor(number, (current) => current.analyzing === null
        && (current.explanations ?? []).length === 2
        && (current.explanations ?? []).every((entry) => entry.status === 'done'), 8000);
    }
    assert.equal(peak, 2, 'four batches never exceed the two-slot ceiling');
  } finally {
    await plugin.dispose();
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

test('a concern becomes a finding only after the verifier scores it against evidence', async () => {
  const prompts = [];
  const answers = llmTriageThenVerify({
    verdict: 'suggest',
    summary: '讲解',
    logic: '逻辑',
    changes: '改动',
    concerns: [
      { severity: 'block', point: '空指针风险', suggestion: '先判空再取值', line: 2 },
      { severity: 'suggest', point: '命名不清', suggestion: '改成 camelCase', line: 4 },
    ],
    evidenceNeeds: [
      { concern: 1, kind: 'file', path: 'src/a.js' },
      { concern: 2, kind: 'file', path: 'src/a.js' },
    ],
  }, {
    results: [
      { index: 1, confidence: 90, severity: 'block', point: '空指针风险', line: 2, suggestion: '取值前加空值检查' },
      { index: 2, confidence: 85, point: '命名不清', line: 4 },
    ],
    extraIssues: [],
  });
  const recording = (options) => {
    prompts.push(promptTextOf(options));
    return answers(options);
  };
  const plugin = await setup({ fetch: batchFetch, llm: recording });
  try {
    const result = await plugin.call('/pr-review-api/explain', 'POST', { number: 1, path: 'src/a.js', force: true });
    assert.equal(result.status, 200);
    // The verifier's suggestion rewrite wins; a result without one falls back to the candidate's.
    assert.deepEqual(result.json.explanation.issues, [
      { severity: 'block', point: '空指针风险', suggestion: '取值前加空值检查', line: 2 },
      { severity: 'suggest', point: '命名不清', suggestion: '改成 camelCase', line: 4 },
    ]);
    assert.deepEqual(result.json.explanation.unverified, []);
    assert.equal(prompts.length, 2, 'triage + verifier');
    assert.match(prompts[1], /## 候选问题/);
    assert.match(prompts[1], /## 证据 1：src\/a\.js/);
  } finally {
    await plugin.dispose();
  }
});

test('a verifier that returns junk turns every concern into an unverified note', async () => {
  const plugin = await setup({
    fetch: batchFetch,
    llm: llmTriageThenVerify({
      verdict: 'suggest',
      summary: '讲解',
      logic: '逻辑',
      changes: '改动',
      concerns: [{ severity: 'block', point: '可疑空指针', line: 3 }],
      evidenceNeeds: [{ concern: 1, kind: 'file', path: 'src/a.js' }],
      suggestions: [],
    }, 'not json at all'),
  });
  try {
    const result = await plugin.call('/pr-review-api/explain', 'POST', { number: 1, path: 'src/a.js', force: true });
    assert.equal(result.status, 200);
    assert.deepEqual(result.json.explanation.issues, []);
    assert.deepEqual(result.json.explanation.unverified, [
      { point: '可疑空指针', missing: '复审未完成：模型没有返回可解析的 JSON' },
    ]);
  } finally {
    await plugin.dispose();
  }
});

test('evidenceVerify off keeps the single-pass contract', async () => {
  let calls = 0;
  const plugin = await setup({
    fetch: batchFetch,
    evidenceVerify: false,
    llm: () => (async function* () {
      calls += 1;
      yield {
        type: 'text-delta',
        text: JSON.stringify({
          verdict: 'suggest',
          summary: '讲解',
          logic: '逻辑',
          changes: '改动',
          concerns: [{ severity: 'suggest', point: '命名不清', suggestion: '改成 camelCase', line: 4 }],
          evidenceNeeds: [],
          // A model that has not caught up with the merged prompt still answers with the
          // legacy suggestions list; it folds into the tail of issues.
          suggestions: ['补一条测试'],
        }),
      };
      yield { type: 'finish', reason: { kind: 'stop' } };
    })(),
  });
  try {
    const result = await plugin.call('/pr-review-api/explain', 'POST', { number: 1, path: 'src/a.js', force: true });
    assert.equal(calls, 1, 'no verifier call when evidenceVerify is off');
    assert.deepEqual(result.json.explanation.issues, [
      { severity: 'suggest', point: '命名不清', suggestion: '改成 camelCase', line: 4 },
      { severity: 'suggest', point: '补一条测试', suggestion: '', line: 0 },
    ]);
    assert.deepEqual(result.json.explanation.unverified, []);
  } finally {
    await plugin.dispose();
  }
});

test('the report verifier decides risks; unconfirmed points stay out of risks', async () => {
  const plugin = await setup({
    fetch: roundReviewFetch,
    reviews: { 1: unanalyzedReview() },
    llm: llmTriageThenVerify({
      verdict: 'suggest',
      summary: '报告',
      concerns: [
        { severity: 'block', file: 'src/a.js', point: '并发写入' },
        { severity: 'suggest', file: 'src/b.js', point: '命名不清' },
      ],
      evidenceNeeds: [
        { concern: 1, kind: 'file', path: 'src/a.js' },
        { concern: 2, kind: 'file', path: 'src/b.js' },
      ],
      order: [],
      focus: [],
    }, {
      results: [
        { index: 1, confidence: 88, severity: 'block', point: '并发写入' },
        { index: 2, confidence: 40, point: '命名不清', missing: '缺调用方' },
      ],
      extraIssues: [],
    }),
  });
  try {
    await plugin.call('/pr-review-api/review', 'POST', { number: 1, force: true });
    const review = await plugin.waitFor(1, (current) => current.status === 'done' && current.report !== null);
    assert.deepEqual(review.report.risks, [{ severity: 'block', file: 'src/a.js', point: '并发写入' }]);
    assert.deepEqual(review.report.unverified, [{ point: '命名不清', missing: '缺调用方' }]);
    assert.equal(review.report.verdict, 'block', 'a confirmed blocker outranks the triage verdict');
  } finally {
    await plugin.dispose();
  }
});

test('an answer in prose is retried once as JSON instead of failing the round', async () => {
  let calls = 0;
  const requests = [];
  const plugin = await setup({
    fetch: batchFetch,
    llm: (options) => {
      requests.push(options);
      return (async function* () {
        calls += 1;
        const text = calls === 1
          ? '## 审查结论\n\n这是一段分析，不是 JSON。'
          : JSON.stringify({
              verdict: 'suggest',
              summary: '讲解',
              logic: '逻辑',
              changes: '改动',
              concerns: [],
              evidenceNeeds: [],
              suggestions: [],
            });
        yield { type: 'text-delta', text };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  });
  try {
    const result = await plugin.call('/pr-review-api/explain', 'POST', { number: 1, path: 'src/a.js', force: true });
    assert.equal(result.status, 200);
    assert.equal(result.json.explanation.summary, '讲解');
    assert.equal(calls, 2, 'the corrective turn ran once');
    assert.deepEqual(result.json.explanation.issues, []);
    // The Host's LLM runtime cannot replay assistant history without finish.replayState,
    // so the correction must echo the bad answer inside a user turn.
    assert.ok(requests[1].messages.every((message) => message.role !== 'assistant'));
    assert.match(JSON.stringify(requests[1].messages), /不是合法的、完整的 JSON/);
  } finally {
    await plugin.dispose();
  }
});

test('a stub report JSON is retried, then fails the round instead of showing an empty report', async () => {
  let calls = 0;
  const plugin = await setup({
    fetch: roundReviewFetch,
    reviews: { 1: unanalyzedReview() },
    llm: () => {
      calls += 1;
      return (async function* () {
        yield { type: 'text-delta', text: JSON.stringify({ verdict: 'suggest' }) };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  });
  try {
    await plugin.call('/pr-review-api/review', 'POST', { number: 1, force: true });
    const review = await plugin.waitFor(1, (current) => current.status === 'error');
    assert.match(review.error, /完整的报告 JSON/);
    assert.equal(calls, 2, 'the corrective turn ran once');
  } finally {
    await plugin.dispose();
  }
});

test('the report records how many triage concerns the verifier discarded', async () => {
  const plugin = await setup({
    fetch: roundReviewFetch,
    reviews: { 1: unanalyzedReview() },
    llm: llmTriageThenVerify({
      verdict: 'suggest',
      summary: '报告',
      concerns: [{ severity: 'suggest', file: 'src/a.js', point: '可能是误报' }],
      evidenceNeeds: [{ concern: 1, kind: 'file', path: 'src/a.js' }],
      order: [],
      focus: [],
    }, {
      results: [{ index: 1, confidence: 10, point: '可能是误报' }],
      extraIssues: [],
    }),
  });
  try {
    await plugin.call('/pr-review-api/review', 'POST', { number: 1, force: true });
    const review = await plugin.waitFor(1, (current) => current.status === 'done' && current.report !== null);
    assert.deepEqual(review.report.risks, []);
    assert.equal(review.report.raised, 1);
    assert.equal(review.report.discarded, 1);
  } finally {
    await plugin.dispose();
  }
});

test('evidence blocks say which lines they show', async () => {
  const longFile = Array.from({ length: 300 }, (_, index) => `line ${index + 1}`).join('\n');
  const fetchHandler = async (url) => {
    const target = String(url);
    if (target.includes('/pulls?state=open')) return jsonResponse(200, []);
    if (target.includes('/pulls/1.diff')) return textResponse(200, BATCH_DIFF);
    if (target.includes('/contents/')) {
      return jsonResponse(200, {
        encoding: 'base64',
        content: Buffer.from(longFile, 'utf8').toString('base64'),
        size: longFile.length,
      });
    }
    throw new Error(`unexpected fetch in test: ${target}`);
  };
  const prompts = [];
  const answers = llmTriageThenVerify({
    verdict: 'suggest',
    summary: '讲解',
    logic: '逻辑',
    changes: '改动',
    concerns: [{ severity: 'suggest', point: '长文件里的问题', line: 250 }],
    evidenceNeeds: [{ concern: 1, kind: 'file', path: 'src/a.js' }],
    suggestions: [],
  }, {
    results: [{ index: 1, confidence: 85, point: '长文件里的问题', line: 250 }],
    extraIssues: [],
  });
  const plugin = await setup({
    fetch: fetchHandler,
    llm: (options) => {
      prompts.push(promptTextOf(options));
      return answers(options);
    },
  });
  try {
    const result = await plugin.call('/pr-review-api/explain', 'POST', { number: 1, path: 'src/a.js', force: true });
    assert.equal(result.status, 200);
    assert.match(prompts[1], /前 200 行（共 300 行）/);
  } finally {
    await plugin.dispose();
  }
});

test('a suggestion the diff already implements is dropped by the verifier', async () => {
  const plugin = await setup({
    fetch: batchFetch,
    llm: llmTriageThenVerify({
      verdict: 'suggest',
      summary: '讲解',
      logic: '逻辑',
      changes: '改动',
      // Pure-improvement noise now travels as a suggest-level concern carrying its own
      // suggestion; the verifier's confidence scoring is what filters it out.
      concerns: [{ severity: 'suggest', point: '补齐三行配置', suggestion: '在配置里补齐三行', line: 3 }],
      evidenceNeeds: [{ concern: 1, kind: 'file', path: 'src/a.js' }],
    }, {
      results: [{ index: 1, confidence: 10, point: '补齐三行配置' }],
      extraIssues: [],
    }),
  });
  try {
    const result = await plugin.call('/pr-review-api/explain', 'POST', { number: 1, path: 'src/a.js', force: true });
    assert.equal(result.status, 200);
    assert.deepEqual(result.json.explanation.issues, []);
    assert.deepEqual(result.json.explanation.unverified, []);
  } finally {
    await plugin.dispose();
  }
});

test('a confirmed blocker raises the file verdict', async () => {
  const plugin = await setup({
    fetch: batchFetch,
    llm: llmTriageThenVerify({
      verdict: 'pass',
      summary: '讲解',
      logic: '逻辑',
      changes: '改动',
      concerns: [{ severity: 'suggest', point: '空指针风险', line: 2 }],
      evidenceNeeds: [{ concern: 1, kind: 'file', path: 'src/a.js' }],
      suggestions: [],
    }, {
      results: [{ index: 1, confidence: 90, severity: 'block', point: '空指针风险', line: 2 }],
      extraIssues: [],
    }),
  });
  try {
    const result = await plugin.call('/pr-review-api/explain', 'POST', { number: 1, path: 'src/a.js', force: true });
    assert.equal(result.json.explanation.verdict, 'block');
  } finally {
    await plugin.dispose();
  }
});

test('a verifier reply with no results leaves every candidate visible', async () => {
  const plugin = await setup({
    fetch: batchFetch,
    llm: llmTriageThenVerify({
      verdict: 'suggest',
      summary: '讲解',
      logic: '逻辑',
      changes: '改动',
      concerns: [{ severity: 'suggest', point: '空指针风险', line: 2 }],
      evidenceNeeds: [{ concern: 1, kind: 'file', path: 'src/a.js' }],
      suggestions: [],
    }, {}),
  });
  try {
    const result = await plugin.call('/pr-review-api/explain', 'POST', { number: 1, path: 'src/a.js', force: true });
    assert.deepEqual(result.json.explanation.issues, []);
    assert.deepEqual(result.json.explanation.unverified, [
      { point: '空指针风险', missing: '复审未返回该候选的判定' },
    ]);
  } finally {
    await plugin.dispose();
  }
});

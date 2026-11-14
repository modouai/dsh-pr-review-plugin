/**
 * Browser-half (client.js) tests for the conclusion-history contract (§4).
 *
 * client.js is a browser module that registers itself through `window.__ModuleLoader__`,
 * so these tests evaluate it inside a `node:vm` sandbox with a minimal fake `window` and a
 * fake React (createElement + one-pass hook rendering). No DOM, no extra dependencies.
 *
 * The fake React renders each component once (like SSR): effects do not run, state setters
 * are no-ops and `useMemo` recomputes. That is enough to assert structure, text and the
 * click/change handlers that the components expose.
 *
 * Run with: node --test tests/client.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const CLIENT_URL = new URL('../client.js', import.meta.url);

/** Where the plugin factory returns its public module; tests splice a `__parts` export in. */
const EXPORT_MARKER = "    return {\n      inject: ['slots'],\n      apply(ctx) {";

/** Internals the tests need; every name must exist in the client factory scope. */
const EXPOSED = [
  'DICT',
  'CSS',
  'api',
  'OverviewPanel',
  'FeedbackBlock',
  'renderMarkdown',
  'inlineMarkdown',
  'ReviewDock',
  'DockNotice',
  'EmbeddedFooter',
  'ReviewWorkspace',
  'clampColumnWidth',
  'actionsBridge',
  'overviewFooter',
  'versionsOf',
  'staleInfoOf',
  'RoundPills',
  'TopBar',
  'applyRoundSelection',
  'sidebarReviewAddress',
  'parseSidebarReviewAddress',
  'ReviewEntry',
  'requestReviewTab',
  'mountedSessionStore',
  'reviewAskContext',
  'isRoundVersionPublished',
  'VersionSelector',
  'PublishPreviewModal',
  'DetailHeader',
  'FilesPane',
  'ConclusionBlock',
  'DiffView',
  'roundsOf',
  'fileLineLabel',
  'previewItemsOf',
  'previewSelectionSupported',
  'buildPreviewBody',
  'buildPublishBody',
  'selectionIncludeIds',
  'scrollToNewLine',
];

// ---------- fake React ----------

/**
 * Minimal React replacement. Elements are plain objects; components are invoked once with a
 * per-component hook frame. `render` returns the expanded tree, its markup, its visible text
 * and every element node (so tests can invoke handlers).
 */
function createFakeReact() {
  const Fragment = Symbol('prr.fragment');
  const hookStack = [];
  const noop = () => {};

  function createElement(type, props, ...children) {
    const next = { ...(props ?? {}) };
    if (children.length === 1) next.children = children[0];
    else if (children.length > 1) next.children = children;
    return { type, props: next };
  }

  function currentFrame() {
    const frame = hookStack[hookStack.length - 1];
    if (frame === undefined) throw new Error('hook called outside a component render');
    return frame;
  }

  function slotOf(initial) {
    const frame = currentFrame();
    const index = frame.index;
    frame.index += 1;
    if (index >= frame.slots.length) {
      frame.slots.push({ value: typeof initial === 'function' ? initial() : initial });
    }
    return frame.slots[index];
  }

  const React = {
    Fragment,
    createElement,
    memo: (component) => component,
    useState: (initial) => [slotOf(initial).value, noop],
    useReducer: (reducer, initial) => [
      typeof initial === 'function' ? initial() : initial,
      noop,
    ],
    useMemo: (factory) => factory(),
    useCallback: (callback) => callback,
    useRef: (initial) => slotOf(() => ({ current: initial })).value,
    useEffect: () => {},
    useLayoutEffect: () => {},
  };

  function expand(node) {
    if (node === null || node === undefined || node === false || node === true) return null;
    if (typeof node === 'string') return node;
    if (typeof node === 'number') return String(node);
    if (Array.isArray(node)) {
      const list = [];
      for (const item of node) {
        const expanded = expand(item);
        if (expanded !== null) list.push(expanded);
      }
      return list;
    }
    if (typeof node.type === 'function') {
      const frame = { slots: [], index: 0 };
      hookStack.push(frame);
      let rendered;
      try {
        rendered = node.type({ ...node.props });
      } finally {
        hookStack.pop();
      }
      return expand(rendered);
    }
    if (node.type === Fragment) return expand(node.props.children);
    const { children, ...rest } = node.props;
    return { type: node.type, props: rest, children: expand(children) };
  }

  function walk(node, out) {
    if (node === null || node === undefined || typeof node === 'string') return out;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, out);
      return out;
    }
    out.push(node);
    return walk(node.children, out);
  }

  function textOf(node) {
    if (node === null || node === undefined) return '';
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(textOf).join('');
    return textOf(node.children);
  }

  function toHtml(node) {
    if (node === null || node === undefined) return '';
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(toHtml).join('');
    const attrs = Object.entries(node.props)
      .filter(
        ([key, value]) => key !== 'children'
          && value !== undefined
          && value !== null
          && typeof value !== 'function',
      )
      .map(([key, value]) => {
        if (typeof value === 'boolean') return value ? ` ${key}="true"` : '';
        if (typeof value === 'object') {
          return ` ${key}="${JSON.stringify(value).replaceAll('"', '&quot;')}"`;
        }
        return ` ${key}="${String(value).replaceAll('"', '&quot;')}"`;
      })
      .join('');
    return `<${node.type}${attrs}>${toHtml(node.children)}</${node.type}>`;
  }

  function render(element) {
    const tree = expand(element);
    return {
      tree,
      html: toHtml(tree),
      textOnly: textOf(tree),
      elements: walk(tree, []),
    };
  }

  return { React, Fragment, render, textOf };
}

// ---------- loading client.js ----------

/** Evaluate client.js in a sandbox and return its internals plus the fake renderer. */
function loadClient() {
  const source = readFileSync(CLIENT_URL, 'utf8');
  assert.ok(
    source.includes(EXPORT_MARKER),
    'client.js module-return marker changed; update tests/client.test.js',
  );
  const exposed = EXPOSED.join(', ');
  const instrumented = source.replace(
    EXPORT_MARKER,
    `    return {\n      __parts: { ${exposed} },\n      inject: ['slots'],\n      apply(ctx) {`,
  );

  const loaded = [];
  const fakeWindow = {
    __ModuleLoader__: { load: (definition) => loaded.push(definition) },
    fetch: async () => {
      throw new Error('window.fetch was not stubbed by the test');
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const sandbox = {
    window: fakeWindow,
    console,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };
  vm.runInNewContext(instrumented, sandbox, { filename: 'client.js' });

  assert.equal(loaded.length, 1, 'client.js must register exactly one module');
  const fake = createFakeReact();
  const registered = loaded[0].factory((name) => {
    if (name === 'react') return fake.React;
    throw new Error(`unexpected require(${name}) in client.js`);
  });
  assert.ok(registered.__parts, 'client.js internals were not exposed for tests');

  return { parts: registered.__parts, fake, window: fakeWindow, plugin: registered };
}

// ---------- fixtures ----------

/** Body of the first matching CSS rule (null when the selector is absent). */
function cssRule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\{([^}]*)\\}`));
  return match === null ? null : match[1];
}

/** Deep-copy values produced inside the vm sandbox into plain test-realm data. */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Localized `t()` straight from the client DICT (zh by default). */
function translator(parts, locale = 'zh') {
  const table = parts.DICT[locale];
  assert.ok(table, `missing DICT.${locale}`);
  return (key) => table[key] ?? parts.DICT.en[key] ?? key;
}

function makeVersion(version, summary, options = {}) {
  return {
    version,
    createdAt: options.createdAt ?? 1000 * version,
    source: options.source ?? 'model',
    conclusion: {
      verdict: options.verdict ?? 'suggest',
      summary,
      blockers: [],
      suggestions: [],
      nextSteps: [],
    },
    coverage: options.coverage ?? null,
  };
}

function makeRound(round, options = {}) {
  return {
    round,
    headSha: options.headSha ?? `sha-${round}-0123456789`,
    startedAt: options.startedAt ?? 1000 * round,
    finishedAt: options.finishedAt ?? 1000 * round + 500,
    conclusions: options.conclusions ?? [],
    delta: options.delta ?? null,
    feedback: options.feedback ?? null,
    publishedIds: options.publishedIds ?? [],
  };
}

function makeReport() {
  return {
    verdict: 'suggest',
    summary: '整体总结内容',
    risks: [{ severity: 'suggest', file: '', point: '初筛风险点' }],
    order: [{ file: 'src/a.js', reason: '入口改动' }],
  };
}

function makeReview(options = {}) {
  const round = options.round ?? 3;
  return {
    number: 7,
    status: options.status ?? 'done',
    round,
    headSha: `sha-${round}-0123456789`,
    report: options.report !== undefined ? options.report : makeReport(),
    files: options.files ?? [{ path: 'src/a.js', status: 'modified', additions: 1, deletions: 0 }],
    explanations: options.explanations ?? [],
    pull: options.pull ?? {
      title: 'PR 标题',
      author: 'dev',
      headRef: 'feature',
      baseRef: 'main',
      additions: 1,
      deletions: 0,
      changedFiles: 1,
      url: 'https://example.test/pr/7',
    },
    reportUpdatedAt: options.reportUpdatedAt ?? 0,
    conclusionEditedAt: options.conclusionEditedAt ?? 0,
    conclusion: options.conclusion ?? null,
    conclusionAt: options.conclusionAt ?? 0,
    coverage: options.coverage ?? null,
    roundHistory: options.roundHistory ?? [],
    delta: options.delta ?? null,
    feedback: options.feedback ?? null,
    published: options.published ?? [],
    publishedItems: [],
    concluding: options.concluding ?? null,
    concludeError: null,
    publishing: false,
    comment: null,
    pullChat: [],
  };
}

/** Props expected by OverviewPanel (wired the same way ReviewWorkspace calls it). */
function overviewProps(parts, review, extra = {}) {
  return {
    review,
    t: translator(parts),
    selectedRoundNumber: extra.selectedRoundNumber ?? null,
    onSelectRound: extra.onSelectRound ?? (() => {}),
    versionPick: extra.versionPick ?? {},
    onPickVersion: extra.onPickVersion ?? (() => {}),
    concludeBusy: extra.concludeBusy ?? false,
    concluding: extra.concluding ?? null,
    cancelBusy: false,
    onCancelConclude: () => {},
    reviewBusy: false,
    onConclude: () => {},
    onOpenFile: () => {},
    explainedCount: extra.explainedCount ?? 0,
    totalFiles: extra.totalFiles ?? (review.files ?? []).length,
    fileFindings: extra.fileFindings ?? [],
    publishBusy: false,
    previewBusy: false,
    feedbackBusy: false,
    onCheckFeedback: () => {},
    comment: extra.comment ?? null,
    onPublish: () => {},
    autoReconclude: extra.autoReconclude ?? false,
    inlineFooter: extra.inlineFooter,
  };
}

function renderOverview(client, review, extra = {}) {
  const { parts, fake } = client;
  const element = fake.React.createElement(
    parts.OverviewPanel,
    overviewProps(parts, review, extra),
  );
  return fake.render(element);
}

// ---------- §4.2: round 1 has no delta / feedback / check button ----------

test('round 1 renders no comparison/feedback blocks and no feedback-check button', () => {
  const client = loadClient();
  const version = makeVersion(1, '第一轮结论');
  const review = makeReview({
    round: 1,
    conclusionAt: version.createdAt,
    conclusion: version.conclusion,
    roundHistory: [makeRound(1, { conclusions: [version] })],
  });
  const { textOnly } = renderOverview(client, review);

  assert.match(textOnly, /第一轮结论/);
  assert.doesNotMatch(textOnly, /复审对比/);
  assert.doesNotMatch(textOnly, /实现者反馈/);
  assert.doesNotMatch(textOnly, /检查实现者反馈/);
});

test('the report summary section owns the PR identity line and one card', () => {
  const client = loadClient();
  const version = makeVersion(1, '第一轮结论');
  const review = makeReview({
    round: 1,
    conclusionAt: version.createdAt,
    conclusion: version.conclusion,
    roundHistory: [makeRound(1, { conclusions: [version] })],
  });
  const { parts, fake } = client;
  const { textOnly, elements } = renderOverview(client, review);

  const headingIndex = textOnly.indexOf('总体评价');
  assert.ok(headingIndex >= 0, 'report summary heading missing');
  // The heading leads the section: PR identity, meta and summary all follow it.
  assert.ok(headingIndex < textOnly.indexOf('PR 标题'), 'heading must lead the PR identity line');
  assert.ok(headingIndex < textOnly.indexOf('整体总结内容'), 'heading must sit above the summary text');
  assert.ok(headingIndex < textOnly.indexOf('总体初筛风险'), 'heading must lead its own section');

  const heading = elements.find(
    (node) => node.type === 'div'
      && node.props.className === 'prr-h2'
      && fake.textOf(node) === '总体评价',
  );
  assert.ok(heading, 'report summary heading must use the shared section heading style');

  // PR identity, author/branch stats and the summary text share one card, so the block is
  // no longer a bare line floating between sections.
  const card = elements.find(
    (node) => node.type === 'div'
      && node.props.className === 'prr-card'
      && fake.textOf(node).includes('整体总结内容'),
  );
  assert.ok(card, 'the summary section must render as a card');
  const cardText = fake.textOf(card);
  assert.match(cardText, /#7 PR 标题/);
  assert.match(cardText, /dev · feature → main · \+1 \/ -0 · 1/);
  assert.equal(parts.DICT.en.summary, 'Summary');
});

// ---------- whole-review footer (actions + collapsible notices) ----------

/** Render the footer the overview publishes to the composer dock. */
function renderFooter(client, review, extra = {}) {
  const { parts, fake } = client;
  const props = overviewProps(parts, review, extra);
  const rounds = parts.roundsOf(review);
  const current = rounds.length === 0 ? null : rounds[rounds.length - 1];
  const versions = parts.versionsOf(review, current, true);
  const selectedVersion = versions.length === 0 ? null : versions[versions.length - 1];
  const footer = parts.overviewFooter(props, {
    report: review.report,
    pull: review.pull ?? {},
    selectedVersion,
    staleInfo: parts.staleInfoOf(review, versions),
    isCurrent: extra.isCurrent ?? true,
    isOlderVersion: extra.isOlderVersion ?? false,
  });
  const noticeAt = (expanded) => {
    if (footer.notice === null) return fake.render(fake.React.createElement('span'));
    return fake.render(fake.React.createElement(parts.DockNotice, {
      notice: footer.notice,
      expanded,
      onToggle: () => {},
    }));
  };
  const actions = footer.actions === null
    ? fake.render(fake.React.createElement('span'))
    : fake.render(fake.React.createElement('div', null, footer.actions));
  return {
    footer,
    collapsed: noticeAt(false),
    expanded: noticeAt(true),
    actions,
  };
}

test('the footer keeps the actions out of the overview scroll', () => {
  const client = loadClient();
  const version = makeVersion(1, '第一轮结论');
  const review = makeReview({
    round: 1,
    conclusionAt: version.createdAt,
    conclusion: version.conclusion,
    roundHistory: [makeRound(1, { conclusions: [version] })],
  });
  const { textOnly, html } = renderOverview(client, review);

  assert.doesNotMatch(textOnly, /生成最终结论/);
  assert.doesNotMatch(html, /prr-actions/);
});

test('the footer actions name the conclusion and the publish step', () => {
  const client = loadClient();
  const version = makeVersion(1, '第一轮结论');
  const review = makeReview({
    round: 1,
    conclusionAt: version.createdAt,
    conclusion: version.conclusion,
    roundHistory: [makeRound(1, { conclusions: [version] })],
  });
  const { actions } = renderFooter(client, review);

  assert.match(actions.textOnly, /生成最终结论/);
  assert.match(actions.textOnly, /发布/);
});

test('stale analysis folds to one summary row that expands to the changed files', () => {
  const client = loadClient();
  const version = makeVersion(1, '第三轮结论', { createdAt: 5000 });
  const review = makeReview({
    round: 3,
    conclusionAt: 5000,
    conclusion: version.conclusion,
    roundHistory: [makeRound(3, { conclusions: [version] })],
    explanations: [
      { file: 'src/a.js', status: 'done', explanation: null, chat: [], updatedAt: 6000 },
      { file: 'src/b.js', status: 'done', explanation: null, chat: [], updatedAt: 7000 },
    ],
  });
  const { footer, collapsed, expanded, actions } = renderFooter(client, review);

  assert.match(actions.textOnly, /重新生成结论/);
  assert.doesNotMatch(actions.textOnly, /处新改动/, 'the button must not repeat the count');
  // Collapsed: a single summary row; the file list is not rendered yet.
  assert.equal(footer.notice.tone, 'warn');
  assert.match(collapsed.textOnly, /结论之后有更新的文件（2 处）/);
  assert.doesNotMatch(collapsed.textOnly, /src\/a\.js/);
  const toggle = collapsed.elements.find(
    (node) => node.type === 'button' && node.props.className === 'prr-dock-toggle',
  );
  assert.ok(toggle, 'fold toggle missing');
  assert.equal(toggle.props['aria-expanded'], 'false');
  // Expanded: the same row plus the changed-file list.
  assert.equal(
    expanded.elements.find((node) => node.props.className === 'prr-dock-toggle').props['aria-expanded'],
    'true',
  );
  assert.match(expanded.textOnly, /src\/a\.js/);
  assert.match(expanded.textOnly, /src\/b\.js/);
});

test('auto-regeneration is announced when the stale panel is expanded', () => {
  const client = loadClient();
  const version = makeVersion(1, '第三轮结论', { createdAt: 5000 });
  const review = makeReview({
    round: 3,
    conclusionAt: 5000,
    conclusion: version.conclusion,
    roundHistory: [makeRound(3, { conclusions: [version] })],
    explanations: [
      { file: 'src/a.js', status: 'done', explanation: null, chat: [], updatedAt: 6000 },
    ],
  });
  const { collapsed, expanded } = renderFooter(client, review, { autoReconclude: true });
  assert.doesNotMatch(collapsed.textOnly, /已开启自动重生成/);
  assert.match(expanded.textOnly, /已开启自动重生成/);
});

test('an older conclusion version cannot be published', () => {
  const client = loadClient();
  const { fake } = client;
  const version = makeVersion(1, '第一轮结论');
  const review = makeReview({
    round: 1,
    conclusionAt: version.createdAt,
    conclusion: version.conclusion,
    roundHistory: [makeRound(1, { conclusions: [version] })],
  });
  const findPublish = (view) => view.elements.find(
    (node) => node.type === 'button' && fake.textOf(node) === '发布',
  );

  const older = findPublish(renderFooter(client, review, { isOlderVersion: true }).actions);
  assert.ok(older, 'publish button missing');
  assert.equal(older.props.disabled, true);
  assert.match(String(older.props.title ?? ''), /旧版本结论/);

  // The latest version stays publishable.
  const latest = findPublish(renderFooter(client, review).actions);
  assert.equal(latest.props.disabled, false);
});

test('the footer notices the files that are not analyzed yet', () => {
  const client = loadClient();
  const version = makeVersion(1, '第一轮结论');
  const review = makeReview({
    round: 1,
    conclusionAt: version.createdAt,
    conclusion: version.conclusion,
    roundHistory: [makeRound(1, { conclusions: [version] })],
    files: [
      { path: 'src/a.js', status: 'modified', additions: 1, deletions: 0 },
      { path: 'src/b.js', status: 'modified', additions: 1, deletions: 0 },
    ],
  });
  const { footer, collapsed, expanded } = renderFooter(client, review, { explainedCount: 1, totalFiles: 2 });

  // Coverage-only: a light chip without a fold toggle.
  assert.equal(footer.notice.detail, null);
  assert.match(collapsed.textOnly, /还有文件未分析/);
  assert.equal(collapsed.elements.some((node) => node.props.className === 'prr-dock-toggle'), false);
  assert.equal(expanded.elements.some((node) => node.props.className === 'prr-dock-toggle'), false);
});

test('historical rounds and rounds without a report have no footer', () => {
  const client = loadClient();
  const version = makeVersion(1, '第一轮结论');
  const review = makeReview({
    round: 2,
    conclusionAt: version.createdAt,
    conclusion: version.conclusion,
    roundHistory: [
      makeRound(1, { conclusions: [version] }),
      makeRound(2, { conclusions: [version] }),
    ],
  });

  const historical = renderFooter(client, review, { isCurrent: false });
  assert.equal(historical.footer.actions, null);
  assert.equal(historical.footer.notice, null);

  const noReport = renderFooter(client, makeReview({ round: 1, report: null }), {});
  assert.equal(noReport.footer.actions, null);
  assert.equal(noReport.footer.notice, null);
});

test('the review dock renders the published actions and notices in one row', () => {
  const client = loadClient();
  const { parts, fake } = client;
  const row = fake.React.createElement('div', { className: 'prr-actions' }, '生成最终结论');
  const notice = { tone: 'warn', summary: '结论之后有更新的文件（2 处）', detail: null };

  parts.actionsBridge.set(row);
  parts.actionsBridge.setNotice(notice);
  const shown = fake.render(fake.React.createElement(parts.ReviewDock));

  assert.equal(shown.tree.props.className, 'prr-dock');
  assert.match(shown.textOnly, /生成最终结论/);
  assert.match(shown.textOnly, /结论之后有更新的文件/);
  assert.ok(
    shown.textOnly.indexOf('结论之后有更新的文件') < shown.textOnly.indexOf('生成最终结论'),
    'notices stay above the action row',
  );

  parts.actionsBridge.set(null);
  parts.actionsBridge.setNotice(null);
  const hidden = fake.render(fake.React.createElement(parts.ReviewDock));
  assert.equal(hidden.tree, null);
});

test('the embedded footer hosts the same dock above its discussion input', () => {
  const client = loadClient();
  const { parts, fake } = client;
  parts.actionsBridge.set(fake.React.createElement('div', { className: 'prr-actions' }, '生成最终结论'));
  parts.actionsBridge.setNotice({ tone: 'warn', summary: '结论之后有更新的文件（2 处）', detail: null });

  const shown = fake.render(fake.React.createElement(parts.EmbeddedFooter, {
    t: (key) => key,
    draft: '',
    busy: false,
    locked: false,
    onChange: () => {},
    onSend: () => {},
  }));

  const dockIndex = shown.html.indexOf('prr-dock');
  const inputIndex = shown.html.indexOf('prr-drawer-composer');
  assert.ok(dockIndex >= 0, 'the embedded footer must host the dock');
  assert.ok(inputIndex >= 0, 'the discussion input must render');
  assert.ok(dockIndex < inputIndex, 'the dock must sit above the input');
  assert.match(shown.textOnly, /生成最终结论/);
  assert.match(shown.textOnly, /结论之后有更新的文件/);

  parts.actionsBridge.set(null);
  parts.actionsBridge.setNotice(null);
});

test('round 1 as a historical tab also hides comparison and feedback', () => {
  const client = loadClient();
  const rounds = [
    makeRound(1, { conclusions: [makeVersion(1, '第一轮结论')] }),
    makeRound(2, {
      conclusions: [makeVersion(1, '第二轮结论')],
      delta: { round: 2, previousRound: 1, resolved: [], stillOpen: [] },
      feedback: { comments: [], states: {}, notes: [] },
    }),
  ];
  const review = makeReview({ round: 2, roundHistory: rounds });
  const { textOnly } = renderOverview(client, review, { selectedRoundNumber: 1 });

  assert.match(textOnly, /第一轮结论/);
  assert.doesNotMatch(textOnly, /复审对比/);
  assert.doesNotMatch(textOnly, /实现者反馈/);
});

// ---------- regression: historical round after `record.report = null` ----------

test('historical round stays readable while the current round has no report', () => {
  const client = loadClient();
  const rounds = [
    makeRound(1, { conclusions: [makeVersion(1, '第一轮结论')] }),
    // A new round was started: the record has no report and the current round no conclusion.
    makeRound(2, { conclusions: [] }),
  ];
  const review = makeReview({ round: 2, report: null, roundHistory: rounds });
  const { textOnly } = renderOverview(client, review, { selectedRoundNumber: 1 });

  assert.match(textOnly, /第一轮结论/);
  assert.match(textOnly, /历史轮只读/);
  assert.doesNotMatch(textOnly, /还没有总体报告/, 'historical rounds must not fall into the no-report state');
  // Round tabs live in the top bar; the round meta line still names the historical round.
  assert.match(textOnly, /第 1 轮/);
});

test('current round without a report still shows the no-report state', () => {
  const client = loadClient();
  const review = makeReview({
    round: 2,
    report: null,
    roundHistory: [makeRound(1, { conclusions: [] }), makeRound(2, { conclusions: [] })],
  });
  const { textOnly } = renderOverview(client, review);
  assert.match(textOnly, /还没有总体报告/);
});

// ---------- §4.2: round >= 2 puts delta/feedback at the top ----------

test('current round 2 renders the comparison and feedback above the report', () => {
  const client = loadClient();
  const delta = {
    round: 2,
    previousRound: 1,
    resolved: [],
    stillOpen: [{ file: 'src/a.js', point: '仍待处理' }],
  };
  const feedback = {
    comments: [{ id: 1, author: 'dev', createdAt: '2024-01-01', body: '反馈正文' }],
    states: {},
    notes: [],
  };
  const rounds = [
    makeRound(1, { conclusions: [makeVersion(1, '第一轮结论')] }),
    makeRound(2, { conclusions: [makeVersion(1, '第二轮结论')], delta, feedback }),
  ];
  const version = rounds[1].conclusions[0];
  const review = makeReview({
    round: 2,
    conclusionAt: version.createdAt,
    conclusion: version.conclusion,
    roundHistory: rounds,
    delta,
    feedback,
    published: [{ id: 11, url: 'https://example.test/c/11', round: 2, version: 1, publishedAt: 3000 }],
  });
  const { textOnly } = renderOverview(client, review);

  const deltaIndex = textOnly.indexOf('复审对比');
  const feedbackIndex = textOnly.indexOf('实现者反馈');
  const reportIndex = textOnly.indexOf('总体初筛风险');

  assert.ok(feedbackIndex >= 0, 'feedback block missing');
  assert.ok(deltaIndex > feedbackIndex, 'feedback must render before the comparison');
  assert.ok(reportIndex > feedbackIndex, 'feedback must render above the report');
  assert.ok(reportIndex > deltaIndex, 'comparison must render above the report');
  // The current round keeps the feedback-check action.
  assert.match(textOnly, /检查实现者反馈/);
});

// ---------- top bar: clickable round pills replace the status chip ----------

test('top bar round pills show status/time, tag the latest round and report clicks', () => {
  const client = loadClient();
  const { parts, fake } = client;
  const rounds = [
    makeRound(1, { conclusions: [makeVersion(1, '第1轮结论', { createdAt: 4200 })] }),
    makeRound(2, { conclusions: [makeVersion(1, '第2轮结论', { createdAt: 5100 })] }),
    makeRound(3, { conclusions: [makeVersion(1, '第3轮结论', { createdAt: 6000 })] }),
  ];
  const t = translator(parts);
  const selected = [];
  const { textOnly, html, elements } = fake.render(fake.React.createElement(parts.RoundPills, {
    rounds,
    selectedRoundNumber: 3,
    latestRoundNumber: 3,
    latestText: '第 3 轮 · 已审查 10:47',
    latestTone: 'done',
    onSelect: (round) => selected.push(round),
    t,
  }));

  // Latest pill keeps the live status text and the "latest" tag.
  assert.match(textOnly, /第 3 轮 · 已审查 10:47/);
  assert.match(textOnly, /最新/);
  // Historical pills report their own review time (from the newest conclusion).
  assert.match(textOnly, /第 1 轮 · 已审查/);
  assert.match(textOnly, /第 2 轮 · 已审查/);
  // Ascending order.
  const first = textOnly.indexOf('第 1 轮');
  const second = textOnly.indexOf('第 2 轮');
  const third = textOnly.indexOf('第 3 轮');
  assert.ok(
    first >= 0 && second > first && third > second,
    `pills not ascending: ${first},${second},${third}`,
  );
  // Horizontal scrolling strip + highlighted active pill using the chip styling.
  assert.match(html, /prr-roundpills-scroll/);
  assert.match(
    html,
    /className="prr-round prr-roundpill" data-tone="done" data-active="true"[^>]*>第 3 轮/,
  );
  // Clicking a historical pill reports that round.
  const pill2 = elements.find(
    (node) => node.type === 'button' && /第 2 轮 · 已审查/.test(fake.textOf(node)),
  );
  assert.ok(pill2, 'historical pill missing');
  pill2.props.onClick();
  assert.deepEqual(selected, [2]);
});

test('round pills label rounds without a conclusion and keep the latest status tone', () => {
  const client = loadClient();
  const { parts, fake } = client;
  const rounds = [
    makeRound(1, { conclusions: [] }),
    makeRound(2, { conclusions: [makeVersion(1, '第2轮结论', { createdAt: 5000 })] }),
  ];
  const t = translator(parts);
  const { textOnly, html } = fake.render(fake.React.createElement(parts.RoundPills, {
    rounds,
    selectedRoundNumber: 1,
    latestRoundNumber: 2,
    latestText: '第 2 轮 · 审查中…',
    latestTone: 'reviewing',
    onSelect: () => {},
    t,
  }));

  assert.match(textOnly, /第 1 轮 · 无结论/);
  assert.match(textOnly, /第 2 轮 · 审查中…/);
  assert.match(html, /data-tone="idle" data-active="true"[^>]*>第 1 轮/);
  assert.match(html, /data-tone="reviewing" data-active="false"[^>]*>第 2 轮/);
});

test('top bar drops the repository meta line and keeps pills + refresh tooltip', () => {
  const client = loadClient();
  const { parts, fake } = client;
  const t = translator(parts);
  const rounds = [1, 2, 3].map((round) =>
    makeRound(round, { conclusions: [makeVersion(1, `第${round}轮结论`)] }));
  const selected = [];
  const refreshed = [];
  const { textOnly, html, elements } = fake.render(fake.React.createElement(parts.TopBar, {
    t,
    prNumber: 7,
    pullOptions: [fake.React.createElement('option', { key: 7, value: 7 }, '#7 PR 标题')],
    onSelectPr: () => {},
    prSelectDisabled: false,
    showRounds: true,
    rounds,
    selectedRoundNumber: 3,
    latestRoundNumber: 3,
    latestRoundText: '第 3 轮 · 已审查 10:47',
    latestRoundTone: 'done',
    onSelectRound: (round) => selected.push(round),
    published: [
      { round: 1, version: 1 },
      { round: 2, version: 1 },
      { round: 3, version: 1 },
    ],
    listBusy: false,
    lastPoll: '10:50',
    onRefresh: () => refreshed.push(true),
    reviewLabel: '开始第 4 轮审查',
    reviewHint: '下一轮提示',
    reviewDisabled: false,
    onReview: () => {},
    onClose: () => {},
  }));

  // Pills sit between the PR picker and the action buttons (spacer keeps them from squeezing).
  const selectIndex = html.indexOf('prr-select');
  const pillsIndex = html.indexOf('prr-roundpills');
  const refreshIndex = html.indexOf('prr-btn');
  assert.ok(selectIndex >= 0, 'PR picker missing');
  assert.ok(pillsIndex > selectIndex, 'round pills must follow the PR picker');
  assert.ok(refreshIndex > pillsIndex, 'action buttons must come after the round pills');

  // The old repository meta line is gone.
  assert.doesNotMatch(html, /class="prr-meta"/);
  assert.doesNotMatch(textOnly, /GitHub/);
  assert.doesNotMatch(textOnly, /acme-demo/);

  // The refresh tooltip still carries the last poll time.
  const refreshButton = elements.find(
    (node) => node.type === 'button' && fake.textOf(node) === '刷新列表',
  );
  assert.ok(refreshButton, 'refresh button missing');
  assert.match(refreshButton.props.title, /10:50/);
  refreshButton.props.onClick();
  assert.deepEqual(refreshed, [true]);

  assert.match(textOnly, /开始第 4 轮审查/);
  assert.match(textOnly, /关闭/);

  const pill2 = elements.find(
    (node) => node.type === 'button' && /第 2 轮 · 已审查/.test(fake.textOf(node)),
  );
  assert.ok(pill2, 'historical pill missing');
  pill2.props.onClick();
  assert.deepEqual(selected, [2]);
});

test('top bar renders no round pills before a review exists', () => {
  const client = loadClient();
  const { parts, fake } = client;
  const t = translator(parts);
  const { textOnly, html } = fake.render(fake.React.createElement(parts.TopBar, {
    t,
    prNumber: null,
    pullOptions: [],
    onSelectPr: () => {},
    prSelectDisabled: true,
    showRounds: false,
    rounds: [makeRound(1, { conclusions: [] })],
    selectedRoundNumber: 1,
    latestRoundNumber: 1,
    latestRoundText: '',
    latestRoundTone: 'idle',
    onSelectRound: () => {},
    listBusy: false,
    lastPoll: '尚未轮询',
    onRefresh: () => {},
    reviewLabel: '立即审查',
    reviewHint: '',
    reviewDisabled: true,
    onReview: () => {},
  }));
  assert.doesNotMatch(html, /prr-roundpills/);
  assert.doesNotMatch(textOnly, /第 1 轮/);
});

test('selecting a round follows the latest or pins history and shows the overview', () => {
  const { parts } = loadClient();
  assert.deepEqual(plain(parts.applyRoundSelection(3, 3)), {
    roundPick: null,
    mode: 'overview',
  });
  assert.deepEqual(plain(parts.applyRoundSelection(1, 3)), {
    roundPick: 1,
    mode: 'overview',
  });
});

test('the detail header keeps only the pane title', () => {
  const client = loadClient();
  const { parts, fake } = client;
  const t = translator(parts);
  const { textOnly, html, tree } = fake.render(fake.React.createElement(parts.DetailHeader, { t }));

  assert.equal(tree.props.className, 'prr-detail-head');
  assert.match(textOnly, /审查详情/);
  // The view switch moved into the file column; the header must not carry it (or old tabs).
  assert.doesNotMatch(textOnly, /总览/);
  assert.doesNotMatch(textOnly, /文件详情/);
  assert.doesNotMatch(textOnly, /第 1 轮/);
  assert.doesNotMatch(html, /prr-seg/);
});

test('the file column carries the pinned overview entry above the list', () => {
  const client = loadClient();
  const { parts, fake } = client;
  const t = translator(parts);
  const opened = [];
  const overviewHits = [];
  const files = [
    { path: 'src/a.js', order: 1, severity: 'suggest', additions: 2, deletions: 1, reason: '入口' },
    { path: 'src/b.js', order: 2, severity: '', additions: 0, deletions: 3, reason: '' },
  ];
  const renderPane = (overviewMode) => fake.render(fake.React.createElement(parts.FilesPane, {
    t,
    overviewMode,
    onSelectOverview: () => overviewHits.push('overview'),
    files,
    filePath: 'src/a.js',
    review: { files },
    onOpenFile: (path) => opened.push(path),
  }));

  const active = renderPane(true);
  const navRow = active.elements.find(
    (node) => node.type === 'button' && fake.textOf(node).trim() === '总览',
  );
  assert.ok(navRow, 'overview entry missing');
  assert.equal(navRow.props['data-active'], 'true');
  assert.ok(
    active.textOnly.indexOf('总览') < active.textOnly.indexOf('src/a.js'),
    'the overview entry sits above the file rows',
  );
  assert.ok(
    active.textOnly.indexOf('总览') < active.textOnly.indexOf('变更文件'),
    'the overview entry leads the column, above the changed-file header',
  );
  navRow.props.onClick();
  assert.deepEqual(overviewHits, ['overview']);

  const fileRow = active.elements.find(
    (node) => node.type === 'button' && fake.textOf(node).includes('src/b.js'),
  );
  fileRow.props.onClick();
  assert.deepEqual(opened, ['src/b.js']);

  const inactive = renderPane(false);
  const inactiveNav = inactive.elements.find(
    (node) => node.type === 'button' && fake.textOf(node).trim() === '总览',
  );
  assert.equal(inactiveNav.props['data-active'], 'false');
});

// ---------- v2: right-sidebar review tab ----------

test('sidebar review addresses round-trip the workspace cwd and an optional PR number', () => {
  const client = loadClient();
  const { parts } = client;

  const plain = parts.sidebarReviewAddress('/Users/me/work/example');
  assert.equal(plain, 'dsh-resource://pr-review/%2FUsers%2Fme%2Fwork%2Fexample');
  assert.deepEqual({ ...parts.parseSidebarReviewAddress(plain) }, { cwd: '/Users/me/work/example', number: null });

  const withNumber = parts.sidebarReviewAddress('/Users/me/work/example', 42);
  assert.deepEqual({ ...parts.parseSidebarReviewAddress(withNumber) }, { cwd: '/Users/me/work/example', number: 42 });
  assert.equal(parts.parseSidebarReviewAddress('dsh-resource://file/x'), null);
  assert.equal(parts.parseSidebarReviewAddress('dsh-resource://pr-review/'), null);
});

test('requestReviewTab docks with the session-scoped opener, then the public one', () => {
  const client = loadClient();
  const { parts } = client;
  const mountedStore = (sessionId) => ({ getSnapshot: () => sessionId, subscribe: () => () => {} });
  const tab = { contentId: 'dsh-resource://pr-review/x' };

  // Adopted store: the session-scoped opener commits the tab (works even before the column shows).
  const calls = [];
  const adopted = {
    mounted: mountedStore(undefined),
    openResourceIn: (sessionId, url, options) => calls.push(['in', sessionId, url, options.destination]),
    openResource: (url, options) => calls.push(['public', url, options.destination]),
    tabsIn: () => [tab],
  };
  assert.equal(parts.requestReviewTab({ get: (name) => (name === 'sidebarRight' ? adopted : undefined) }, 'session-a', '/repo/example'), 'opened');
  assert.equal(calls[0][0], 'in');
  assert.equal(calls[0][1], 'session-a');
  assert.equal(calls[0][2], 'dsh-resource://pr-review/%2Frepo%2Fexample');
  assert.equal(calls[0][3], 'sidebar');
  assert.equal(calls.length, 1);

  // No session-scoped opener: the public navigation works when the session is on screen.
  const publicCalls = [];
  const publicOnly = {
    mounted: mountedStore('session-a'),
    openResource: (url, options) => publicCalls.push([url, options.destination]),
    tabsIn: () => [tab],
  };
  assert.equal(parts.requestReviewTab({ get: (name) => (name === 'sidebarRight' ? publicOnly : undefined) }, 'session-a', '/repo/example'), 'opened');
  assert.equal(publicCalls.length, 1);
  assert.equal(publicCalls[0][0], 'dsh-resource://pr-review/%2Frepo%2Fexample');
  assert.equal(publicCalls[0][1], 'sidebar');

  // Nothing adopted yet and the session is not on screen: queue, never throw or fake success.
  const notReady = {
    mounted: mountedStore('session-b'),
    openResourceIn: () => {},
    tabsIn: () => [],
  };
  assert.equal(parts.requestReviewTab({ get: (name) => (name === 'sidebarRight' ? notReady : undefined) }, 'session-a', '/repo/example'), 'pending');

  // Older hosts / thrown navigation surface a visible error, never a floating fallback.
  assert.equal(parts.requestReviewTab({ get: () => undefined }, 'session-a', '/repo/example'), 'unsupported');
  // An unadopted surface is "still opening", not a failure: the caller keeps the request queued.
  const adopting = {
    mounted: mountedStore('session-a'),
    openResourceIn: () => {},
    openResource: () => { throw new Error('sidebarRight: no session surface is mounted'); },
    tabsIn: () => [],
  };
  assert.equal(parts.requestReviewTab({ get: (name) => (name === 'sidebarRight' ? adopting : undefined) }, 'session-a', '/repo/example'), 'pending');

  // A real navigation failure stays visible as an error.
  const broken = {
    mounted: mountedStore('session-a'),
    openResourceIn: () => {},
    openResource: () => { throw new Error('sidebarRight: no registered tab type claims "x"'); },
    tabsIn: () => [],
  };
  assert.equal(parts.requestReviewTab({ get: (name) => (name === 'sidebarRight' ? broken : undefined) }, 'session-a', '/repo/example'), 'failed');
});

test('the review entry is visible while connecting and on failure, hidden only at zero PRs', () => {
  const client = loadClient();
  const { parts, fake } = client;
  const hook = (selector) => selector({ byId: { 'session-a': { cwd: '/repo/example' } } });
  const render = () => fake.render(fake.React.createElement(parts.ReviewEntry, {
    ctx: { get: () => undefined },
    sessionId: 'session-a',
    useSessions: hook,
    onOpen: () => {},
  }));

  // The fake API is unreachable, so the first render is the connecting state: the pill must be
  // visible (a restart briefly loses the host routes) and marked busy.
  const connecting = render();
  assert.ok(connecting.html.includes('prr-hero-entry'), 'connecting pill renders');
  assert.ok(connecting.html.includes('data-busy="true"'), 'connecting pill is busy');
  const button = connecting.elements.find((node) => node.type === 'button');
  assert.ok(button, 'connecting pill is clickable for a retry');
  button.props.onClick();
});

// ---------- platform text: markdown + previous-round feedback baseline ----------

test('platform markdown renders as formatted nodes, never as raw markup', () => {
  const client = loadClient();
  const { parts, fake } = client;
  const view = fake.render(fake.React.createElement('div', null, parts.renderMarkdown([
    '### 标题',
    '',
    '**已修复**，见 `example.ts` 与 [PR](https://example.test/pull/1)。',
    '',
    '- 第一点',
    '- 第二点',
    '',
    '```',
    'const a = 1',
    '```',
    '',
    '<script>alert(1)</script>',
  ].join('\n'))));

  assert.match(view.html, /<h3[^>]*>标题<\/h3>/);
  assert.match(view.html, /<strong[^>]*>已修复<\/strong>/);
  assert.match(view.html, /<code[^>]*>example\.ts<\/code>/);
  assert.match(view.html, /<a[^>]*href="https:\/\/example\.test\/pull\/1"/);
  assert.match(view.html, /<ul[^>]*><li/);
  assert.match(view.html, /<pre[^>]*>const a = 1<\/pre>/);
  // Platform HTML stays text: no script element is ever created and the source is readable.
  assert.equal(view.elements.some((node) => node.type === 'script'), false);
  assert.match(view.textOnly, /<script>alert\(1\)<\/script>/);
});

test('feedback comments render markdown and explain a missing previous-round baseline', () => {
  const client = loadClient();
  const { parts, fake } = client;
  const t = translator(parts);
  const feedback = {
    comments: [{ id: 7, author: 'dev', createdAt: '2024-01-01', body: '**已修复** 第 1 条' }],
    states: {},
    notes: ['整体看过'],
  };

  const withBaseline = fake.render(fake.React.createElement(parts.FeedbackBlock, {
    feedback,
    t,
    canCheck: true,
    onCheckFeedback: () => {},
    feedbackBusy: false,
    hasBaseline: true,
  }));
  assert.match(withBaseline.html, /<strong[^>]*>已修复<\/strong>/);
  assert.doesNotMatch(withBaseline.textOnly, /\*\*已修复\*\*/);
  assert.match(withBaseline.textOnly, /整体看过/);

  const empty = fake.render(fake.React.createElement(parts.FeedbackBlock, {
    feedback: null,
    t,
    canCheck: false,
    onCheckFeedback: () => {},
    feedbackBusy: false,
    hasBaseline: true,
  }));
  assert.match(empty.textOnly, /上一轮的审查评论下还没有实现者回复/);

  const noBaseline = fake.render(fake.React.createElement(parts.FeedbackBlock, {
    feedback: null,
    t,
    canCheck: false,
    onCheckFeedback: () => {},
    feedbackBusy: false,
    hasBaseline: false,
  }));
  assert.match(noBaseline.textOnly, /上一轮还没有发布审查评论/);
});

test('feedback can be read before this round is published', () => {
  const client = loadClient();
  const version = makeVersion(1, '第二轮结论');
  const delta = { round: 2, previousRound: 1, resolved: [], stillOpen: [] };
  const feedback = { comments: [], states: {}, notes: [] };
  const review = makeReview({
    round: 2,
    conclusionAt: version.createdAt,
    conclusion: version.conclusion,
    roundHistory: [
      makeRound(1, { conclusions: [makeVersion(1, '第一轮结论')] }),
      makeRound(2, { conclusions: [version], delta, feedback }),
    ],
    delta,
    feedback,
    // Only the PREVIOUS round was published; this round has not been.
    published: [{ id: 11, url: 'https://example.test/c/11', round: 1, version: 1, publishedAt: 3000 }],
  });
  const { textOnly } = renderOverview(client, review);

  assert.match(textOnly, /实现者反馈/);
  assert.match(textOnly, /检查实现者反馈/);
  assert.match(textOnly, /上一轮的审查评论下还没有实现者回复/);
  assert.doesNotMatch(textOnly, /上一轮还没有发布审查评论/);
});

test('historical round 2 pins feedback before the comparison', () => {
  const client = loadClient();
  const delta = {
    round: 2,
    previousRound: 1,
    resolved: [],
    stillOpen: [{ file: 'src/a.js', point: '仍待处理' }],
  };
  const feedback = {
    comments: [{ id: 1, author: 'dev', createdAt: '2024-01-01', body: '反馈正文' }],
    states: {},
    notes: [],
  };
  const rounds = [
    makeRound(1, { conclusions: [makeVersion(1, '第一轮结论')] }),
    makeRound(2, { conclusions: [makeVersion(1, '第二轮结论')], delta, feedback }),
    makeRound(3, { conclusions: [makeVersion(1, '第三轮结论')] }),
  ];
  const review = makeReview({ round: 3, roundHistory: rounds });
  const { textOnly } = renderOverview(client, review, { selectedRoundNumber: 2 });

  const feedbackIndex = textOnly.indexOf('实现者反馈');
  const deltaIndex = textOnly.indexOf('复审对比');
  assert.ok(feedbackIndex >= 0, 'historical feedback missing');
  assert.ok(deltaIndex > feedbackIndex, 'historical feedback must render before the comparison');
  // No action buttons on a historical round.
  assert.doesNotMatch(textOnly, /检查实现者反馈/);
});

// ---------- §4.5: conclusion versions ----------

test('multiple conclusion versions default to the latest; older versions are read-only', () => {
  const client = loadClient();
  const rounds = [
    makeRound(1, { conclusions: [makeVersion(1, '第1轮结论')] }),
    makeRound(2, {
      conclusions: [
        makeVersion(1, '旧版本摘要', { source: 'model', createdAt: 1000 }),
        makeVersion(2, '最新版本摘要', { source: 'human', createdAt: 2000 }),
      ],
    }),
    makeRound(3, { conclusions: [makeVersion(1, '第3轮结论')] }),
  ];
  const review = makeReview({
    round: 3,
    conclusionAt: 3000,
    conclusion: makeVersion(1, '第3轮结论').conclusion,
    roundHistory: rounds,
  });

  const latest = renderOverview(client, review, { selectedRoundNumber: 2 });
  assert.match(latest.textOnly, /最新版本摘要/);
  assert.doesNotMatch(latest.textOnly, /旧版本摘要/);
  assert.doesNotMatch(latest.textOnly, /旧版本只读/);
  assert.match(latest.textOnly, /（最新）/);

  const older = renderOverview(client, review, { selectedRoundNumber: 2, versionPick: { 2: 1 } });
  assert.match(older.textOnly, /旧版本摘要/);
  assert.doesNotMatch(older.textOnly, /最新版本摘要/);
  assert.match(older.textOnly, /旧版本只读/);
  // Both versions are offered with their source annotation.
  assert.match(older.textOnly, /v1 · 模型生成/);
  assert.match(older.textOnly, /v2（最新） · 人工修改/);
});

test('version selector reports the chosen version', () => {
  const client = loadClient();
  const { parts, fake } = client;
  const versions = [makeVersion(1, 'v1 摘要'), makeVersion(2, 'v2 摘要')];
  const picked = [];
  const { elements } = fake.render(fake.React.createElement(parts.VersionSelector, {
    versions,
    selectedVersion: 2,
    onSelect: (version) => picked.push(version),
    t: translator(parts),
  }));
  const select = elements.find((node) => node.type === 'select');
  assert.ok(select, 'version select missing');
  select.props.onChange({ target: { value: '1' } });
  assert.deepEqual(picked, [1]);
});

// ---------- §4.6: actionable stale state ----------

test('conclusion card carries the round/version/coverage metadata line', () => {
  const client = loadClient();
  const version = makeVersion(1, '第三轮结论', {
    createdAt: 5000,
    coverage: { analyzed: 2, total: 2, unanalyzed: [] },
  });
  const review = makeReview({
    round: 3,
    conclusionAt: 5000,
    conclusion: version.conclusion,
    conclusionEditedAt: 6000,
    roundHistory: [makeRound(3, { conclusions: [version] })],
    published: [
      { id: 21, url: 'https://example.test/c/21', round: 3, version: 1, publishedAt: 7000 },
    ],
  });
  const { textOnly } = renderOverview(client, review);
  assert.match(textOnly, /第 3 轮 · v1 · 生成于 \d{1,2}:\d{2}/);
  assert.match(textOnly, /覆盖 2\/2 文件/);
  assert.match(textOnly, /人工修订/);
  assert.match(textOnly, /已发布/);
});

// ---------- §4.8: publish preview + 409 handling ----------

test('already-published preview offers the append-anyway path', () => {
  const client = loadClient();
  const { parts, fake } = client;
  const confirmed = [];
  const { textOnly, elements } = fake.render(fake.React.createElement(parts.PublishPreviewModal, {
    preview: {
      markdown: '# PR 评论正文',
      language: 'zh',
      round: 3,
      version: 2,
      conflict: 'already-published',
    },
    t: translator(parts),
    busy: false,
    error: '',
    onConfirm: (force) => confirmed.push(force),
    onCancel: () => {},
  }));

  assert.match(textOnly, /# PR 评论正文/);
  assert.match(textOnly, /语言：中文/);
  assert.match(textOnly, /已经发布过/);
  const append = elements.find(
    (node) => node.type === 'button' && /仍然追加/.test(fake.textOf(node)),
  );
  assert.ok(append, 'append-anyway button missing');
  append.props.onClick();
  assert.deepEqual(confirmed, [true]);
});

test('publishing conflict preview tells the user to retry later', () => {
  const client = loadClient();
  const { parts, fake } = client;
  const { textOnly } = fake.render(fake.React.createElement(parts.PublishPreviewModal, {
    preview: {
      markdown: '# 正文',
      language: 'en',
      round: 1,
      version: 1,
      conflict: 'publishing',
    },
    t: translator(parts),
    busy: false,
    error: '',
    onConfirm: () => {},
    onCancel: () => {},
  }));
  assert.match(textOnly, /另一个发布任务正在进行/);
  assert.match(textOnly, /语言：English（en）/);
});

test('api surfaces host conflict codes for the publish branch', async () => {
  const client = loadClient();
  client.window.fetch = async () => ({
    ok: false,
    status: 409,
    json: async () => ({ ok: false, error: { code: 'already-published', message: '已发布过' } }),
  });
  await assert.rejects(
    client.parts.api('/pr-review-api/comment', { method: 'POST' }),
    (error) => {
      assert.equal(error.code, 'already-published');
      assert.equal(error.status, 409);
      assert.match(error.message, /已发布过/);
      return true;
    },
  );

  client.window.fetch = async () => ({
    ok: false,
    status: 409,
    json: async () => ({ ok: false, error: { code: 'publishing', message: '稍候' } }),
  });
  await assert.rejects(
    client.parts.api('/pr-review-api/comment', { method: 'POST' }),
    (error) => {
      assert.equal(error.code, 'publishing');
      return true;
    },
  );
});

// ---------- defensive fallbacks ----------

test('legacy records without roundHistory render as a single round', () => {
  const client = loadClient();
  const review = makeReview({ round: 2, roundHistory: [] });
  review.conclusion = makeVersion(1, '旧数据结论').conclusion;
  review.conclusionAt = 900;
  delete review.roundHistory;

  const rounds = client.parts.roundsOf(review);
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].round, 2);

  const { textOnly } = renderOverview(client, review);
  assert.match(textOnly, /旧数据结论/);
  assert.match(textOnly, /第 2 轮/);
});

// ---------- §8.1: conclusion item line numbers ----------

test('conclusion items show path:line and open the file at that line', () => {
  const client = loadClient();
  const { parts, fake } = client;
  const opened = [];
  const conclusion = {
    verdict: 'block',
    summary: '摘要',
    blockers: [{ id: 'b-1', file: 'src/a.js', point: '阻塞问题', line: 42 }],
    suggestions: [{ id: 's-1', file: 'src/b.js', point: '改进建议', line: 0 }],
    nextSteps: [],
  };
  const { textOnly, elements } = fake.render(fake.React.createElement(parts.ConclusionBlock, {
    conclusion,
    t: translator(parts),
    onOpenFile: (file, line) => opened.push([file, line]),
    feedbackStates: {},
  }));

  assert.match(textOnly, /src\/a\.js:42/);
  assert.match(textOnly, /src\/b\.js(?!:)/);
  const withLine = elements.filter(
    (node) => node.type === 'button' && /src\/a\.js:42/.test(fake.textOf(node)),
  );
  assert.equal(withLine.length, 1);
  withLine[0].props.onClick();
  const withoutLine = elements.filter(
    (node) => node.type === 'button' && fake.textOf(node) === 'src/b.js',
  );
  assert.equal(withoutLine.length, 1);
  withoutLine[0].props.onClick();
  assert.deepEqual(opened, [['src/a.js', 42], ['src/b.js', 0]]);
});

test('diff rows expose data-new-line for the new side only', () => {
  const client = loadClient();
  const { parts, fake } = client;
  const diffText = [
    'diff --git a/src/a.js b/src/a.js',
    '--- a/src/a.js',
    '+++ b/src/a.js',
    '@@ -1,3 +1,3 @@',
    ' line1',
    '-old line',
    '+new line',
    ' line3',
  ].join('\n');
  const { html } = fake.render(fake.React.createElement(parts.DiffView, {
    diffText,
    wrap: false,
    emptyText: 'empty',
    walkthrough: [],
    walkLabel: '段',
    hint: '',
    activeHunk: 0,
    fileContent: null,
    expandedHunks: new Set(),
    expandFallbackLabel: '展开',
    collapseLabel: '收起',
    onCollapseHunk: () => {},
    onOpenHunk: () => {},
  }));
  assert.match(html, /data-new-line="1"/);
  assert.match(html, /data-new-line="2"/);
  assert.match(html, /data-new-line="3"/);
  // meta/deleted rows keep an empty marker, so the numeric markers are exactly the new side.
  assert.equal((html.match(/data-new-line="[0-9]+"/g) ?? []).length, 3);
});

test('diff scrolling targets the new-side line and stays silent when it is missing', () => {
  const { parts } = loadClient();
  const scrolled = [];
  const row = { scrollIntoView: (options) => scrolled.push(options) };
  const container = {
    querySelector: (selector) => (selector === '[data-new-line="42"]' ? row : null),
  };
  assert.equal(parts.scrollToNewLine(container, 42), true);
  assert.deepEqual(plain(scrolled), [{ block: 'center' }]);
  // Not in the displayed hunks / no container / no line: silent no-op.
  assert.equal(parts.scrollToNewLine(container, 7), false);
  assert.equal(parts.scrollToNewLine(null, 7), false);
  assert.equal(parts.scrollToNewLine(container, 0), false);
  assert.equal(parts.scrollToNewLine({}, 7), false);
});

test('fileLineLabel keeps a plain path when the line is unknown', () => {
  const { parts } = loadClient();
  assert.equal(parts.fileLineLabel('src/a.js', 12), 'src/a.js:12');
  assert.equal(parts.fileLineLabel('src/a.js', 0), 'src/a.js');
  assert.equal(parts.fileLineLabel('src/a.js', -3), 'src/a.js');
  assert.equal(parts.fileLineLabel('', 12), '');
});

// ---------- §8.2: publish item selection ----------

test('publish preview lists selectable items with checkboxes and bulk controls', () => {
  const client = loadClient();
  const { parts, fake } = client;
  const toggled = [];
  const selectedAll = [];
  const selectedNone = [];
  const { textOnly, elements } = fake.render(fake.React.createElement(parts.PublishPreviewModal, {
    preview: {
      markdown: '# md',
      language: 'zh',
      round: 3,
      version: 2,
      conflict: '',
      selectionSupported: true,
      selectedIds: ['b-1'],
      items: [
        { id: 'b-1', kind: 'blocker', file: 'src/a.js', point: '阻塞问题', line: 42 },
        { id: 's-1', kind: 'suggestion', file: 'src/b.js', point: '改进建议', line: 0 },
      ],
    },
    t: translator(parts),
    busy: false,
    refreshing: false,
    error: '',
    onConfirm: () => {},
    onCancel: () => {},
    onToggleItem: (id) => toggled.push(id),
    onSelectAll: () => selectedAll.push(true),
    onSelectNone: () => selectedNone.push(true),
  }));

  assert.match(textOnly, /已选 1\/2/);
  assert.match(textOnly, /src\/a\.js:42/);
  assert.match(textOnly, /src\/b\.js/);
  assert.match(textOnly, /阻塞项/);
  assert.match(textOnly, /修改建议/);

  const checkboxes = elements.filter((node) => node.type === 'input');
  assert.equal(checkboxes.length, 2);
  assert.equal(checkboxes[0].props.checked, true);
  assert.equal(checkboxes[1].props.checked, false);
  checkboxes[1].props.onChange();
  assert.deepEqual(toggled, ['s-1']);

  const selectAll = elements.find(
    (node) => node.type === 'button' && fake.textOf(node) === '全选',
  );
  assert.ok(selectAll, 'select-all button missing');
  selectAll.props.onClick();
  const selectNone = elements.find(
    (node) => node.type === 'button' && fake.textOf(node) === '全不选',
  );
  assert.ok(selectNone, 'select-none button missing');
  selectNone.props.onClick();
  assert.deepEqual(selectedAll, [true]);
  assert.deepEqual(selectedNone, [true]);
});

test('the preview blocks publishing when nothing is selected', () => {
  const client = loadClient();
  const { parts, fake } = client;
  const render = (selectedIds) => fake.render(fake.React.createElement(parts.PublishPreviewModal, {
    preview: {
      markdown: '# md',
      language: 'zh',
      round: 1,
      version: 1,
      conflict: '',
      selectionSupported: true,
      selectedIds,
      items: [{ id: 'b-1', kind: 'blocker', file: 'src/a.js', point: '阻塞问题', line: 42 }],
    },
    t: translator(parts),
    busy: false,
    refreshing: false,
    error: '',
    onConfirm: () => {},
    onCancel: () => {},
    onToggleItem: () => {},
    onSelectAll: () => {},
    onSelectNone: () => {},
  }));

  const empty = render([]);
  assert.match(empty.textOnly, /没有勾选任何条目/);
  const confirmEmpty = empty.elements.find(
    (node) => node.type === 'button' && fake.textOf(node) === '确认发布',
  );
  assert.equal(confirmEmpty.props.disabled, true);

  const filled = render(['b-1']);
  const confirmFilled = filled.elements.find(
    (node) => node.type === 'button' && fake.textOf(node) === '确认发布',
  );
  assert.equal(confirmFilled.props.disabled, false);
  assert.doesNotMatch(filled.textOnly, /没有勾选任何条目/);
});

test('preview without selectable items falls back to publishing the full comment', () => {
  const client = loadClient();
  const { parts, fake } = client;
  const { textOnly, elements } = fake.render(fake.React.createElement(parts.PublishPreviewModal, {
    preview: {
      markdown: '# md',
      language: 'zh',
      round: 1,
      version: 1,
      conflict: '',
      selectionSupported: false,
      selectedIds: [],
      items: [],
    },
    t: translator(parts),
    busy: false,
    error: '',
    onConfirm: () => {},
    onCancel: () => {},
  }));
  assert.match(textOnly, /无法按条目选择/);
  assert.equal(elements.filter((node) => node.type === 'input').length, 0);
});

test('publish bodies carry includeIds, including the force append path', () => {
  const { parts } = loadClient();
  assert.deepEqual(plain(parts.buildPreviewBody(7)), { number: 7 });
  assert.deepEqual(plain(parts.buildPreviewBody(7, ['b-1', 's-1'])), {
    number: 7,
    includeIds: ['b-1', 's-1'],
  });
  assert.deepEqual(plain(parts.buildPublishBody(7, false, ['b-1'])), {
    number: 7,
    force: false,
    includeIds: ['b-1'],
  });
  // "仍然追加" (force: true) keeps the current selection.
  assert.deepEqual(plain(parts.buildPublishBody(7, true, ['b-1'])), {
    number: 7,
    force: true,
    includeIds: ['b-1'],
  });
  // Legacy/unknown selection omits includeIds so the host publishes everything.
  assert.deepEqual(plain(parts.buildPublishBody(7, true, null)), { number: 7, force: true });

  // The dialog only forwards a selection it can honour (both confirm and append paths).
  assert.deepEqual(plain(parts.selectionIncludeIds({
    selectionSupported: true,
    selectedIds: ['b-1', 's-1'],
  })), ['b-1', 's-1']);
  assert.equal(parts.selectionIncludeIds({ selectionSupported: false, selectedIds: ['b-1'] }), null);
  assert.equal(parts.selectionIncludeIds(null), null);
});

test('preview items fall back to the conclusion when the host returns none', () => {
  const { parts } = loadClient();
  const conclusion = {
    verdict: 'suggest',
    summary: 's',
    blockers: [{ id: 'b-1', file: 'src/a.js', point: 'B', line: 3 }],
    suggestions: [{ id: 's-1', file: 'src/b.js', point: 'S', line: 0 }],
    nextSteps: [],
  };
  const derived = parts.previewItemsOf(null, conclusion);
  assert.deepEqual(
    plain(derived.map((item) => [item.id, item.kind, item.file, item.line])),
    [['b-1', 'blocker', 'src/a.js', 3], ['s-1', 'suggestion', 'src/b.js', 0]],
  );
  assert.equal(parts.previewSelectionSupported(derived), true);

  const hostItems = [{ id: 'h-1', kind: 'suggestion', file: 'x.js', point: 'p', line: 9 }];
  const host = parts.previewItemsOf(hostItems, conclusion);
  assert.equal(host.length, 1);
  assert.equal(host[0].id, 'h-1');
  assert.equal(host[0].kind, 'suggestion');

  assert.equal(parts.previewItemsOf(null, null).length, 0);
  assert.equal(
    parts.previewSelectionSupported([{ id: '', kind: 'blocker', file: 'x', point: 'p', line: 0 }]),
    false,
  );
  assert.equal(parts.previewSelectionSupported([]), false);
});


// ---------- round pill styling: selected / hover / focus / tag contrast ----------

test('the review root reserves the composer band and lets the content scroll itself', () => {
  const { parts } = loadClient();
  const css = parts.CSS;

  // The root may never grow past the usable view height: otherwise the host transcript
  // scrolls the whole panel (top bar included) instead of the overview / diff.
  const root = cssRule(css, '.prr-root');
  assert.ok(root, 'root rule missing');
  assert.match(root, /height:calc\(var\(--dsh-conversation-viewport-height,100%\) - var\(--dsh-composer-height,0px\)\)/);
  assert.match(root, /min-height:0/);
  assert.match(root, /overflow:hidden/);

  // Each content region owns its scrollbar.
  const overview = cssRule(css, '.prr-overview-scroll');
  assert.match(overview, /flex:1/);
  assert.match(overview, /min-height:0/);
  assert.match(overview, /overflow:auto/);
  const diff = cssRule(css, '.prr-diff');
  assert.match(diff, /flex:1/);
  assert.match(diff, /min-height:0/);
  assert.match(diff, /overflow:auto/);
  const filelist = cssRule(css, '.prr-filelist');
  assert.match(filelist, /overflow:auto/);
  const detail = cssRule(css, '.prr-detail-body');
  assert.match(detail, /overflow:auto/);
});

test('round pill CSS keeps the tone and marks the selection without a brand ring', () => {
  const { parts } = loadClient();
  const css = parts.CSS;

  const active = cssRule(css, '.prr-roundpill[data-active="true"]');
  assert.ok(active, 'selected pill rule missing');
  // The round's own status tone must show through: no background/color override here.
  assert.doesNotMatch(active, /(?:^|;)background:/);
  assert.doesNotMatch(active, /(?:^|;)color:/);
  // No heavy brand (near-black in the light theme) border or inset ring on selection.
  assert.doesNotMatch(active, /--dsw-alias-brand-primary/);
  assert.doesNotMatch(active, /inset 0 0 0 1px/);
  assert.match(active, /font-weight:700/);
  assert.match(active, /box-shadow:0 1px 2px rgba\(0,0,0,\.10\)/);

  // Selection reinforces the round's own tone: a tone-coloured thin border + denser fill.
  for (const [tone, token] of [
    ['done', '--dsw-alias-state-success-primary'],
    ['pending', '--dsw-alias-state-warn-primary'],
    ['error', '--dsw-alias-state-error-primary'],
    ['reviewing', '--dsw-alias-brand-primary'],
  ]) {
    const rule = cssRule(css, `.prr-round[data-tone="${tone}"][data-active="true"]`);
    assert.ok(rule, `selected ${tone} tone rule missing`);
    assert.match(rule, new RegExp(`border-color:color-mix\\(in srgb,var\\(${token}\\)`));
    assert.match(rule, new RegExp(`background:color-mix\\(in srgb,var\\(${token}\\)`));
  }
  const idle = cssRule(css, '.prr-round[data-tone="idle"][data-active="true"]');
  assert.ok(idle, 'selected idle tone rule missing');
  assert.match(idle, /border-color:var\(--dsw-alias-border-l1\)/);

  // The generic hover only applies to unselected pills; the tone stays untouched.
  assert.equal(
    cssRule(css, '.prr-roundpill:hover'),
    null,
    'generic hover must be limited to :hover:not([data-active="true"])',
  );
  const hover = cssRule(css, '.prr-roundpill:hover:not([data-active="true"])');
  assert.ok(hover, 'unselected hover rule missing');
  assert.match(hover, /background:var\(--dsw-alias-interactive-bg-hover\)/);
  assert.match(hover, /color:var\(--dsw-alias-label-primary\)/);
  assert.match(hover, /border-color:var\(--dsw-alias-border-l1\)/);

  // Selected hover deepens the tone slightly (inset overlay) without replacing it.
  const activeHover = cssRule(css, '.prr-roundpill[data-active="true"]:hover');
  assert.ok(activeHover, 'selected hover rule missing');
  assert.doesNotMatch(activeHover, /(?:^|;)background:/);
  assert.doesNotMatch(activeHover, /(?:^|;)color:/);
  assert.match(activeHover, /inset 0 0 0 100px rgba\(0,0,0,\.04\)/);

  const base = cssRule(css, '.prr-roundpill');
  assert.ok(base, 'base pill rule missing');
  assert.match(base, /transition:background-color 140ms ease/);
  assert.match(base, /transition:[^;]*color 140ms ease/);
  assert.match(base, /transition:[^;]*border-color 140ms ease/);
  assert.match(base, /transition:[^;]*box-shadow 140ms ease/);

  const focus = cssRule(css, '.prr-roundpill:focus-visible');
  assert.ok(focus, 'focus-visible rule missing');
  assert.match(focus, /outline:2px solid var\(--dsw-alias-brand-primary\)/);
});

test('unselected round pill tones stay readable but quieter', () => {
  const { parts } = loadClient();
  const css = parts.CSS;
  const done = cssRule(css, '.prr-round[data-tone="done"]');
  assert.ok(done, 'done tone rule missing');
  assert.match(
    done,
    /background:color-mix\(in srgb,var\(--dsw-alias-state-success-primary\) 10%,transparent\)/,
  );
  assert.match(
    done,
    /color:color-mix\(in srgb,var\(--dsw-alias-state-success-primary\) 72%,var\(--dsw-alias-label-primary\)\)/,
  );
  const error = cssRule(css, '.prr-round[data-tone="error"]');
  assert.ok(error, 'error tone rule missing');
  assert.match(error, /10%,transparent/);
});

// ---------- round pills: unpublished conclusion marker ----------

test('round pills mark unpublished conclusions with a small tag', () => {
  const client = loadClient();
  const { parts, fake } = client;
  const t = translator(parts);
  const rounds = [
    makeRound(1, { conclusions: [makeVersion(1, '第1轮结论', { createdAt: 4200 })] }),
    makeRound(2, {
      conclusions: [
        makeVersion(1, '第2轮结论', { createdAt: 5100 }),
        makeVersion(2, '第2轮结论v2', { createdAt: 5200 }),
      ],
    }),
  ];
  const render = (published) => fake.render(fake.React.createElement(parts.RoundPills, {
    rounds,
    selectedRoundNumber: 2,
    latestRoundNumber: 2,
    latestText: '第 2 轮 · 已审查 10:47',
    latestTone: 'done',
    published,
    onSelect: () => {},
    t,
  }));
  const tagsOf = (view) => view.elements.filter(
    (node) => node.type === 'span' && /未发布/.test(fake.textOf(node)),
  );
  const pillOf = (view, label) => view.elements.find(
    (node) => node.type === 'button' && node.props.role === 'tab' && fake.textOf(node).startsWith(label),
  );

  // Nothing published: every round with a conclusion carries the marker.
  const none = render([]);
  assert.equal(tagsOf(none).length, 2);
  assert.match(none.textOnly, /未发布/);
  assert.equal(tagsOf(none)[0].props.title, '结论尚未发布到 PR 评论');
  const latestPill = pillOf(none, '第 2 轮');
  assert.match(fake.textOf(latestPill), /未发布/);
  assert.match(fake.textOf(latestPill), /最新/);

  // Newest version published for each round: no marker.
  const all = render([{ round: 1, version: 1 }, { round: 2, version: 2 }]);
  assert.equal(tagsOf(all).length, 0);

  // Legacy version 0 (and entries without a version) count as published.
  const legacy = render([{ round: 1, version: 0 }, { round: 2, version: 0 }]);
  assert.equal(tagsOf(legacy).length, 0);

  // Only an older version published keeps the marker on the latest version.
  const stale = render([{ round: 1, version: 1 }, { round: 2, version: 1 }]);
  assert.equal(tagsOf(stale).length, 1);
  assert.match(fake.textOf(pillOf(stale, '第 2 轮')), /未发布/);
});

test('rounds without a conclusion are never tagged unpublished (zh/en copy)', () => {
  const client = loadClient();
  const { parts, fake } = client;
  const rounds = [
    makeRound(1, { conclusions: [] }),
    makeRound(2, { conclusions: [makeVersion(1, '第2轮结论')] }),
  ];
  const render = (t, latestText) => fake.render(fake.React.createElement(parts.RoundPills, {
    rounds,
    selectedRoundNumber: 1,
    latestRoundNumber: 2,
    latestText,
    latestTone: 'pending',
    published: [],
    onSelect: () => {},
    t,
  }));
  const tagsOf = (view, label) => view.elements.filter(
    (node) => node.type === 'span' && label.test(fake.textOf(node)),
  );

  const zh = render(translator(parts), '第 2 轮 · 报告已生成，待结论');
  assert.equal(tagsOf(zh, /未发布/).length, 1);
  const emptyRound = zh.elements.find(
    (node) => node.type === 'button' && node.props.role === 'tab'
      && fake.textOf(node).startsWith('第 1 轮'),
  );
  assert.match(fake.textOf(emptyRound), /无结论/);
  assert.doesNotMatch(fake.textOf(emptyRound), /未发布/);

  const en = render(translator(parts, 'en'), 'Round 2 · report ready, conclusion pending');
  assert.match(en.textOnly, /Unpublished/);
  const enTag = tagsOf(en, /Unpublished/)[0];
  assert.equal(enTag.props.title, 'Conclusion not published to the PR yet');
});

test('isRoundVersionPublished handles rounds, versions and legacy records', () => {
  const { parts } = loadClient();
  const published = [{ round: 2, version: 3 }];
  assert.equal(parts.isRoundVersionPublished(published, 2, 3), true);
  assert.equal(parts.isRoundVersionPublished(published, 2, 2), false);
  assert.equal(parts.isRoundVersionPublished(published, 1, 3), false);
  assert.equal(parts.isRoundVersionPublished([], 2, 3), false);
  assert.equal(parts.isRoundVersionPublished(null, 2, 3), false);
  // Legacy records without version tracking count as published (avoid false alarms).
  assert.equal(parts.isRoundVersionPublished([{ round: 2, version: 0 }], 2, 9), true);
  assert.equal(parts.isRoundVersionPublished([{ round: 2 }], 2, 9), true);
  assert.equal(parts.isRoundVersionPublished([{ version: 0 }], 2, 9), true);
});

test('the workspace renders its root in every layer (overlay and sidebar)', () => {
  const client = loadClient();
  const { parts, fake } = client;
  const ctx = {
    get: () => undefined,
    slots: { register: () => () => {}, inject: () => {} },
  };
  for (const [layer, expected] of [['overlay', 'prr-root'], ['sidebar', 'prr-root prr-sidebar']]) {
    const view = fake.render(fake.React.createElement(parts.ReviewWorkspace, {
      ctx,
      sessionId: 'session-a',
      forcedCwd: '/repo/example',
      layer,
      onClose: () => {},
      initialNumber: null,
      initialFile: '',
    }));
    assert.ok(view.html.includes(expected), `${layer} layer renders its root`);
    assert.ok(view.html.includes('prr-resizer'), `${layer} layer renders the column resizer: ${view.html.slice(0, 240)}`);
  }
});

test('dragged columns are clamped to usable ranges and can be reset', () => {
  const client = loadClient();
  const { parts } = client;
  assert.equal(parts.clampColumnWidth('files', 10), 96);
  assert.equal(parts.clampColumnWidth('files', 500), 380);
  assert.equal(parts.clampColumnWidth('files', 220.4), 220);
  assert.equal(parts.clampColumnWidth('detail', 10), 160);
  assert.equal(parts.clampColumnWidth('detail', 2000), 760);
});


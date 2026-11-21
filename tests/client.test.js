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
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';

const CLIENT_URL = new URL('../client.js', import.meta.url);

/** Where the plugin factory returns its public module; tests splice the composition handle in. */
const EXPORT_MARKER = "    return {\n      inject: ['slots'],\n      apply(ctx) {";

/** Internals the tests need; every name must exist in the client factory scope. */
const EXPOSED = [
  'DICT',
  'CSS',
  'api',
  'OverviewPage',
  'FeedbackBlock',
  'renderMarkdown',
  'inlineMarkdown',
  'ReviewDock',
  'DockNotice',
  'EmbeddedFooter',
  'ReviewWorkspace',
  'WorkspaceView',
  'WorkspaceCenter',
  'WorkspaceOverviewPane',
  'WorkspaceAnalysisPane',
  'WorkspaceFileDetailPane',
  'clampColumnWidth',
  'actionsBridge',
  'overviewFooter',
  'versionsOf',
  'staleInfoOf',
  'RoundPills',
  'roundStripStateOf',
  'scrollRoundStrip',
  'revealActiveRound',
  'shouldShowReviewButton',
  'TopBar',
  'applyRoundSelection',
  'sidebarReviewAddress',
  'parseSidebarReviewAddress',
  'ReviewEntry',
  'requestReviewTab',
  'mountedSessionStore',
  'reviewAskContext',
  'isRoundVersionPublished',
  'previewConflictOf',
  'PublishPreviewModal',
  'DetailHeader',
  'FilesPane',
  'FileDetailPanel',
  'isAnalyzing',
  'fileSeverityOf',
  'fileContentKey',
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
  'derivePhase',
  'shouldAutoSwitchPhase',
  'overviewFooterVisible',
  'phaseStateText',
  'overviewStateText',
  'conclusionBadgeText',
  'conclusionBadgeTone',
  'processBadgeTone',
  'filesBadgeTone',
  'PhaseBar',
  'FindingList',
  'findingsOf',
  'cleanCountOf',
  'ConclusionPage',
  'ConclusionAppendix',
  'PublishPreviewSection',
  'WorkspaceConclusionPane',
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

  function slotOf(initial, kind) {
    const frame = currentFrame();
    const index = frame.index;
    frame.index += 1;
    // Each slot records the hook kind that produced it, and the frame accumulates the
    // per-render kind sequence — a hook swapped for another kind is drift even when the
    // total count stays the same.
    frame.kinds.push(kind);
    if (index >= frame.slots.length) {
      frame.slots.push({ kind, value: typeof initial === 'function' ? initial() : initial });
    } else {
      frame.slots[index].kind = kind;
    }
    return frame.slots[index];
  }

  const React = {
    Fragment,
    createElement,
    memo: (component) => component,
    useState: (initial) => [slotOf(initial, 'state').value, noop],
    // useReducer keeps its slot-free shape (it stores no value); it still joins the
    // kind sequence so a reducer/state swap is visible in rerender's kinds.
    useReducer: (reducer, initial) => {
      currentFrame().kinds.push('reducer');
      return [typeof initial === 'function' ? initial() : initial, noop];
    },
    // Every hook consumes one slot even when it ignores the stored value: real React advances
    // its hook cursor per call, so a component whose hook COUNT varies between renders is a
    // hooks-order violation. useMemo still recomputes and useCallback still passes through.
    // NOTE: unlike real React, this fake recomputes the factory on every render and does not honor dependency arrays — tests must not rely on memoized identity.
    useMemo: (factory) => {
      const slot = slotOf(undefined, 'memo');
      slot.value = factory();
      return slot.value;
    },
    useCallback: (callback) => {
      slotOf(undefined, 'callback');
      return callback;
    },
    useRef: (initial) => slotOf(() => ({ current: initial }), 'ref').value,
    useEffect: () => {
      slotOf(undefined, 'effect');
    },
    useLayoutEffect: () => {
      slotOf(undefined, 'layout');
    },
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
      const frame = { slots: [], index: 0, kinds: [] };
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

  /**
   * Invoke one component once per props entry through a SHARED hook frame, like real React
   * re-rendering a mounted component: the hook slots persist while the cursor resets per
   * invocation. The slot index after each invocation is the number of hooks that invocation
   * consumed, so unequal counts mean a hooks-order violation that a one-shot render cannot see.
   * `kinds` mirrors that per invocation as the sequence of hook kinds invoked, so a kind
   * swap that keeps the count stable is caught too.
   */
  function rerender(type, propsList) {
    const trees = [];
    const counts = [];
    const kinds = [];
    const frame = { slots: [], index: 0, kinds: [] };
    for (const props of propsList) {
      frame.index = 0;
      frame.kinds.length = 0;
      hookStack.push(frame);
      let rendered;
      try {
        rendered = type({ ...props });
      } finally {
        hookStack.pop();
      }
      counts.push(frame.index);
      kinds.push([...frame.kinds]);
      trees.push(expand(rendered));
    }
    return { trees, counts, kinds };
  }

  return { React, Fragment, render, rerender, textOf };
}

// ---------- loading client.js and its chunks ----------

/**
 * Evaluate the entry and its area chunks in one sandbox, compose them the way the entry does,
 * and return the flat internals plus the fake renderer. Chunk scripts call the same
 * `__ModuleLoader__.load({ id, chunk, factory })` the Host installs; `require.async` here
 * resolves the sibling file from disk instead of over the network.
 */
function loadClient() {
  const source = readFileSync(CLIENT_URL, 'utf8');
  assert.ok(
    source.includes(EXPORT_MARKER),
    'client.js module-return marker changed; update tests/client.test.js',
  );
  const instrumented = source.replace(
    EXPORT_MARKER,
    "    return {\n      __test: { compose, chunkFiles: CHUNK_FILES, ready },\n      inject: ['slots'],\n      apply(ctx) {",
  );

  const fake = createFakeReact();
  const registrations = new Map();
  const chunkExports = new Map();

  const fakeWindow = {
    __ModuleLoader__: {
      load: (definition) => {
        const key = definition.chunk ?? '__entry';
        assert.ok(!registrations.has(key), `duplicate module registration for ${key}`);
        registrations.set(key, definition);
      },
    },
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
    ResizeObserver: class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  };
  const context = vm.createContext(sandbox);

  const makeRequire = () => {
    const require = (name) => {
      if (name === 'react') return fake.React;
      throw new Error(`unexpected require(${name})`);
    };
    require.async = async (spec) => {
      if (!spec.startsWith('./')) throw new Error(`unexpected require.async(${spec})`);
      return loadChunk(spec.slice(2));
    };
    require.asset = (reference) => reference;
    return require;
  };

  /** Register and materialize one chunk script, memoized per sandbox. */
  function loadChunk(fileName) {
    if (chunkExports.has(fileName)) return chunkExports.get(fileName);
    if (!registrations.has(fileName)) {
      vm.runInContext(readFileSync(new URL(`../${fileName}`, import.meta.url), 'utf8'), context, {
        filename: fileName,
      });
    }
    const definition = registrations.get(fileName);
    assert.ok(definition !== undefined, `${fileName} must register itself through __ModuleLoader__.load`);
    assert.equal(definition.id, '@modouai/dsh-pr-review', `${fileName} registers under the package id`);
    const exports = definition.factory(makeRequire());
    chunkExports.set(fileName, exports);
    return exports;
  }

  vm.runInContext(instrumented, context, { filename: 'client.js' });
  const entry = registrations.get('__entry');
  assert.ok(entry !== undefined, 'client.js must register the package entry');
  const plugin = entry.factory(makeRequire());
  assert.ok(plugin.__test, 'client.js exposes its composition for tests');

  const chunks = Object.fromEntries(plugin.__test.chunkFiles.map((file) => [file, loadChunk(file)]));
  const modules = plugin.__test.compose(chunks);
  const parts = Object.assign({}, ...Object.values(modules));
  for (const name of EXPOSED) {
    assert.ok(name in parts, `client internals changed: ${name} is exported by no chunk`);
  }

  return { parts, fake, window: fakeWindow, plugin, modules };
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

/**
 * First raw (unexpanded) element matching `match`, children included. Hook-free components
 * can be called directly, so their returned trees expose the props handed to child elements.
 */
function findElement(node, match) {
  if (node === null || node === undefined || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findElement(item, match);
      if (found !== null) return found;
    }
    return null;
  }
  if (match(node)) return node;
  return findElement(node.props?.children, match);
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
    analyzing: options.analyzing ?? null,
    concludeError: null,
    publishing: false,
    comment: null,
    pullChat: [],
  };
}

/** Props expected by OverviewPage (wired the same way ReviewWorkspace calls it). */
function overviewProps(parts, review, extra = {}) {
  return {
    review,
    t: translator(parts),
    phase: extra.phase ?? { phase: 'ready', progress: null, nextAction: 'conclude', version: 0 },
    selectedRoundNumber: extra.selectedRoundNumber ?? null,
    onSelectRound: extra.onSelectRound ?? (() => {}),
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
    parts.OverviewPage,
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

  assert.match(textOnly, /改动概述/);
  assert.doesNotMatch(textOnly, /复审对比/);
  assert.doesNotMatch(textOnly, /实现者反馈/);
  assert.doesNotMatch(textOnly, /检查实现者反馈/);
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
  const roundNumber = current === null ? 1 : current.round;
  const footer = parts.overviewFooter(props, {
    report: review.report,
    pull: review.pull ?? {},
    selectedVersion,
    staleInfo: parts.staleInfoOf(review, versions),
    isCurrent: extra.isCurrent ?? true,
    hasVersion: versions.length > 0,
    selectedPublished: selectedVersion !== null
      && parts.isRoundVersionPublished(review.published ?? [], roundNumber, selectedVersion.version),
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
  const { fake } = client;
  const version = makeVersion(1, '第一轮结论');
  const review = makeReview({
    round: 1,
    conclusionAt: version.createdAt,
    conclusion: version.conclusion,
    roundHistory: [makeRound(1, { conclusions: [version] })],
  });
  const { actions } = renderFooter(client, review);

  // A round that already has a version regenerates it; "first conclusion" is not on offer.
  assert.match(actions.textOnly, /重新生成结论/);
  assert.doesNotMatch(actions.textOnly, /生成最终结论/);
  assert.match(actions.textOnly, /发布/);
  // Publishing the unpublished version is the next step, so it owns the primary slot.
  const publish = actions.elements.find(
    (node) => node.type === 'button' && fake.textOf(node) === '发布',
  );
  assert.ok(publish, 'publish button missing');
  assert.match(String(publish.props.className), /prr-btn-primary/);
});

test('a round without a conclusion offers the first generation only', () => {
  const client = loadClient();
  const { fake } = client;
  const review = makeReview({ round: 1, conclusion: null, roundHistory: [makeRound(1)] });
  const { actions } = renderFooter(client, review);

  assert.match(actions.textOnly, /生成最终结论/);
  assert.doesNotMatch(actions.textOnly, /重新生成结论/);
  assert.equal(
    actions.elements.filter((node) => node.type === 'button' && /发布/.test(fake.textOf(node))).length,
    0,
    'nothing can be published before a conclusion exists',
  );
});

test('a published version turns publishing into an explicit append action', () => {
  const client = loadClient();
  const { fake } = client;
  const version = makeVersion(1, '第一轮结论');
  const review = makeReview({
    round: 1,
    conclusionAt: version.createdAt,
    conclusion: version.conclusion,
    roundHistory: [makeRound(1, { conclusions: [version] })],
    published: [{ round: 1, version: 1, url: 'https://example.test/comment/1' }],
  });
  const { actions } = renderFooter(client, review);

  const append = actions.elements.find(
    (node) => node.type === 'button' && fake.textOf(node) === '追加评论',
  );
  assert.ok(append, 'the publish button should read as an append');
  assert.match(String(append.props.className), /prr-btn-primary/);
  assert.match(String(append.props.title ?? ''), /此结论已发布/);
  assert.doesNotMatch(String(append.props.title ?? ''), /\{version\}/, 'the placeholder must be filled');
  assert.equal(
    actions.elements.filter((node) => node.type === 'button' && fake.textOf(node) === '发布').length,
    0,
  );
});

test('the publish button says what the click would publish', () => {
  const client = loadClient();
  const { fake } = client;
  const version = makeVersion(1, '第一轮结论', { createdAt: 5000 });
  const publishOf = (review, extra) => {
    const { actions } = renderFooter(client, review, extra);
    return actions.elements.find(
      (node) => node.type === 'button' && /发布|追加评论/.test(fake.textOf(node)),
    );
  };
  const concludeOf = (actions) => actions.elements.find(
    (node) => node.type === 'button' && /结论/.test(fake.textOf(node)),
  );

  // Stale: the click publishes the selected conclusion, not the changes made after it.
  const stale = makeReview({
    round: 1,
    conclusionAt: 5000,
    conclusion: version.conclusion,
    roundHistory: [makeRound(1, { conclusions: [version] })],
    explanations: [{ file: 'src/a.js', status: 'done', explanation: null, chat: [], updatedAt: 6000 }],
  });
  const staleButton = publishOf(stale);
  assert.match(String(staleButton.props.title ?? ''), /结论之后还有未发布的新改动/);
  assert.doesNotMatch(String(staleButton.props.className), /prr-btn-primary/, 'regenerating owns the primary slot while stale');
  // …and it owns it alone: exactly one primary action in the footer.
  const staleConclude = concludeOf(renderFooter(client, stale).actions);
  assert.match(String(staleConclude.props.className), /prr-btn-primary/);

  // Published and stale: the append is what will happen, and the title says it ships the
  // selected conclusion without the newer changes.
  const appendStale = makeReview({
    round: 1,
    conclusionAt: 5000,
    conclusion: version.conclusion,
    roundHistory: [makeRound(1, { conclusions: [version] })],
    explanations: [{ file: 'src/a.js', status: 'done', explanation: null, chat: [], updatedAt: 6000 }],
    published: [{ round: 1, version: 1, url: 'https://example.test/comment/1' }],
  });
  const appendStaleButton = publishOf(appendStale);
  assert.equal(fake.textOf(appendStaleButton), '追加评论');
  assert.match(String(appendStaleButton.props.title ?? ''), /本次追加的是最新结论/);

  // Concluding: publishing keeps working, but on the conclusion that is already there.
  const concluding = makeReview({
    round: 1,
    conclusionAt: version.createdAt,
    conclusion: version.conclusion,
    roundHistory: [makeRound(1, { conclusions: [version] })],
  });
  const concludingButton = publishOf(concluding, { concluding: { stage: 'model', startedAt: 6000 } });
  assert.equal(concludingButton.props.disabled, false);
  assert.match(String(concludingButton.props.title ?? ''), /正在生成新结论/);
});

test('the preview opens in the append flow when the conclusion was already published', () => {
  const { parts } = loadClient();
  const version = makeVersion(1, '第一轮结论');
  const published = makeReview({
    round: 1,
    conclusionAt: version.createdAt,
    conclusion: version.conclusion,
    roundHistory: [makeRound(1, { conclusions: [version] })],
    published: [{ round: 1, version: 1, url: 'https://example.test/comment/1' }],
  });
  const fresh = makeReview({
    round: 1,
    conclusionAt: version.createdAt,
    conclusion: version.conclusion,
    roundHistory: [makeRound(1, { conclusions: [version] })],
  });

  assert.equal(parts.previewConflictOf(published), 'already-published');
  assert.equal(parts.previewConflictOf(fresh), '');
  assert.equal(parts.previewConflictOf(makeReview({ round: 1, conclusion: null, roundHistory: [makeRound(1)] })), '');
  // Only the same round and version counts: another version or another round is a fresh publish.
  assert.equal(parts.previewConflictOf({
    ...published,
    published: [{ round: 1, version: 2, url: 'https://example.test/comment/2' }],
  }), '');
  assert.equal(parts.previewConflictOf({
    ...published,
    published: [{ round: 2, version: 1, url: 'https://example.test/comment/3' }],
  }), '');
  assert.equal(parts.previewConflictOf({ ...published, published: [] }), '');
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

test('the latest conclusion stays publishable with publish owning the primary slot', () => {
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

  const publish = findPublish(renderFooter(client, review).actions);
  assert.ok(publish, 'publish button missing');
  assert.equal(publish.props.disabled, false);
  // With nothing stale and no older version in play, publishing is the step that reaches
  // the PR and owns the primary slot; regenerating steps back.
  assert.match(String(publish.props.className), /prr-btn-primary/);
  const actions = renderFooter(client, review).actions;
  const conclude = actions.elements.find(
    (node) => node.type === 'button' && fake.textOf(node) === '重新生成结论',
  );
  assert.ok(conclude, 'conclude button missing');
  assert.doesNotMatch(String(conclude.props.className), /prr-btn-primary/);
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

  assert.match(textOnly, /历史轮次不含改动概述/);
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

  // The historical round keeps rendering instead of falling into the no-report state.
  assert.match(textOnly, /历史轮次不含改动概述/);
  assert.doesNotMatch(textOnly, /还没有总体报告/, 'historical rounds must not fall into the no-report state');
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
  const reportIndex = textOnly.indexOf('审查发现');

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

test('round strip exposes scroll arrows gated by measured overflow', () => {
  const { parts, fake } = loadClient();
  const t = translator(parts);
  const rounds = [1, 2, 3].map((round) => makeRound(round, { conclusions: [] }));
  const { html, elements } = fake.render(fake.React.createElement(parts.RoundPills, {
    rounds,
    selectedRoundNumber: 3,
    latestRoundNumber: 3,
    latestText: '第 3 轮 · 审查中…',
    latestTone: 'reviewing',
    onSelect: () => {},
    t,
  }));

  assert.equal(parts.DICT.zh.roundScrollPrev, '向左滚动轮次');
  assert.equal(parts.DICT.zh.roundScrollNext, '向右滚动轮次');
  assert.equal(parts.DICT.en.roundScrollPrev, 'Scroll rounds left');
  assert.equal(parts.DICT.en.roundScrollNext, 'Scroll rounds right');

  const prev = elements.find(
    (node) => node.type === 'button' && node.props['aria-label'] === '向左滚动轮次',
  );
  const next = elements.find(
    (node) => node.type === 'button' && node.props['aria-label'] === '向右滚动轮次',
  );
  assert.ok(prev, 'left arrow missing');
  assert.ok(next, 'right arrow missing');
  assert.equal(prev.props['data-side'], 'prev');
  assert.equal(next.props['data-side'], 'next');
  // Before the first measurement neither side claims overflow, so both arrows stay hidden.
  assert.match(
    html,
    /className="prr-roundpills" data-overflow="false" data-at-start="true" data-at-end="true"/,
  );
  assert.equal(prev.props.disabled, true);
  assert.equal(next.props.disabled, true);
  // The tablist wraps the pills, not the arrows.
  assert.match(html, /className="prr-roundpills-scroll" role="tablist"/);
  assert.match(
    parts.CSS,
    /\.prr-roundpills\[data-overflow="true"\] \.prr-roundscroll\{display:inline-flex\}/,
  );
});

test('the round strip stays on the picker row and fades clipped pills', () => {
  const { parts } = loadClient();
  // One row at any panel width: the sidebar top bar never wraps, and the strip
  // yields space by scrolling instead of claiming a second line.
  assert.doesNotMatch(parts.CSS, /\.prr-sidebar \.prr-top\{flex-wrap/);
  assert.match(cssRule(parts.CSS, '.prr-sidebar .prr-roundpills'), /min-width:0/);
  // A pill clipped by the strip's edge fades out instead of stopping mid-glyph; each side
  // fades only while it can still scroll.
  assert.match(
    parts.CSS,
    /\[data-overflow="true"\]\[data-at-start="false"\] \.prr-roundpills-scroll\{[^}]*mask-image:linear-gradient\(90deg,transparent 0,#000 16px/,
  );
  assert.match(
    parts.CSS,
    /\[data-overflow="true"\]\[data-at-end="false"\] \.prr-roundpills-scroll\{[^}]*mask-image:linear-gradient\(90deg,#000 0,#000 calc\(100% - 16px\)/,
  );
});

test('the active round pill is kept inside the visible strip', () => {
  const { parts } = loadClient();
  const scrolled = [];
  const active = { scrollIntoView: (options) => scrolled.push(options) };
  const scroller = {
    querySelector: (selector) => (selector === '[data-active="true"]' ? active : null),
  };

  assert.equal(parts.revealActiveRound(scroller), true);
  assert.deepEqual(plain(scrolled), [{ block: 'nearest', inline: 'nearest' }]);
  assert.equal(parts.revealActiveRound(null), false);
  assert.equal(parts.revealActiveRound({ querySelector: () => null }), false);
});

test('round strip state tracks overflow and both ends', () => {
  const { parts } = loadClient();
  const scroller = (scrollWidth, clientWidth, scrollLeft) => ({ scrollWidth, clientWidth, scrollLeft });

  assert.deepEqual(plain(parts.roundStripStateOf(null)), {
    overflow: false, atStart: true, atEnd: true,
  });
  assert.deepEqual(plain(parts.roundStripStateOf(scroller(300, 300, 0))), {
    overflow: false, atStart: true, atEnd: true,
  });
  assert.deepEqual(plain(parts.roundStripStateOf(scroller(800, 300, 0))), {
    overflow: true, atStart: true, atEnd: false,
  });
  assert.deepEqual(plain(parts.roundStripStateOf(scroller(800, 300, 250))), {
    overflow: true, atStart: false, atEnd: false,
  });
  assert.deepEqual(plain(parts.roundStripStateOf(scroller(800, 300, 500))), {
    overflow: true, atStart: false, atEnd: true,
  });
  // Sub-pixel offsets from smooth scrolling still count as the boundary.
  assert.deepEqual(plain(parts.roundStripStateOf(scroller(800, 300, 0.5))), {
    overflow: true, atStart: true, atEnd: false,
  });
});

test('round strip scrolls most of a page toward the requested side', () => {
  const { parts } = loadClient();
  const calls = [];
  const scroller = { clientWidth: 300, scrollBy: (options) => calls.push(options) };

  assert.equal(parts.scrollRoundStrip(scroller, 1), true);
  assert.equal(parts.scrollRoundStrip(scroller, -1), true);
  assert.deepEqual(plain(calls), [
    { left: 240, behavior: 'smooth' },
    { left: -240, behavior: 'smooth' },
  ]);
  assert.equal(parts.scrollRoundStrip(null, 1), false);
});

test('review button only shows when automatic rounds cannot cover the head', () => {
  const { parts } = loadClient();
  const list = (autoReview) => ({ autoReview });
  const pull = (headSha) => ({ headSha });
  const round = (headSha, status = 'done') => ({ status, headSha });

  assert.equal(parts.shouldShowReviewButton(list(false), round('abc'), pull('abc')), true,
    'manual mode keeps the only entry');
  assert.equal(parts.shouldShowReviewButton(null, null, null), true,
    'unknown settings must not hide the only entry');
  assert.equal(parts.shouldShowReviewButton(list(true), null, pull('abc')), true,
    'no round yet');
  assert.equal(parts.shouldShowReviewButton(list(true), round('abc'), pull('abc')), false,
    'current round already covers the head');
  assert.equal(parts.shouldShowReviewButton(list(true), round('abc', 'error'), pull('abc')), true,
    'failed round can be retried immediately');
  assert.equal(parts.shouldShowReviewButton(list(true), round('abc', 'stale'), pull('abc')), true,
    'interrupted round can be retried immediately');
  assert.equal(parts.shouldShowReviewButton(list(true), round('abc'), pull('def')), true,
    'new commits are waiting for a round');
  assert.equal(parts.shouldShowReviewButton(list(true), round('abc'), null), true,
    'an unverifiable head keeps the manual entry');
  assert.equal(parts.shouldShowReviewButton(list(true), round('abc', 'reviewing'), pull('def')), false,
    'a running round is not a manual entry');
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

  // Refresh is an icon right after the picker; the pills follow it and the review action stays last.
  const selectIndex = html.indexOf('prr-select');
  const refreshIndex = html.indexOf('prr-btn-icon');
  const pillsIndex = html.indexOf('prr-roundpills');
  const reviewIndex = html.indexOf('开始第 4 轮审查');
  assert.ok(selectIndex >= 0, 'PR picker missing');
  assert.ok(refreshIndex > selectIndex, 'refresh icon must follow the PR picker');
  assert.ok(pillsIndex > refreshIndex, 'round pills must follow the refresh icon');
  assert.ok(reviewIndex > pillsIndex, 'the review action sits after the round pills');

  // The old repository meta line is gone.
  assert.doesNotMatch(html, /class="prr-meta"/);
  assert.doesNotMatch(textOnly, /GitHub/);
  assert.doesNotMatch(textOnly, /acme-demo/);

  // The refresh tooltip still carries the last poll time, and the icon is the whole button.
  const refreshButton = elements.find(
    (node) => node.type === 'button' && node.props['aria-label'] === '刷新列表',
  );
  assert.ok(refreshButton, 'refresh button missing');
  assert.match(refreshButton.props.title, /10:50/);
  assert.equal(fake.textOf(refreshButton), '', 'icon button must not render label text');
  assert.match(html, /<svg/);
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

test('the refresh icon spins visibly while the pull list reloads', () => {
  const { parts, fake } = loadClient();
  const t = translator(parts);
  const { elements } = fake.render(fake.React.createElement(parts.TopBar, {
    t,
    prNumber: null,
    pullOptions: [],
    onSelectPr: () => {},
    prSelectDisabled: true,
    showRounds: false,
    rounds: [],
    selectedRoundNumber: 1,
    latestRoundNumber: 1,
    latestRoundText: '',
    latestRoundTone: 'idle',
    onSelectRound: () => {},
    listBusy: true,
    lastPoll: '10:50',
    onRefresh: () => {},
    reviewLabel: '立即审查',
    reviewHint: '',
    reviewDisabled: true,
    onReview: () => {},
  }));

  const refreshButton = elements.find(
    (node) => node.type === 'button' && node.props['aria-label'] === '刷新中…',
  );
  assert.ok(refreshButton, 'busy refresh button missing');
  assert.equal(refreshButton.props.disabled, true);
  assert.equal(refreshButton.props['data-busy'], 'true');
  assert.match(
    parts.CSS,
    /\.prr-btn\[data-busy="true"\] \.prr-icon\{animation:prr-rotate/,
  );
});

test('top bar hides the review action when automatic rounds already cover the head', () => {
  const { parts, fake } = loadClient();
  const t = translator(parts);
  const render = (showReview) => fake.render(fake.React.createElement(parts.TopBar, {
    t,
    prNumber: 7,
    pullOptions: [],
    onSelectPr: () => {},
    prSelectDisabled: false,
    showRounds: false,
    rounds: [],
    selectedRoundNumber: 1,
    latestRoundNumber: 1,
    latestRoundText: '',
    latestRoundTone: 'idle',
    onSelectRound: () => {},
    listBusy: false,
    lastPoll: '10:50',
    onRefresh: () => {},
    showReview,
    reviewLabel: '开始第 4 轮审查',
    reviewHint: '下一轮提示',
    reviewDisabled: false,
    onReview: () => {},
  }));

  assert.doesNotMatch(render(false).textOnly, /开始第 4 轮审查/);
  assert.match(render(true).textOnly, /开始第 4 轮审查/);
  // Callers that do not compute the flag keep the old behaviour.
  assert.match(render(undefined).textOnly, /开始第 4 轮审查/);
});

test('the pull picker is wider without squeezing the round strip', () => {
  const { parts } = loadClient();
  assert.match(cssRule(parts.CSS, '.prr-select'), /max-width:680px/);
  assert.match(cssRule(parts.CSS, '.prr-sidebar .prr-select'), /max-width:260px/);
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

test('selecting a round follows the latest on the overview or pins history onto the conclusion', () => {
  const { parts } = loadClient();
  assert.deepEqual(plain(parts.applyRoundSelection(3, 3)), {
    roundPick: null,
    mode: 'overview',
  });
  assert.deepEqual(plain(parts.applyRoundSelection(1, 3)), {
    roundPick: 1,
    mode: 'conclusion',
  });
});

test('the file detail renders one findings list where each row may carry a suggestion', () => {
  const client = loadClient();
  const { parts, fake } = client;
  const t = translator(parts);
  // 服务端 explanation 永远是合并形状：每条意见自带 suggestion（'' = 无建议），无 suggestions 键。
  const { textOnly, elements } = fake.render(fake.React.createElement(parts.FileDetailPanel, {
    t,
    filePath: 'src/a.js',
    explanation: {
      status: 'done',
      explanation: {
        verdict: 'suggest',
        summary: '文件摘要',
        logic: '',
        changes: '',
        issues: [
          { severity: 'block', point: '会崩', suggestion: '加判空', line: 3 },
          { severity: 'suggest', point: '补测试', suggestion: '', line: 0 },
        ],
      },
    },
    onExplain: () => {},
  }));

  // 只有一个意见区块：旧的独立建议键已随合并删除，旧「改进建议」区块不得再出现。
  const titles = elements.filter((node) => node.props.className === 'prr-h2' && node.children === t('issues'));
  assert.equal(titles.length, 1, 'the findings section renders exactly once');
  assert.doesNotMatch(textOnly, /改进建议/);
  assert.match(textOnly, /会崩/);
  assert.match(textOnly, /补测试/);
  // 有建议的意见行内联渲染建议块（suggestionTag 标签 + 建议文本）；无建议行不渲染。
  const tags = elements.filter((node) => node.props.className === 'prr-tag');
  assert.equal(tags.length, 1, 'only the row carrying a suggestion renders the suggestion tag');
  assert.match(textOnly, /加判空/);
  // 非 pass 判定不需要「供参考」徽标（意见与判定语义一致）。
  assert.doesNotMatch(textOnly, /供参考/);
});

test('a pass verdict with findings explains itself as suggestions for reference', () => {
  const client = loadClient();
  const { parts, fake } = client;
  const t = translator(parts);
  // pass + 意见 = approve with comments：徽标解释这个组合，读者不必猜 pill 与列表哪个过期。
  const { textOnly, elements } = fake.render(fake.React.createElement(parts.FileDetailPanel, {
    t,
    filePath: 'src/a.js',
    explanation: {
      status: 'done',
      explanation: {
        verdict: 'pass',
        summary: '文件摘要',
        logic: '',
        changes: '',
        issues: [
          { severity: 'suggest', point: 'nit：命名可以更短', suggestion: '', line: 0 },
          { severity: 'suggest', point: '可选：抽公共 helper', suggestion: '抽成函数', line: 0 },
        ],
      },
    },
    onExplain: () => {},
  }));
  assert.match(textOnly, /2 条建议供参考/);
  // 徽标 prr-tag × 1 + 带建议的意见块 prr-tag × 1。
  const tags = elements.filter((node) => node.props.className === 'prr-tag');
  assert.equal(tags.length, 2);
});

test('the re-analyze busy state belongs to its own file, not the whole panel', () => {
  const client = loadClient();
  const { parts, fake } = client;
  const t = translator(parts);
  const render = (filePath, explainBusyPath) => fake.render(fake.React.createElement(parts.FileDetailPanel, {
    t,
    filePath,
    explainBusyPath,
    explanation: {
      status: 'done',
      explanation: {
        verdict: 'pass',
        summary: '文件摘要',
        logic: '',
        changes: '',
        issues: [],
      },
    },
    onExplain: () => {},
  }));

  // 另一个文件在分析：本文件的按钮仍是可点的「重新分析」，不得显示「正在分析…」。
  const other = render('src/a.js', 'src/b.js');
  assert.match(other.textOnly, /重新分析/);
  assert.doesNotMatch(other.textOnly, /正在分析/);
  // 本文件自己才是分析中：按钮显示进行中并禁用。
  const self = render('src/a.js', 'src/a.js');
  assert.match(self.textOnly, /正在分析/);
});

test('the file detail renders the merged findings a review_update_analysis write produces', () => {
  const client = loadClient();
  const { parts, fake } = client;
  const t = translator(parts);
  // 工具写回的合并意见：suggestion 直接跟在各自 point 后渲染，行号随行展示。
  const { textOnly, elements } = fake.render(fake.React.createElement(parts.FileDetailPanel, {
    t,
    filePath: 'src/a.js',
    explanation: {
      status: 'done',
      explanation: {
        verdict: 'suggest',
        summary: '文件摘要',
        logic: '',
        changes: '',
        issues: [
          { severity: 'suggest', point: '提取常量', suggestion: '把魔数移到模块顶部', line: 12 },
          { severity: 'block', point: '空指针', suggestion: '', line: 7 },
        ],
      },
    },
    onExplain: () => {},
  }));

  assert.match(textOnly, /提取常量/);
  assert.match(textOnly, /把魔数移到模块顶部/);
  assert.match(textOnly, /空指针/);
  assert.match(textOnly, /行 12/);
  assert.match(textOnly, /行 7/);
  const tags = elements.filter((node) => node.props.className === 'prr-tag');
  assert.equal(tags.length, 1, 'blank suggestions render no suggestion block');
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

test('the full-file cache key changes with the reviewed head', () => {
  const client = loadClient();
  const key = client.parts.fileContentKey;
  assert.equal(typeof key, 'function');
  const base = key(3, 'sha-a', 'src/a.js');
  assert.equal(base, key(3, 'sha-a', 'src/a.js'));
  assert.notEqual(base, key(3, 'sha-b', 'src/a.js'), 'a new head is a new snapshot');
  assert.notEqual(base, key(4, 'sha-a', 'src/a.js'));
  assert.notEqual(base, key(3, 'sha-a', 'src/b.js'));
});

test('isAnalyzing only accepts a usable progress total', () => {
  const { parts } = loadClient();
  assert.equal(parts.isAnalyzing({ total: 2, done: 0 }), true);
  assert.equal(parts.isAnalyzing({ total: 0 }), false);
  assert.equal(parts.isAnalyzing({ total: '3' }), false);
  assert.equal(parts.isAnalyzing({ done: 1 }), false);
  assert.equal(parts.isAnalyzing(null), false);
  assert.equal(parts.isAnalyzing(undefined), false);
});

test('the file column shows batch progress and the manual analyze-all button', () => {
  const client = loadClient();
  const { parts, fake } = client;
  const t = translator(parts);
  const dict = parts.DICT.zh;
  const fill = (template, vars) => Object.keys(vars).reduce(
    (text, key) => text.split(`{${key}}`).join(String(vars[key])),
    template,
  );
  const files = [{ path: 'src/a.js', order: 1, severity: '', additions: 1, deletions: 0, reason: '' }];
  // The global ledger the header badge speaks: one analyzed file, one failed entry.
  const explanations = [
    { file: 'src/a.js', status: 'done', error: null, explanation: { verdict: 'pass', summary: 'x', issues: [] }, chat: [], updatedAt: 1 },
    { file: 'src/b.js', status: 'error', error: 'boom', explanation: null, chat: [], updatedAt: 2 },
  ];
  const hits = [];
  const render = (extra) => fake.render(fake.React.createElement(parts.FilesPane, {
    t,
    overviewMode: false,
    onSelectOverview: () => {},
    files,
    filePath: '',
    review: { files, explanations },
    onOpenFile: () => {},
    ...extra,
  }));
  const analyzeAllButton = (rendered) => rendered.elements.find(
    (node) => node.type === 'button' && fake.textOf(node).trim() === dict.analyzeAll,
  );

  // Automatic mode: progress replaces the file count and no button competes with it.
  // The numbers are the global ledger (analyzed / all changed files), not the batch's own.
  const running = render({ analyzing: { total: 3, done: 1, failed: 0, current: 'src/a.js' } });
  assert.ok(running.textOnly.includes(fill(dict.analyzingFiles, { done: 1, total: 1 })));
  assert.equal(running.textOnly.includes(dict.fileUnit), false, 'progress replaces the file count');
  assert.equal(running.textOnly.includes(dict.analyzingFailed.replace('{failed}', '0')), false);
  assert.equal(analyzeAllButton(running), undefined);

  const failing = render({ analyzing: { total: 3, done: 2, failed: 1, current: 'src/b.js' } });
  assert.ok(failing.textOnly.includes(fill(dict.analyzingFiles, { done: 1, total: 1 })));
  assert.ok(failing.textOnly.includes(fill(dict.analyzingFailed, { failed: 1 })));

  const allFailed = render({ analyzing: { total: 2, done: 2, failed: 2 } });
  assert.ok(allFailed.textOnly.includes(fill(dict.analyzingFiles, { done: 1, total: 1 })));
  assert.ok(allFailed.textOnly.includes(fill(dict.analyzingFailed, { failed: 1 })));

  // Progress without a usable total is not a batch: keep the plain count.
  const degenerate = render({ analyzing: { total: 0, done: 0, failed: 0 } });
  assert.ok(degenerate.textOnly.includes(dict.fileUnit));
  assert.equal(degenerate.textOnly.includes(fill(dict.analyzingFiles, { done: 0, total: 0 })), false);
  const noTotal = render({ analyzing: { done: 1, failed: 0 } });
  assert.ok(noTotal.textOnly.includes(dict.fileUnit));

  // The global ledger is what shows: a batch claiming more than the ledger has still
  // renders the ledger numbers ("5/3" cannot happen).
  const clamped = render({ analyzing: { total: 2, done: 5, failed: 9 } });
  assert.ok(clamped.textOnly.includes(fill(dict.analyzingFiles, { done: 1, total: 1 })));
  assert.ok(clamped.textOnly.includes(fill(dict.analyzingFailed, { failed: 1 })));

  // The last file of a batch still reports progress until the host clears `analyzing`.
  const finishing = render({ analyzing: { total: 2, done: 2, failed: 0, current: '' } });
  assert.ok(finishing.textOnly.includes(fill(dict.analyzingFiles, { done: 1, total: 1 })));

  // Automatic mode with no batch: the plain count returns and no button appears.
  const idle = render({});
  assert.ok(idle.textOnly.includes(dict.fileUnit));
  assert.equal(analyzeAllButton(idle), undefined);

  // Manual mode: the count stays and the batch button appears.
  const manual = render({ manual: true, analyzeAllBusy: false, onAnalyzeAll: () => hits.push('all') });
  assert.ok(manual.textOnly.includes(dict.fileUnit));
  const button = analyzeAllButton(manual);
  assert.ok(button, 'manual mode renders the analyze-all button');
  button.props.onClick();
  assert.deepEqual(hits, ['all']);

  // A batch already running wins over the button, whatever the mode says.
  const manualRunning = render({ manual: true, analyzing: { total: 2, done: 1, failed: 0, current: 'src/a.js' } });
  assert.equal(analyzeAllButton(manualRunning), undefined);
  assert.ok(manualRunning.textOnly.includes(fill(dict.analyzingFiles, { done: 1, total: 1 })));

  // While the request is in flight the button reports the work and cannot be clicked twice.
  const busy = render({ manual: true, analyzeAllBusy: true, onAnalyzeAll: () => hits.push('again') });
  const busyButton = busy.elements.find(
    (node) => node.type === 'button' && fake.textOf(node).trim() === dict.explaining,
  );
  assert.ok(busyButton);
  assert.equal(busyButton.props.disabled, true);
  assert.equal(busyButton.props.onClick, undefined, 'a disabled button carries no click handler');
});

// ---------- v2: right-sidebar review tab ----------

test('a file row dot follows the per-file verdict; only unfinished files fall back to findings', () => {
  const { parts } = loadClient();

  // A finished analysis is authoritative: a pass with no findings is still a pass.
  assert.equal(parts.fileSeverityOf({
    status: 'done',
    explanation: { verdict: 'pass', issues: [] },
  }), 'pass');
  assert.equal(parts.fileSeverityOf({
    status: 'done',
    explanation: { verdict: 'suggest', issues: [] },
  }), 'suggest');
  assert.equal(parts.fileSeverityOf({
    status: 'done',
    explanation: { verdict: 'block', issues: [{ severity: 'block' }] },
  }), 'block');

  // Nothing decided yet: the findings the model already produced keep the dot meaningful.
  assert.equal(parts.fileSeverityOf({
    status: 'pending',
    explanation: { verdict: 'pass', issues: [{ severity: 'block' }] },
  }), 'block');
  assert.equal(parts.fileSeverityOf({
    status: 'error',
    explanation: { issues: [{ severity: 'suggest' }] },
  }), 'suggest');
  // A missing status is unfinished too.
  assert.equal(parts.fileSeverityOf({ explanation: { issues: [{ severity: 'block' }] } }), 'block');
  assert.equal(parts.fileSeverityOf({ status: 'pending' }), '');
  assert.equal(parts.fileSeverityOf(null), '');

  // The verdict wins over its own findings, in both directions.
  assert.equal(parts.fileSeverityOf({
    status: 'done',
    explanation: { verdict: 'pass', issues: [{ severity: 'block' }] },
  }), 'pass');
  assert.equal(parts.fileSeverityOf({
    status: 'done',
    explanation: { verdict: 'block', issues: [{ severity: 'suggest' }] },
  }), 'block');

  // An unknown or missing verdict is idle for the pill, so the row shows no dot either.
  assert.equal(parts.fileSeverityOf({
    status: 'done',
    explanation: { verdict: 'unknown', issues: [{ severity: 'block' }] },
  }), '');
  assert.equal(parts.fileSeverityOf({
    status: 'done',
    explanation: { issues: [{ severity: 'block' }] },
  }), '');
});

test('the pass dot uses the same green as the verdict pill', () => {
  const { parts } = loadClient();
  const base = cssRule(parts.CSS, '.prr-sev');
  const dot = cssRule(parts.CSS, '.prr-sev[data-sev="pass"]');
  const pill = cssRule(parts.CSS, '.prr-pill[data-tone="pass"]');
  assert.ok(dot, 'pass dot rule missing');
  // The dot has to stay visible: the shared rule owns its size and shape.
  assert.match(base, /width:6px/);
  assert.match(base, /height:6px/);
  assert.match(base, /border-radius/);
  assert.match(dot, /background:var\(--dsw-alias-state-success-primary\)/);
  assert.match(pill, /--dsw-alias-state-success-primary/, 'the pill keeps the same tone');
  // Exactly one pass rule: a later rewrite would silently override the color.
  assert.equal(parts.CSS.split('.prr-sev[data-sev="pass"]').length - 1, 1);
});

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

test('requestReviewTab opens through the public navigation controller', () => {
  const client = loadClient();
  const { parts } = client;
  const tab = { contentId: 'dsh-resource://pr-review/x' };

  // The public controller is the external entry path; it commits the tab.
  const calls = [];
  const ready = {
    openResource: (url, options) => calls.push([url, options.destination]),
    tabsIn: () => [tab],
  };
  assert.equal(parts.requestReviewTab({ get: (name) => (name === 'sidebarRight' ? ready : undefined) }, 'session-a', '/repo/example'), 'opened');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'dsh-resource://pr-review/%2Frepo%2Fexample');
  assert.equal(calls[0][1], 'sidebar');

  // The internal session-scoped opener is not an external entry path and must not be called.
  let internalCalls = 0;
  const internalOnly = {
    openResourceIn: () => { internalCalls += 1; },
    tabsIn: () => [],
  };
  assert.equal(parts.requestReviewTab({ get: (name) => (name === 'sidebarRight' ? internalOnly : undefined) }, 'session-a', '/repo/example'), 'unsupported');
  assert.equal(internalCalls, 0);

  // A tab that is not committed yet keeps the request queued.
  const slow = { openResource: () => {}, tabsIn: () => [] };
  assert.equal(parts.requestReviewTab({ get: (name) => (name === 'sidebarRight' ? slow : undefined) }, 'session-a', '/repo/example'), 'pending');

  // An unadopted surface is "still opening", not a failure: the caller keeps the request queued.
  // The app signals this with its "no session surface is mounted" message; keep this assertion
  // aligned with sidebar-right if that message changes.
  const adopting = {
    openResource: () => { throw new Error('sidebarRight: no session surface is mounted'); },
    tabsIn: () => [],
  };
  assert.equal(parts.requestReviewTab({ get: (name) => (name === 'sidebarRight' ? adopting : undefined) }, 'session-a', '/repo/example'), 'pending');

  // No session on screen yet: queue even when the navigation error is not the pending text.
  const offscreen = {
    mounted: { getSnapshot: () => undefined },
    openResource: () => { throw new Error('sidebarRight: no active docked pane'); },
    tabsIn: () => [],
  };
  assert.equal(parts.requestReviewTab({ get: (name) => (name === 'sidebarRight' ? offscreen : undefined) }, 'session-a', '/repo/example'), 'pending');

  // A real navigation failure stays visible as an error.
  const broken = {
    openResource: () => { throw new Error('sidebarRight: no registered tab type claims "x"'); },
    tabsIn: () => [],
  };
  assert.equal(parts.requestReviewTab({ get: (name) => (name === 'sidebarRight' ? broken : undefined) }, 'session-a', '/repo/example'), 'failed');

  assert.equal(parts.requestReviewTab({ get: () => undefined }, 'session-a', '/repo/example'), 'unsupported');
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

test('a historical round keeps its feedback but never renders the workspace comparison', () => {
  const client = loadClient();
  // H1：复审对比只属于审核工作面——即使轮次历史里残留旧的 delta 数据，历史轮也不渲染。
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
  assert.equal(deltaIndex, -1, 'a historical round never renders the workspace comparison');
  // No action buttons on a historical round.
  assert.doesNotMatch(textOnly, /检查实现者反馈/);
});

// ---------- §4.8: publish preview + 409 handling ----------

test('already-published preview offers the append-anyway path', () => {
  const client = loadClient();
  const { parts, fake } = client;
  const confirmed = [];
  const { textOnly, elements } = fake.render(fake.React.createElement(parts.PublishPreviewModal, {
    preview: {
      markdown: '# PR 评论正文',
      // The host still returns the comment language; the dialog no longer renders it.
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
  assert.doesNotMatch(textOnly, /语言\s*[:：]|Language\s*[:：]/i);
  assert.match(textOnly, /此轮结论已发布/);
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
      // Host-returned and intentionally unused by the dialog.
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
  assert.doesNotMatch(textOnly, /语言\s*[:：]|Language\s*[:：]/i);
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
  assert.match(textOnly, /改动概述/);
  assert.match(textOnly, /整体总结内容/);
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

test('PublishPreviewModal is a final confirmation without item checkboxes', () => {
  const { parts, fake } = loadClient();
  const t = translator(parts);
  const view = fake.render(fake.React.createElement(parts.PublishPreviewModal, {
    preview: {
      markdown: '# md',
      items: [{ id: 'b1', kind: 'blocker', file: 'a.js', line: 1, point: 'p' }],
      selectedIds: ['b1'],
      selectionSupported: true,
      round: 1,
      version: 1,
      conflict: '',
    },
    t,
    busy: false,
    refreshing: false,
    error: '',
    onConfirm: () => {},
    onCancel: () => {},
  }));
  assert.equal(view.elements.filter((element) => element.type === 'input').length, 0);
  assert.ok(view.textOnly.includes('# md'));
});

test('preview without selectable items still confirms the full comment', () => {
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
    refreshing: false,
    error: '',
    onConfirm: () => {},
    onCancel: () => {},
  }));
  assert.match(textOnly, /# md/);
  assert.equal(elements.filter((node) => node.type === 'input').length, 0);
  const confirm = elements.find(
    (node) => node.type === 'button' && fake.textOf(node) === '确认发布',
  );
  assert.ok(confirm, 'confirm button missing');
  assert.equal(confirm.props.disabled, false);
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

  // The conclusion entry hugs the list instead of pinning to the rail bottom, and the
  // rail tones it by phase.
  assert.ok(filelist.includes('flex:0 1 auto'));
  assert.ok(!cssRule(css, '.prr-files-tail').includes('margin-top:auto'));
  assert.ok(css.includes('.prr-navrow-badge[data-tone="ok"]'));
  const spinnerSm = cssRule(css, '.prr-spinner-sm');
  assert.ok(spinnerSm, 'small spinner rule missing');
  assert.ok(spinnerSm.includes('animation'));
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

test('every shipped chunk is loaded by the entry and named for the host\'s chunk route', () => {
  const client = loadClient();
  const onDisk = readdirSync(new URL('..', import.meta.url))
    .filter((name) => /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/.test(name)
      && name !== 'client.js'
      && !name.startsWith('client.node.'))
    .sort();
  assert.deepEqual(plain(client.plugin.__test.chunkFiles).sort(), onDisk,
    'the entry must require.async every chunk the package ships, and nothing else');
});

test('the entry composes every area once its chunks arrive', async () => {
  const client = loadClient();
  const modules = await client.plugin.__test.ready;
  assert.ok(modules, 'the chunk graph composes');
  for (const area of ['i18n', 'core', 'components', 'conclusion', 'preview', 'hooks', 'views', 'workspace', 'sidebar', 'entries']) {
    assert.ok(modules[area], `${area} is composed`);
  }
  assert.equal(modules.i18n.DICT.zh.title, 'PR 审查');
  assert.equal(typeof modules.workspace.ReviewWorkspace, 'function');
  assert.equal(typeof modules.sidebar.ReviewSidebar, 'function');
});

test('the workspace view renders the open file in the narrow sidebar layout', () => {
  const client = loadClient();
  const { parts, fake } = client;
  const t = translator(parts);
  const review = {
    number: 7,
    round: 1,
    status: 'done',
    headSha: 'abc1234',
    report: {},
    files: [{ path: 'src/a.js', status: 'modified', additions: 12, deletions: 3 }],
    explanations: [],
    published: [],
    pullChat: [],
    comment: null,
  };
  const diff = 'diff --git a/src/a.js b/src/a.js\n'
    + '--- a/src/a.js\n'
    + '+++ b/src/a.js\n'
    + '@@ -1,2 +1,2 @@\n'
    + '-old\n'
    + '+new\n';
  // The model the container builds: every field is required, so a missing one fails loudly.
  const model = {
    t,
    onClose: null,
    inputActions: null,
    embedded: false,
    sidebar: true,
    rootRef: { current: null },
    list: { prs: [{ number: 7, title: 'Fix', headSha: 'abc1234' }], reviews: {}, lastPollAt: 0, autoAnalyze: true },
    listError: '',
    listBusy: false,
    prNumber: 7,
    setPrNumber: () => {},
    review,
    reviewError: '',
    filePath: 'src/a.js',
    contextBusy: false,
    contextError: '',
    contextBlocked: false,
    setContextAttempt: () => {},
    currentExplanation: { chat: [], logic: '', walkthrough: [] },
    suggestionNotice: '',
    reviewRounds: [],
    latestRoundNumber: 1,
    selectedRoundNumber: 1,
    selectRound: () => {},
    mode: 'file',
    setMode: () => {},
    sidebarPane: 'diff',
    setSidebarPane: () => {},
    sidebarWidth: 700,
    filesWidth: 0,
    setFilesWidth: () => {},
    detailWidth: 0,
    setDetailWidth: () => {},
    startReview: () => {},
    refreshPulls: () => {},
    openFile: () => {},
    requestAnalyzeAll: () => {},
    analyzeAllBusy: false,
    orderedFiles: review.files,
    historicalView: false,
    publishError: '',
    feedbackError: '',
    fileDiffError: '',
    fileContentError: '',
    overlayDraft: '',
    overlayBusy: false,
    setOverlayDraft: () => {},
    sendOverlayMessage: () => {},
    preview: null,
    previewModalOpen: false,
    previewBusy: false,
    previewError: '',
    previewRefreshBusy: false,
    publishBusy: false,
    closePreview: () => {},
    togglePreviewItem: () => {},
    selectAllPreviewItems: () => {},
    selectNonePreviewItems: () => {},
    submitPublish: () => {},
    walkFloat: null,
    activeHunk: 0,
    closeWalkFloat: () => {},
    expandHunkContext: () => {},
    askInChat: () => {},
    currentLogic: '',
    currentWalkthrough: [],
    openWalkFloat: () => {},
    showFullFile: false,
    fileContentBusy: false,
    fileContent: null,
    toggleFullFile: () => {},
    wrap: false,
    setWrap: () => {},
    fileDiff: { diff, truncated: false },
    diffScrollRef: { current: null },
    expandedHunks: new Set(),
    collapseHunkContext: () => {},
    setActiveHunk: () => {},
  };

  const view = fake.render(fake.React.createElement(parts.WorkspaceView, { model }));
  // 700px is below the 780px threshold, so this must be the collapsed-analysis layout.
  // Assert on rendered elements, not on the HTML: the inline stylesheet contains the same
  // class names as text, and the fake renderer emits `className`, not `class`.
  const classes = new Set(view.elements.flatMap((element) => (
    typeof element.props?.className === 'string' ? element.props.className.split(' ') : []
  )));
  assert.ok(classes.has('prr-subseg'), 'a narrow sidebar offers the diff/analysis toggle');
  assert.ok(classes.has('prr-diffcol'), 'the open file renders its diff column');
  assert.ok(classes.has('prr-overview-pane'), 'the narrow layout keeps one content pane');
  assert.ok(!classes.has('prr-detail'), 'the narrow layout skips the analysis aside');
  assert.ok(view.textOnly.includes('src/a.js'), 'the diff head names the open file');
  assert.ok(view.textOnly.includes('+12') && view.textOnly.includes('-3'), 'the diff head shows the file stats');
  assert.ok(view.textOnly.includes(t('wrapOn')), 'the wrap toggle uses the active locale');

  // The conclusion page replaces the file view even in a narrow sidebar: one content pane,
  // no analysis aside, and the diff/analysis toggle loses its meaning and disappears.
  const conclusionModel = {
    ...model,
    mode: 'conclusion',
    filePath: '',
    concludeBusy: false,
    concluding: null,
    concludeCancelBusy: false,
    cancelConclude: () => {},
    reviewBusy: false,
    runConclude: () => {},
    explainedCount: 0,
    fileFindings: [],
    phase: { phase: 'published', progress: null, nextAction: 'append', version: 1 },
    publishBusy: false,
    previewBusy: false,
    previewRefreshBusy: false,
    feedbackBusy: false,
    checkFeedback: () => {},
    preview: null,
    togglePreviewItem: () => {},
    staleInfo: null,
    requestPreview: () => {},
  };
  const conclusion = fake.render(fake.React.createElement(parts.WorkspaceView, { model: conclusionModel }));
  const conclusionClasses = new Set(conclusion.elements.flatMap((element) => (
    typeof element.props?.className === 'string' ? element.props.className.split(' ') : []
  )));
  assert.ok(conclusionClasses.has('prr-overview-pane'), 'the conclusion page renders as the single content pane');
  assert.ok(!conclusionClasses.has('prr-detail'), 'the conclusion page skips the analysis aside');
  assert.ok(!conclusionClasses.has('prr-subseg'), 'the conclusion page drops the narrow diff/analysis toggle');
  assert.ok(conclusion.elements.some((element) => element.props?.className === 'prr-files'), 'the file list stays visible');
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

// ---------- unverified section (removed) ----------

test('file detail no longer renders an unverified section', () => {
  const client = loadClient();
  const { parts, fake } = client;
  const { textOnly, elements } = fake.render(fake.React.createElement(parts.FileDetailPanel, {
    t: translator(parts),
    filePath: 'src/a.js',
    explanation: {
      status: 'done',
      explanation: {
        verdict: 'pass',
        summary: '文件摘要',
        logic: '',
        changes: '',
        issues: [],
        unverified: [{ point: '可疑调用方', missing: '缺少 callers 证据' }],
        refuted: [{ point: '内部审计项', reason: '已证伪' }],
      },
    },
    onExplain: () => {},
  }));
  assert.doesNotMatch(textOnly, /未验证项/);
  assert.doesNotMatch(textOnly, /可疑调用方/);
  assert.doesNotMatch(textOnly, /缺少证据/);
  assert.doesNotMatch(textOnly, /内部审计项/);
  assert.ok(!elements.some((node) => String(node.props?.className ?? '').includes('prr-unverified')));
});

test('the zh and en tables expose the same keys', () => {
  const client = loadClient();
  const { DICT } = client.parts;
  assert.deepEqual(Object.keys(DICT.zh).sort(), Object.keys(DICT.en).sort());
});

test('the overview no longer renders a reading-order section', () => {
  const client = loadClient();
  const review = makeReview({
    report: {
      verdict: 'suggest',
      summary: '报告',
      risks: [],
      refuted: [],
      order: [{ file: 'src/a.js', reason: '这是排序理由不该出现在总览' }],
      focus: {},
    },
  });
  const { textOnly } = renderOverview(client, review);
  assert.doesNotMatch(textOnly, /审查顺序/);
  assert.doesNotMatch(textOnly, /这是排序理由不该出现在总览/);
});

test('derivePhase folds host state into one phase', () => {
  const { parts } = loadClient();
  const base = makeReview({ round: 2 });
  assert.equal(parts.derivePhase({ ...base, status: 'error' }, null).phase, 'error');
  assert.equal(parts.derivePhase({ ...base, status: 'reviewing' }, null).phase, 'reviewing');
  assert.equal(
    parts.derivePhase({ ...base, concluding: { stage: 'model', startedAt: 1 } }, null).phase,
    'concluding',
  );

  // Batch progress is restated in the global ledger: done = analyzed files, total = all
  // changed files — the same two numbers the completeness line shows, so the header badge
  // and the overview can never disagree about how much is left.
  const analyzing = makeReview({
    status: 'done',
    files: [
      { path: 'src/a.js', status: 'modified', additions: 1, deletions: 0 },
      { path: 'src/b.js', status: 'modified', additions: 1, deletions: 0 },
      { path: 'src/c.js', status: 'modified', additions: 1, deletions: 0 },
    ],
    explanations: [
      { file: 'src/a.js', status: 'done', error: null, explanation: { verdict: 'pass', summary: 'x', issues: [] }, chat: [], updatedAt: 1 },
      { file: 'src/b.js', status: 'done', error: null, explanation: { verdict: 'pass', summary: 'y', issues: [] }, chat: [], updatedAt: 2 },
      { file: 'src/c.js', status: 'error', error: 'boom', explanation: null, chat: [], updatedAt: 3 },
    ],
    analyzing: { done: 12, total: 30, failed: 1, current: 'src/c.js' },
  });
  const phase = parts.derivePhase(analyzing, null);
  assert.equal(phase.phase, 'analyzing');
  assert.deepEqual(plain(phase.progress), { done: 2, total: 3, failed: 1 });
  assert.equal(phase.nextAction, null);
  assert.equal(parts.derivePhase(analyzing, null, { manual: true }).nextAction, 'analyzeAll');

  // A negative failed count folds to 0; a record without files falls back to the batch total.
  const clamped = parts.derivePhase(
    { ...base, status: 'done', analyzing: { done: 99, total: 30, failed: -1, current: 'x' } },
    null,
  );
  assert.deepEqual(plain(clamped.progress), { done: 0, total: 1, failed: 0 });

  assert.equal(parts.derivePhase({ ...base, conclusion: null, conclusionAt: 0 }, null).phase, 'ready');
  assert.equal(parts.derivePhase({ ...base, conclusion: null, conclusionAt: 0 }, null).nextAction, 'conclude');

  // A missing review falls back to the empty record; staleness only decorates
  // concluded/published states, so a stale report without a conclusion stays ready.
  assert.deepEqual(plain(parts.derivePhase(null, null)), {
    phase: 'ready', progress: null, nextAction: 'conclude', version: 0,
  });
  const staleInfo = { createdAt: 1, files: ['src/a.js'], reportNewer: false, count: 1 };
  const staleReady = parts.derivePhase({ ...base, conclusion: null, conclusionAt: 0 }, staleInfo);
  assert.equal(staleReady.phase, 'ready');
  assert.equal(staleReady.nextAction, 'conclude');
});

test('derivePhase distinguishes concluded / stale / published states', () => {
  const { parts } = loadClient();
  const concluded = makeReview({
    round: 2,
    conclusion: { verdict: 'suggest', summary: 's', blockers: [], suggestions: [], nextSteps: [] },
    conclusionAt: 5000,
  });
  assert.equal(parts.derivePhase(concluded, null).phase, 'concluded');
  assert.equal(parts.derivePhase(concluded, null).nextAction, 'publish');
  assert.equal(parts.derivePhase(concluded, null).version, 1);

  const staleInfo = { createdAt: 1, files: ['src/a.js'], reportNewer: false, count: 1 };
  assert.equal(parts.derivePhase(concluded, staleInfo).phase, 'concluded-stale');
  assert.equal(parts.derivePhase(concluded, staleInfo).nextAction, 'regenerate');

  const published = makeReview({
    round: 2,
    conclusion: { verdict: 'suggest', summary: 's', blockers: [], suggestions: [], nextSteps: [] },
    conclusionAt: 5000,
    published: [{ id: 'p1', round: 2, version: 1, publishedAt: 6000 }],
  });
  assert.equal(parts.derivePhase(published, null).phase, 'published');
  assert.equal(parts.derivePhase(published, null).nextAction, 'append');
  assert.equal(parts.derivePhase(published, staleInfo).phase, 'published-stale');
  assert.equal(parts.derivePhase(published, staleInfo).nextAction, 'regenerate');
});

test('derivePhase combination order: error first, version kept, stale before concluded', () => {
  const { parts } = loadClient();
  const concluded = makeReview({
    round: 2,
    conclusion: { verdict: 'suggest', summary: 's', blockers: [], suggestions: [], nextSteps: [] },
    conclusionAt: 5000,
  });
  const staleInfo = { createdAt: 1, files: ['src/a.js'], reportNewer: false, count: 1 };

  // Error wins over everything — including a running analyze batch — but the version
  // still reports the newest conclusion version instead of resetting to v0.
  const errored = { ...concluded, status: 'error' };
  assert.equal(parts.derivePhase(errored, null).phase, 'error');
  assert.equal(parts.derivePhase(errored, null).version, 1);
  const erroredAnalyzing = { ...errored, analyzing: { done: 0, total: 2, failed: 0, current: 'src/a.js' } };
  assert.equal(parts.derivePhase(erroredAnalyzing, null).phase, 'error');

  // A concluded round that starts re-analyzing folds back to the analyzing phase, version kept.
  const analyzing = { ...concluded, analyzing: { done: 1, total: 2, failed: 0, current: 'src/b.js' } };
  assert.equal(parts.derivePhase(analyzing, null).phase, 'analyzing');
  assert.equal(parts.derivePhase(analyzing, null).version, 1);

  // Stale is judged before the concluded fallback: the same record flips to regenerate.
  const stale = parts.derivePhase(concluded, staleInfo);
  assert.equal(stale.phase, 'concluded-stale');
  assert.equal(stale.nextAction, 'regenerate');
  assert.equal(stale.version, 1);
});

test('phase and conclusion badge text follow the phase', () => {
  const { parts } = loadClient();
  const t = (key) => key;
  const analyzing = { phase: 'analyzing', progress: { done: 12, total: 30, failed: 2 }, nextAction: null, version: 0 };
  assert.equal(
    parts.phaseStateText(analyzing, t),
    'badgeAnalyzing badgeAnalyzingFailed',
  );

  // The remaining status-bar branches, including the silent fall-through to badgeDone.
  assert.equal(parts.phaseStateText(null, t), '');
  assert.equal(parts.phaseStateText({ phase: 'reviewing' }, t), 'badgeReviewing');
  assert.equal(parts.phaseStateText({ phase: 'concluding' }, t), 'badgeConcluding');
  assert.equal(parts.phaseStateText({ phase: 'error' }, t), 'badgeError');
  assert.equal(
    parts.phaseStateText({ phase: 'analyzing', progress: { done: 3, total: 9, failed: 0 } }, t),
    'badgeAnalyzing',
  );
  assert.equal(parts.phaseStateText({ phase: 'concluded', version: 1 }, t), 'badgeDone');
  assert.equal(parts.phaseStateText({ phase: 'ready', nextAction: 'conclude' }, t), 'badgeDone');

  // Conclusion-side badge: version-aware keys while a conclusion exists, none otherwise.
  assert.equal(parts.conclusionBadgeText(null, t), 'badgeConclusionNone');
  assert.equal(parts.conclusionBadgeText({ phase: 'ready', version: 0 }, t), 'badgeConclusionNone');
  assert.equal(parts.conclusionBadgeText({ phase: 'error', version: 0 }, t), 'badgeConclusionNone');
  assert.equal(parts.conclusionBadgeText({ phase: 'concluded', version: 3 }, t), 'badgeConclusionDraft');
  assert.equal(parts.conclusionBadgeText({ phase: 'concluded-stale', version: 2 }, t), 'badgeConclusionStale');
  assert.equal(parts.conclusionBadgeText({ phase: 'published', version: 4 }, t), 'badgePublished');
  assert.equal(parts.conclusionBadgeText({ phase: 'published-stale', version: 5 }, t), 'badgePublishedStale');

  // The overview-entry variant treats the process as its own subject: the conclude job
  // never leaks into it, so concluding falls through to the plain review-done text.
  assert.equal(parts.overviewStateText(null, t), '');
  assert.equal(parts.overviewStateText({ phase: 'error' }, t), 'badgeError');
  assert.equal(parts.overviewStateText({ phase: 'reviewing' }, t), 'badgeReviewing');
  assert.equal(
    parts.overviewStateText({ phase: 'analyzing', progress: { done: 3, total: 9, failed: 0 } }, t),
    'badgeAnalyzing',
  );
  assert.equal(parts.overviewStateText({ phase: 'concluding' }, t), 'badgeDone');
  assert.equal(parts.overviewStateText({ phase: 'ready' }, t), 'badgeDone');
  assert.equal(parts.overviewStateText({ phase: 'concluded' }, t), 'badgeDone');
  assert.equal(parts.overviewStateText({ phase: 'published' }, t), 'badgeDone');
});

test('conclusionBadgeTone maps phases to badge tones', () => {
  const { parts } = loadClient();
  const tone = (phase) => parts.conclusionBadgeTone({ phase, progress: null, nextAction: null, version: 0 });
  assert.equal(tone('ready'), 'none');
  assert.equal(tone('reviewing'), 'none');
  assert.equal(tone('analyzing'), 'none');
  assert.equal(parts.conclusionBadgeTone(null), 'none');
  assert.equal(tone('concluding'), 'info');
  assert.equal(tone('concluded'), 'info');
  assert.equal(tone('concluded-stale'), 'warn');
  assert.equal(tone('published'), 'ok');
  assert.equal(tone('published-stale'), 'warn');
  assert.equal(tone('error'), 'danger');
});

test('processBadgeTone maps phases to the overview entry tones', () => {
  const { parts } = loadClient();
  const tone = (phase) => parts.processBadgeTone({ phase, progress: null, nextAction: null, version: 0 });
  assert.equal(parts.processBadgeTone(null), 'none');
  assert.equal(tone('error'), 'danger');
  assert.equal(tone('reviewing'), 'info');
  assert.equal(tone('analyzing'), 'info');
  assert.equal(tone('concluding'), 'ok');
  assert.equal(tone('ready'), 'ok');
  assert.equal(tone('concluded'), 'ok');
  assert.equal(tone('concluded-stale'), 'ok');
  assert.equal(tone('published'), 'ok');
  assert.equal(tone('published-stale'), 'ok');
});

test('filesBadgeTone maps the analysis progress to header tones', () => {
  const { parts } = loadClient();
  assert.equal(parts.filesBadgeTone({ done: 3, total: 14, failed: 0, current: 'x' }, 0, 3, 14), 'info');
  assert.equal(parts.filesBadgeTone({ done: 1, total: 2, failed: 1 }, 1, 1, 2), 'info');
  assert.equal(parts.filesBadgeTone(null, 2, 5, 8), 'danger');
  assert.equal(parts.filesBadgeTone(null, 0, 14, 14), 'ok');
  assert.equal(parts.filesBadgeTone(null, 0, 0, 0), 'none');
  assert.equal(parts.filesBadgeTone(null, 0, 5, 14), 'none');
});

test('shouldAutoSwitchPhase only lands on the conclusion after the conclude job finishes', () => {
  const { parts } = loadClient();
  const decides = parts.shouldAutoSwitchPhase;
  // Without a finishing conclude job nothing switches, whatever the target phase is.
  assert.equal(decides('ready', 'concluded', 'overview', true), false);
  assert.equal(decides('reviewing', 'published', 'overview', true), false);
  // concluding → an intermediate phase is not a finish: stay put.
  assert.equal(decides('concluding', 'analyzing', 'overview', true), false);
  assert.equal(decides('concluding', 'ready', 'overview', true), false);
  // Each terminal phase of a finished conclude job lands on the conclusion page.
  for (const terminal of ['concluded', 'concluded-stale', 'published', 'published-stale']) {
    assert.equal(decides('concluding', terminal, 'overview', true), true, terminal);
  }
  // A reviewer reading a file is not interrupted.
  assert.equal(decides('concluding', 'concluded', 'file', true), false);
  assert.equal(decides('concluding', 'concluded', 'conclusion', true), false);
  // Neither is a reviewer pinned to a historical round.
  assert.equal(decides('concluding', 'concluded', 'overview', false), false);
});

test('overviewFooterVisible mounts the dock only in the actionable phases', () => {
  const { parts } = loadClient();
  const visible = parts.overviewFooterVisible;
  // Ready (the first conclusion is the next step) and concluding (progress + cancel) act.
  assert.equal(visible({ phase: 'ready', progress: null, nextAction: 'conclude', version: 0 }), true);
  assert.equal(visible({ phase: 'concluding', progress: null, nextAction: null, version: 0 }), true);
  // Once a conclusion exists its actions belong to the conclusion page — dock clears.
  for (const settled of ['concluded', 'concluded-stale', 'published', 'published-stale']) {
    assert.equal(visible({ phase: settled, progress: null, nextAction: null, version: 1 }), false, settled);
  }
  // The remaining pipeline states carry their own surfaces; no footer here either.
  for (const running of ['analyzing', 'reviewing', 'error']) {
    assert.equal(visible({ phase: running, progress: null, nextAction: null, version: 0 }), false, running);
  }
  assert.equal(visible(null), false);
  assert.equal(visible(undefined), false);
});



test('navigation redesign css ships the new selectors', () => {
  const { parts } = loadClient();
  assert.ok(parts.CSS.includes('.prr-files-tail'));
  assert.ok(parts.CSS.includes('.prr-phasebar'));
  assert.ok(parts.CSS.includes('.prr-finding-head'));
  assert.ok(cssRule(parts.CSS, '.prr-completeness').includes('padding'));
});

test('PhaseBar renders the round and the phase text', () => {
  const { parts, fake } = loadClient();
  const t = translator(parts);
  const view = fake.render(fake.React.createElement(parts.PhaseBar, {
    phase: { phase: 'analyzing', progress: { done: 12, total: 30, failed: 0 }, nextAction: null, version: 0 },
    round: 2,
    t,
  }));
  assert.ok(view.textOnly.includes('第 2 轮'));
  assert.ok(view.textOnly.includes('分析 12/30'));
  // The analyzing bar spins; a settled phase renders no spinner at all.
  assert.ok(view.elements.some((element) => String(element.props?.className ?? '').includes('prr-spinner')));
  const settled = fake.render(fake.React.createElement(parts.PhaseBar, {
    phase: { phase: 'ready', progress: null, nextAction: null, version: 0 },
    round: 2,
    t,
  }));
  assert.ok(!settled.elements.some((element) => String(element.props?.className ?? '').includes('prr-spinner')));
  const empty = fake.render(fake.React.createElement(parts.PhaseBar, { phase: null, round: 1, t }));
  assert.equal(empty.textOnly, '');
});

test('findingsOf flattens and orders file findings', () => {
  const { parts } = loadClient();
  // 合并形状：每条意见四键，suggestion '' 表示无建议。
  const groups = [
    {
      file: 'src/b.js',
      findings: [
        { severity: 'suggest', point: 'b 问题', suggestion: 'b 这样改', line: 3 },
        { severity: 'suggest', point: 'b 提示', suggestion: '', line: 0 },
      ],
    },
    {
      file: 'src/a.js',
      findings: [
        { severity: 'block', point: 'a 阻塞', suggestion: 'a 先修这个', line: 8 },
        { severity: 'suggest', point: 'a 问题', suggestion: '', line: 2 },
      ],
    },
  ];
  const rows = parts.findingsOf(groups);
  assert.deepEqual(plain(rows.map((row) => [row.severity, row.file])), [
    ['block', 'src/a.js'],
    ['suggest', 'src/a.js'],
    ['suggest', 'src/b.js'],
    ['suggest', 'src/b.js'],
  ]);
  assert.equal(rows[0].line, 8);
  assert.equal(rows[0].suggestion, 'a 先修这个');
  assert.equal(rows[1].suggestion, '');
  assert.equal(parts.findingsOf([]).length, 0);
});

test('fileFindings derives one merged group per analyzed file from the review', () => {
  const { parts, fake } = loadClient();
  // 真实 review 形状：explanations[].explanation.issues 四键，没有 suggestions 键。
  const review = makeReview({
    round: 1,
    report: {
      verdict: 'suggest',
      summary: '总',
      risks: [],
      order: [{ file: 'src/a.js', reason: '入口' }, { file: 'src/b.js', reason: '工具类' }],
    },
    explanations: [
      {
        file: 'src/b.js',
        status: 'done',
        explanation: {
          verdict: 'suggest', summary: '', logic: '', changes: '',
          issues: [{ severity: 'block', point: 'b 会崩', suggestion: 'b 加判空', line: 3 }],
        },
      },
      {
        file: 'src/a.js',
        status: 'done',
        explanation: {
          verdict: 'pass', summary: '', logic: '', changes: '',
          issues: [{ severity: 'suggest', point: 'a 提示', suggestion: '', line: 2 }],
        },
      },
      { file: 'src/c.js', status: 'error', explanation: null },
    ],
  });
  function Probe() {
    const { fileFindings } = parts.useWorkspaceDerived(review, '');
    return fake.React.createElement('div', null, JSON.stringify(fileFindings));
  }
  const { textOnly } = fake.render(fake.React.createElement(Probe));
  // 每个分析过的文件一组，组内只有一份 findings，按阅读顺序排列；未完成/空分析不产生组。
  assert.deepEqual(JSON.parse(textOnly), [
    { file: 'src/a.js', findings: [{ severity: 'suggest', point: 'a 提示', suggestion: '', line: 2 }] },
    { file: 'src/b.js', findings: [{ severity: 'block', point: 'b 会崩', suggestion: 'b 加判空', line: 3 }] },
  ]);
});

test('FindingList renders rows, block first, with the suggestion block in the detail', () => {
  const { parts, fake } = loadClient();
  const t = translator(parts);
  // 真实四键形状：带建议与空建议混装。
  const groups = [{
    file: 'src/a.js',
    findings: [
      { severity: 'suggest', point: 'a 提示', suggestion: '', line: 2 },
      { severity: 'block', point: 'a 阻塞', suggestion: 'a 加判空', line: 8 },
    ],
  }];
  const empty = fake.render(fake.React.createElement(parts.FindingList, { groups: [], t, onOpenFile: () => {} }));
  assert.ok(empty.textOnly.includes('未发现问题'));

  const view = fake.render(fake.React.createElement(parts.FindingList, { groups, t, onOpenFile: () => {} }));
  // block 行排在前；头部 pill 一律走 VerdictPill，收起态不再有建议 tag 分支。
  const heads = view.elements.filter((node) => node.props.className === 'prr-finding-head');
  assert.equal(heads.length, 2);
  assert.match(heads[0].props.title, /a 阻塞/);
  assert.equal(
    view.elements.some((node) => node.props.className === 'prr-tag'),
    false,
    'collapsed heads carry verdict pills only',
  );

  // fake React 的 setState 是 noop，展开态靠临时接管 useState 渲染（渲染完立即还原）：
  // 只替换第一次调用（openKey），后续调用回落到原始 useState——未来加第二个 hook 不会静默错乱。
  const originalUseState = fake.React.useState;
  const openWith = (key) => {
    let n = 0;
    fake.React.useState = (...args) => (n++ === 0 ? [key, () => {}] : originalUseState(...args));
    try {
      return fake.render(fake.React.createElement(parts.FindingList, { groups, t, onOpenFile: () => {} }));
    } finally {
      fake.React.useState = originalUseState;
    }
  };
  // 展开 block 行（key = file-line-index）：detail 里有建议块。
  const opened = openWith('src/a.js-8-0');
  const detail = opened.elements.find((node) => node.props.className === 'prr-finding-detail');
  assert.ok(detail, 'the opened row renders its detail');
  assert.match(fake.textOf(detail), /a 阻塞/);
  assert.match(fake.textOf(detail), /a 加判空/);
  const openTags = opened.elements.filter((node) => node.props.className === 'prr-tag');
  assert.equal(openTags.length, 1, 'only the suggestion-carrying row renders the suggestion block');
  // 展开无建议行：detail 里没有建议块。
  const openedPlain = openWith('src/a.js-2-1');
  assert.ok(
    openedPlain.elements.every((node) => node.props.className !== 'prr-tag'),
    'a row without a suggestion renders no suggestion block',
  );
});

test('cleanCountOf counts finished analyses without issues', () => {
  const { parts } = loadClient();
  const review = {
    explanations: [
      { file: 'a.js', status: 'done', explanation: { issues: [] } },
      { file: 'b.js', status: 'done', explanation: { issues: [{ severity: 'block', point: 'x' }] } },
      { file: 'c.js', status: 'error', explanation: null },
    ],
  };
  assert.deepEqual(plain(parts.cleanCountOf(review)), { done: 2, clean: 1, failed: 1 });
});

test('overviewFooter gates publish and notices by page', () => {
  const { parts } = loadClient();
  const t = translator(parts);
  const baseProps = {
    t,
    review: { publishing: false },
    concludeBusy: false, reviewBusy: false, publishBusy: false, previewBusy: false,
    cancelBusy: false, concluding: null,
    onCancelConclude: () => {}, onConclude: () => {}, onPublish: () => {},
    comment: null, autoReconclude: false,
    explainedCount: 0, totalFiles: 1,
  };
  const derived = (page) => ({
    report: makeReport(),
    pull: { url: 'https://example.test/pr/7' },
    selectedVersion: makeVersion(1, 's'),
    staleInfo: null,
    isCurrent: true,
    hasVersion: true,
    selectedPublished: false,
    page,
  });

  const overview = parts.overviewFooter(baseProps, derived('overview'));
  const overviewLabels = [];
  for (const element of overview.actions.props.children) {
    if (element !== null && element.props?.label !== undefined) overviewLabels.push(element.props.label);
  }
  assert.ok(overviewLabels.includes(t('reconclude')));
  assert.ok(!overviewLabels.includes(t('publishComment')));
  assert.equal(overview.notice, null);

  const conclusion = parts.overviewFooter(baseProps, derived('conclusion'));
  const conclusionLabels = [];
  for (const element of conclusion.actions.props.children) {
    if (element !== null && element.props?.label !== undefined) conclusionLabels.push(element.props.label);
  }
  assert.ok(conclusionLabels.includes(t('publishComment')));
  assert.notEqual(conclusion.notice, null);
});

test('OverviewPage shows digest, findings and completeness — no initial risks, no verdict', () => {
  const { parts, fake } = loadClient();
  const t = translator(parts);
  const review = makeReview({ round: 1 });
  const view = fake.render(fake.React.createElement(parts.OverviewPage, {
    review,
    t,
    selectedRoundNumber: null,
    onOpenFile: () => {},
    explainedCount: 1,
    totalFiles: 1,
    fileFindings: [{
      file: 'src/a.js',
      findings: [
        { severity: 'block', point: 'a 阻塞', suggestion: 'a 加判空', line: 8 },
        { severity: 'suggest', point: 'a 提示', suggestion: '', line: 2 },
      ],
    }],
    feedbackBusy: false,
    onCheckFeedback: () => {},
  }));
  const text = view.textOnly;
  assert.ok(text.includes('整体总结内容'));
  assert.ok(!text.includes('总体初筛风险'));
  assert.ok(!text.includes('初筛风险点'));
  assert.ok(text.includes('审查发现'));
  // 合并后每组只有一份 findings，总览计数即意见条数（不再叠加建议）。
  assert.ok(text.includes('审查发现 · 2'));
  assert.ok(text.includes('src/a.js:8'));
  assert.ok(text.includes('审查完备性'));
  assert.ok(text.includes('1/1'));
});

test('OverviewPage historical rounds keep the fix record and show the digest placeholder', () => {
  const { parts, fake } = loadClient();
  const t = translator(parts);
  const pinned = makeRound(2, {
    feedback: { comments: [{ id: 'c1', author: 'dev', createdAt: 'x', body: '已修复' }], notes: [] },
  });
  // Round 2 is pinned while round 3 is the latest, so the selected round is historical.
  const review = makeReview({ round: 3, roundHistory: [makeRound(1), pinned, makeRound(3)] });
  const view = fake.render(fake.React.createElement(parts.OverviewPage, {
    review,
    t,
    selectedRoundNumber: 2,
    onOpenFile: () => {},
    explainedCount: 0,
    totalFiles: 0,
    fileFindings: [],
    feedbackBusy: false,
    onCheckFeedback: () => {},
  }));
  assert.ok(view.textOnly.includes('已修复'));
  assert.ok(view.textOnly.includes('历史轮次不含改动概述'));
});

test('OverviewPage keeps its hook order across pending/historical/current transitions', () => {
  const { parts, fake } = loadClient();
  const t = translator(parts);
  const props = (review, selectedRoundNumber) => ({
    review, t, selectedRoundNumber,
    onOpenFile: () => {}, explainedCount: 0, totalFiles: 0, fileFindings: [],
    feedbackBusy: false, onCheckFeedback: () => {},
    concludeBusy: false, reviewBusy: false, onConclude: () => {},
  });
  const result = fake.rerender(parts.OverviewPage, [
    props(makeReview({ round: 2, report: null, roundHistory: [makeRound(1), makeRound(2)] }), null),
    props(makeReview({ round: 2, roundHistory: [makeRound(1), makeRound(2)] }), 1),
    props(makeReview({ round: 2, roundHistory: [makeRound(1), makeRound(2)] }), null),
  ]);
  assert.equal(new Set(result.counts).size, 1);
  // The hook KIND sequence must match across the three transitions too: a swap that keeps
  // the count stable is still hooks-order drift. (The fake lives in this test realm, so no
  // plain() crossing is needed.)
  assert.deepEqual(result.kinds[0], result.kinds[1]);
  assert.deepEqual(result.kinds[1], result.kinds[2]);
});

test('ConclusionPage renders the pending card and the published conclusion', () => {
  const { parts, fake } = loadClient();
  const t = translator(parts);
  const pending = fake.render(fake.React.createElement(parts.ConclusionPage, {
    review: makeReview({ round: 1, conclusion: null, conclusionAt: 0, coverage: { analyzed: 0, total: 2 } }),
    t,
    selectedRoundNumber: null,
    onOpenFile: () => {},
    explainedCount: 0,
    totalFiles: 2,
    concludeBusy: false,
    reviewBusy: false,
    onConclude: () => {},
    concluding: null,
    cancelBusy: false,
    onCancelConclude: () => {},
    preview: null,
    onToggleInclude: () => {},
    publishBusy: false,
    previewBusy: false,
    previewRefreshBusy: false,
    feedbackBusy: false,
    onCheckFeedback: () => {},
  }));
  assert.ok(pending.textOnly.includes('结论待生成'));
  assert.ok(pending.textOnly.includes('0/2'));

  const version = makeVersion(1, '最终结论摘要', { verdict: 'block' });
  const round = makeRound(1, { conclusions: [version] });
  const done = fake.render(fake.React.createElement(parts.ConclusionPage, {
    review: makeReview({ round: 1, roundHistory: [round], conclusion: version.conclusion, conclusionAt: 1000 }),
    t,
    selectedRoundNumber: null,
    onOpenFile: () => {},
    explainedCount: 1,
    totalFiles: 1,
    concludeBusy: false,
    reviewBusy: false,
    onConclude: () => {},
    concluding: null,
    cancelBusy: false,
    onCancelConclude: () => {},
    preview: null,
    onToggleInclude: () => {},
    publishBusy: false,
    previewBusy: false,
    previewRefreshBusy: false,
    feedbackBusy: false,
    onCheckFeedback: () => {},
  }));
  assert.ok(done.textOnly.includes('最终结论摘要'));

  // The cross-round record (delta) belongs to the overview only: a concluded round 2 with a
  // non-null delta renders the conclusion without any 复审对比 block.
  const delta = { previousRound: 1, round: 2, resolved: [], stillOpen: [{ file: 'a.js', point: 'x' }] };
  const withDelta = fake.render(fake.React.createElement(parts.ConclusionPage, {
    review: makeReview({
      round: 2,
      roundHistory: [makeRound(1), makeRound(2, { conclusions: [makeVersion(1, '第二轮最终结论')], delta })],
      conclusion: makeVersion(1, '第二轮最终结论').conclusion,
      conclusionAt: 2000,
    }),
    t,
    selectedRoundNumber: null,
    onOpenFile: () => {},
    explainedCount: 1,
    totalFiles: 1,
    concludeBusy: false,
    reviewBusy: false,
    onConclude: () => {},
    concluding: null,
    cancelBusy: false,
    onCancelConclude: () => {},
    preview: null,
    onToggleInclude: () => {},
    publishBusy: false,
    previewBusy: false,
    previewRefreshBusy: false,
    feedbackBusy: false,
    onCheckFeedback: () => {},
  }));
  assert.ok(withDelta.textOnly.includes('第二轮最终结论'));
  assert.ok(!withDelta.textOnly.includes('复审对比'));
});

test('ConclusionPage mirrors the published comment structure', () => {
  const { parts, fake } = loadClient();
  const t = translator(parts);
  const version = makeVersion(1, '最终结论摘要', { verdict: 'block' });
  version.conclusion.blockers = [{ id: 'b1', file: 'src/a.js', line: 8, point: '阻塞问题' }];
  version.conclusion.suggestions = [{ id: 's1', file: '', line: 0, point: '建议问题' }];
  version.conclusion.nextSteps = ['补齐测试'];
  const round = makeRound(1, { conclusions: [version] });
  const review = makeReview({
    round: 1,
    roundHistory: [round],
    conclusion: version.conclusion,
    conclusionAt: 1000,
    coverage: { analyzed: 1, total: 2, unanalyzed: ['src/b.js'] },
    pull: { number: 7, title: 'PR 标题', url: 'https://example.test/pr/7' },
    feedback: { comments: [], notes: [], states: { b1: { status: 'accepted', reason: '已认可' } } },
  });
  const view = fake.render(fake.React.createElement(parts.ConclusionPage, {
    review,
    t,
    selectedRoundNumber: null,
    onOpenFile: () => {},
    explainedCount: 1,
    totalFiles: 2,
    concludeBusy: false,
    reviewBusy: false,
    onConclude: () => {},
    concluding: null,
    cancelBusy: false,
    onCancelConclude: () => {},
    preview: { markdown: 'preview', round: 1, version: 1, selectionSupported: true, selectedIds: ['b1'], items: [] },
    onToggleInclude: () => {},
    publishBusy: false,
    previewBusy: false,
    previewRefreshBusy: false,
    feedbackBusy: false,
    onCheckFeedback: () => {},
    appendixSources: {
      risks: [{ severity: 'block', file: 'src/a.js', point: '初筛风险' }],
      findings: [{ file: 'src/a.js', findings: [{ severity: 'block', point: '文件发现', suggestion: '', line: 8 }] }],
      order: [{ file: 'src/a.js', reason: '入口改动' }],
    },
  }));
  const text = view.textOnly;
  // The title carries the full verdict label; the card drops the pill row entirely.
  assert.ok(text.includes('PR 审查结论：阻塞（必须修复后才能合并）'));
  assert.equal(view.elements.some((element) => element.props?.className === 'prr-verdictline'), false);
  assert.equal(view.elements.filter((element) => element.props?.className === 'prr-pill').length, 0);
  // PR reference line under the title.
  assert.ok(text.includes('#7 PR 标题'));
  // Meta line leads with the reviewed commit and sits above the summary, like the comment.
  assert.ok(text.includes('commit sha-1-0 · 第 1 轮'));
  assert.ok(
    text.indexOf('commit sha-1-0') >= 0
    && text.indexOf('commit sha-1-0') < text.indexOf('最终结论摘要'),
    'meta line must precede the summary',
  );
  // Sections stay numbered like the comment and keep file tag, feedback pill and publish toggle.
  assert.ok(text.includes('src/a.js:8'));
  assert.ok(text.includes('1.'));
  assert.ok(text.includes('2.'));
  assert.equal(view.elements.filter((element) => element.type === 'input').length, 2);
  assert.ok(view.elements.some((element) => element.props?.['data-status'] === 'accepted'));
  // Next steps render as visual checkboxes only.
  assert.ok(view.elements.some((element) => element.props?.className === 'prr-nextbox'));
  // Appendix is collapsed by default: summary line only, no section content.
  assert.ok(text.includes('审查附录'));
  assert.ok(!text.includes('总体初筛风险'));
  assert.ok(!text.includes('复审对比'));
  assert.ok(!text.includes('未分析文件'));
});

test('ConclusionPage shows the mirrored empty sections and no appendix without data', () => {
  const { parts, fake } = loadClient();
  const t = translator(parts);
  const version = makeVersion(1, '干净结论');
  const review = makeReview({
    round: 1,
    roundHistory: [makeRound(1, { conclusions: [version] })],
    conclusion: version.conclusion,
    conclusionAt: 1000,
  });
  const view = fake.render(fake.React.createElement(parts.ConclusionPage, {
    review,
    t,
    selectedRoundNumber: null,
    onOpenFile: () => {},
    explainedCount: 0,
    totalFiles: 0,
    concludeBusy: false,
    reviewBusy: false,
    onConclude: () => {},
    concluding: null,
    cancelBusy: false,
    onCancelConclude: () => {},
    preview: null,
    onToggleInclude: () => {},
    publishBusy: false,
    previewBusy: false,
    previewRefreshBusy: false,
    feedbackBusy: false,
    onCheckFeedback: () => {},
  }));
  const text = view.textOnly;
  assert.ok(text.includes('PR 审查结论：建议（可不修，择机处理）'));
  assert.ok(text.includes('阻塞项'));
  assert.ok(text.includes('无阻塞项。'));
  assert.ok(text.includes('修改建议'));
  assert.ok(text.includes('暂无。'));
  assert.ok(text.includes('下一步'));
  // Every appendix source is empty: the whole collapsible block stays away.
  assert.ok(!text.includes('审查附录'));
});

test('ConclusionAppendix collapses by default, opens with defaultOpen and skips empty sources', () => {
  const { parts, fake } = loadClient();
  const t = translator(parts);
  const sources = {
    risks: [{ severity: 'block', file: 'src/a.js', point: '初筛风险' }],
    findings: [{
      file: 'src/a.js',
      // 合并行：每条意见四键自带 suggestion，没有 kind 字段。
      findings: [
        { severity: 'block', point: '文件发现', suggestion: '文件这样改', line: 8 },
        { severity: 'suggest', point: '提示发现', suggestion: '', line: 9 },
      ],
    }],
    order: [{ file: 'src/a.js', reason: '入口改动' }],
  };
  const coverage = { analyzed: 1, total: 2, unanalyzed: ['src/b.js'] };
  const collapsed = fake.render(fake.React.createElement(parts.ConclusionAppendix, { sources, coverage, t }));
  assert.ok(collapsed.textOnly.includes('审查附录'));
  assert.ok(!collapsed.textOnly.includes('总体初筛风险'));
  assert.ok(!collapsed.textOnly.includes('复审对比'));
  assert.ok(!collapsed.textOnly.includes('未分析文件'));
  // Closed state is a real closed details element, not just hidden content.
  assert.ok(!collapsed.html.includes(' open="true"'));
  assert.ok(collapsed.html.includes('prr-appendix'));
  // The summary's own native toggle stays preventDefault-ed: the state re-render is the
  // only thing allowed to apply the open attribute.
  const summary = collapsed.elements.find((element) => element.type === 'summary');
  assert.ok(summary, 'appendix must render a native summary element');
  let prevented = false;
  summary.props.onClick({ preventDefault: () => { prevented = true; } });
  assert.ok(prevented, 'summary click must preventDefault the native toggle');

  const open = fake.render(fake.React.createElement(parts.ConclusionAppendix, {
    sources, coverage, t, defaultOpen: true,
  }));
  const text = open.textOnly;
  // The forced-open state really opens the details element.
  assert.ok(open.html.includes(' open="true"'));
  // Severity markers mirror the comment's appendix bullets ([阻塞]/[提示] findings, [建议] lines).
  assert.ok(text.includes('[阻塞] src/a.js — 初筛风险'));
  assert.ok(text.includes('[阻塞] src/a.js:8 — 文件发现'));
  assert.ok(text.includes('[提示] src/a.js:9 — 提示发现'));
  // 建议渲染为意见下的独立行，只带 [建议] 标签，不再带文件前缀。
  assert.ok(text.includes('[建议] 文件这样改'));
  assert.ok(!text.includes('[建议] src/a.js'));
  assert.ok(text.includes('总体初筛风险'));
  assert.ok(text.includes('初筛风险'));
  assert.ok(text.includes('逐文件审查发现'));
  assert.ok(text.includes('src/a.js:8'));
  assert.ok(text.includes('审查顺序'));
  assert.ok(text.includes('src/a.js — 入口改动'));
  // H1：结论页附录不渲染复审对比。
  assert.ok(!text.includes('复审对比'));
  assert.ok(!text.includes('已修复：a.js'));
  assert.ok(text.includes('未分析文件'));
  assert.ok(text.includes('src/b.js'));

  const empty = fake.render(fake.React.createElement(parts.ConclusionAppendix, {
    sources: { risks: [], findings: [], order: [] }, coverage: null, t, defaultOpen: true,
  }));
  assert.equal(empty.textOnly, '');
});

test('ConclusionBlock carries the full verdict label for every verdict', () => {
  const { parts, fake } = loadClient();
  const t = translator(parts);
  const cases = [
    ['block', '阻塞（必须修复后才能合并）'],
    ['suggest', '建议（可不修，择机处理）'],
    ['pass', '通过（无阻塞项）'],
  ];
  for (const [verdict, label] of cases) {
    const view = fake.render(fake.React.createElement(parts.ConclusionBlock, {
      conclusion: { verdict, summary: 's', blockers: [], suggestions: [], nextSteps: [] },
      t,
      onOpenFile: () => {},
    }));
    assert.ok(view.textOnly.includes(`PR 审查结论：${label}`), `missing full label for ${verdict}`);
  }
});

test('ConclusionPage historical rounds keep only their own appendix sources', () => {
  const { parts, fake } = loadClient();
  const t = translator(parts);
  const version = makeVersion(1, '第二轮结论', { coverage: { analyzed: 1, total: 2, unanalyzed: ['src/b.js'] } });
  const review = makeReview({
    round: 3,
    roundHistory: [
      makeRound(1),
      makeRound(2, {
        conclusions: [version],
        delta: { previousRound: 1, round: 2, resolved: [], stillOpen: [{ file: 'a.js', point: '仍未解决点' }] },
      }),
      makeRound(3, { conclusions: [makeVersion(2, '第三轮结论')] }),
    ],
  });
  const props = (selectedRoundNumber) => ({
    review, t, selectedRoundNumber,
    onOpenFile: () => {}, explainedCount: 0, totalFiles: 0,
    concludeBusy: false, reviewBusy: false, onConclude: () => {},
    concluding: null, cancelBusy: false, onCancelConclude: () => {},
    preview: null, onToggleInclude: () => {},
    publishBusy: false, previewBusy: false, previewRefreshBusy: false,
    feedbackBusy: false, onCheckFeedback: () => {},
    appendixSources: { risks: [{ severity: 'block', file: '', point: '当前轮初筛风险' }], findings: [], order: [] },
  });
  // Historical: the appendix shows only the round's own delta/coverage, collapsed by default,
  // and the meta line names the commit that round reviewed.
  const historical = fake.render(fake.React.createElement(parts.ConclusionPage, props(2)));
  assert.ok(historical.textOnly.includes('审查附录'));
  assert.ok(historical.textOnly.includes('commit sha-2-0'));
  assert.ok(!historical.textOnly.includes('复审对比'));
  // Current round: the meta line carries the current head commit.
  const current = fake.render(fake.React.createElement(parts.ConclusionPage, props(null)));
  assert.ok(current.textOnly.includes('commit sha-3-0'));
  // A historical round with no delta and no coverage has no appendix at all.
  const bare = fake.render(fake.React.createElement(parts.ConclusionPage, {
    ...props(2),
    review: makeReview({
      round: 3,
      roundHistory: [
        makeRound(1),
        makeRound(2, { conclusions: [makeVersion(1, '无附录结论')] }),
        makeRound(3),
      ],
    }),
  }));
  assert.ok(!bare.textOnly.includes('审查附录'));
  // A pinned historical round must not inherit the CURRENT round's coverage: no version
  // coverage of its own means no unanalyzed section, even while review.coverage has one.
  const staleCoverage = fake.render(fake.React.createElement(parts.ConclusionPage, {
    ...props(2),
    review: makeReview({
      round: 3,
      coverage: { analyzed: 2, total: 2, unanalyzed: ['src/current.js'] },
      roundHistory: [
        makeRound(1),
        makeRound(2, { conclusions: [makeVersion(1, '无覆盖历史结论')] }),
        makeRound(3, { conclusions: [makeVersion(2, '第三轮结论')] }),
      ],
    }),
  }));
  assert.ok(!staleCoverage.textOnly.includes('审查附录'));
});

test('ConclusionBlock renders publish checkboxes when includeControl is set', () => {
  const { parts, fake } = loadClient();
  const t = translator(parts);
  const conclusion = {
    verdict: 'block',
    summary: 's',
    blockers: [{ id: 'b1', file: 'a.js', line: 3, point: '阻塞点' }],
    suggestions: [{ id: 's1', file: '', line: 0, point: '建议点' }],
    nextSteps: ['补测试'],
  };
  const withControl = fake.render(fake.React.createElement(parts.ConclusionBlock, {
    conclusion, t, onOpenFile: () => {},
    includeControl: { isSelected: () => true, onToggle: () => {} },
  }));
  assert.equal(withControl.elements.filter((element) => element.type === 'input').length, 2);
  const without = fake.render(fake.React.createElement(parts.ConclusionBlock, {
    conclusion, t, onOpenFile: () => {},
  }));
  assert.equal(without.elements.filter((element) => element.type === 'input').length, 0);
});

test('FilesPane pins a conclusion entry with live badges', () => {
  const { parts, fake } = loadClient();
  const t = translator(parts);
  const base = {
    t,
    overviewMode: true,
    conclusionMode: false,
    onSelectOverview: () => {},
    onSelectConclusion: () => {},
    files: [{ path: 'src/a.js', status: 'modified', additions: 1, deletions: 0, order: 1, reason: '', severity: '' }],
    filePath: '',
    review: makeReview({ round: 1 }),
    onOpenFile: () => {},
    analyzing: null,
    manual: false,
    analyzeAllBusy: false,
    onAnalyzeAll: () => {},
    phase: { phase: 'ready', progress: null, nextAction: 'conclude', version: 0 },
  };
  const view = fake.render(fake.React.createElement(parts.FilesPane, base));
  assert.ok(view.textOnly.includes('结论'));
  assert.ok(view.textOnly.includes('未生成'));
  assert.ok(view.elements.some((element) => element.props?.className === 'prr-files-tail'));
  const tones = view.elements.filter((element) => element.props?.className === 'prr-navrow-badge');
  assert.equal(tones.some((element) => element.props?.['data-tone'] === 'none'), true);
  // Both rail entries carry a tone: overview is ok while the phase is ready, conclusion none.
  const navrows = view.elements.filter((element) => element.props?.className === 'prr-navrow');
  assert.equal(navrows.length, 2);
  assert.deepEqual(
    navrows.map((element) => element.props?.['data-tone']).sort(),
    ['none', 'ok'],
  );
  assert.equal(tones.some((element) => element.props?.['data-tone'] === 'ok'), true);
  // Every leading mark is toned: overview ok, conclusion none, files header none (nothing run).
  const marks = view.elements.filter((element) => element.props?.className === 'prr-navrow-mark');
  assert.equal(marks.length, 3);
  assert.deepEqual(
    marks.map((element) => element.props?.['data-tone']).sort(),
    ['none', 'none', 'ok'],
  );
  // A running batch turns the files-header dot info.
  const batching = fake.render(fake.React.createElement(parts.FilesPane, {
    ...base,
    phase: { phase: 'analyzing', progress: { done: 3, total: 14, failed: 0 }, nextAction: null, version: 0 },
    analyzing: { done: 3, total: 14, failed: 0, current: 'src/a.js' },
  }));
  const batchingMarks = batching.elements.filter((element) => element.props?.className === 'prr-navrow-mark');
  assert.equal(batchingMarks.some((element) => element.props?.['data-tone'] === 'info'), true);
  // In-progress states spin: analyzing spins the overview badge and the files head only.
  const spinners = (rendered) => rendered.elements.filter((element) => element.props?.className === 'prr-spinner-sm');
  assert.equal(spinners(view).length, 0);
  assert.equal(spinners(batching).length, 2);
  // The files-head spinner sits in the right-aligned count, after the label — like the
  // rail entries' spinners — and stays absent while idle.
  const countSpan = batching.elements.find((element) => element.props?.className === 'prr-count');
  assert.equal(countSpan.children[0]?.props?.className, 'prr-spinner-sm');
  const idleCount = view.elements.find((element) => element.props?.className === 'prr-count');
  assert.ok(!idleCount.children.some((child) => child?.props?.className === 'prr-spinner-sm'));
  const concluding = fake.render(fake.React.createElement(parts.FilesPane, {
    ...base,
    phase: { phase: 'concluding', progress: null, nextAction: null, version: 0 },
  }));
  // The conclude job belongs to the conclusion entry alone: the overview badge settles
  // to review-done with no spinner while the conclusion entry keeps 汇总中 and spins.
  assert.ok(concluding.textOnly.includes(t('badgeDone')));
  assert.ok(concluding.textOnly.includes(t('badgeConcluding')));
  assert.equal(spinners(concluding).length, 1);

  const active = fake.render(fake.React.createElement(parts.FilesPane, {
    ...base,
    conclusionMode: true,
    phase: { phase: 'published', progress: null, nextAction: 'append', version: 3 },
  }));
  assert.ok(active.textOnly.includes('已发布'));
  const activeTones = active.elements.filter((element) => element.props?.className === 'prr-navrow-badge');
  assert.equal(activeTones.some((element) => element.props?.['data-tone'] === 'ok'), true);
});

test('ConclusionPage renders no version selector, even with several versions', () => {
  const { parts, fake } = loadClient();
  const t = translator(parts);
  const review = makeReview({
    round: 1,
    conclusion: makeVersion(2, '最新结论').conclusion,
    conclusionAt: 2000,
    roundHistory: [makeRound(1, {
      conclusions: [makeVersion(1, '旧结论'), makeVersion(2, '最新结论')],
    })],
  });
  const view = fake.render(fake.React.createElement(parts.ConclusionPage, {
    review,
    t,
    selectedRoundNumber: null,
    onOpenFile: () => {},
    explainedCount: 1,
    totalFiles: 1,
    concludeBusy: false,
    reviewBusy: false,
    onConclude: () => {},
    concluding: null,
    cancelBusy: false,
    onCancelConclude: () => {},
    preview: null,
    onToggleInclude: () => {},
    publishBusy: false,
    previewBusy: false,
    previewRefreshBusy: false,
    feedbackBusy: false,
    onCheckFeedback: () => {},
  }));
  // The panel always reads the newest version: the title row carries no <select> anywhere.
  assert.equal(view.elements.some((node) => node.type === 'select'), false, 'version selector must be gone');
  assert.ok(view.textOnly.includes('最新结论'));
});

test('ConclusionPage keeps its hook order across pending/historical/current transitions', () => {
  const { parts, fake } = loadClient();
  const t = translator(parts);
  const older = makeVersion(1, '第一轮结论');
  const current = makeVersion(2, '第二轮结论');
  const props = (review, selectedRoundNumber) => ({
    review, t, selectedRoundNumber,
    onOpenFile: () => {}, explainedCount: 0, totalFiles: 2,
    concludeBusy: false, reviewBusy: false, onConclude: () => {},
    concluding: null, cancelBusy: false, onCancelConclude: () => {},
    preview: null, onToggleInclude: () => {},
    publishBusy: false, previewBusy: false, previewRefreshBusy: false,
    feedbackBusy: false, onCheckFeedback: () => {},
  });
  const concluded = makeReview({
    round: 2,
    conclusion: current.conclusion,
    conclusionAt: current.createdAt,
    roundHistory: [
      makeRound(1, { conclusions: [older] }),
      // The delta is the overview's cross-round record: the conclusion page renders none of it.
      makeRound(2, { conclusions: [current], delta: { previousRound: 1, round: 2, resolved: [], stillOpen: [{ file: 'a.js', point: '仍未解决点' }] } }),
    ],
  });
  const result = fake.rerender(parts.ConclusionPage, [
    // Pending: the current round has no conclusion yet.
    props(makeReview({ round: 2, conclusion: null, conclusionAt: 0, roundHistory: [makeRound(1), makeRound(2)] }), null),
    // Historical: an older round is pinned and shows its own conclusion versions.
    props(concluded, 1),
    // Current: the newest round with its conclusion.
    props(concluded, null),
  ]);
  assert.equal(new Set(result.counts).size, 1, 'every transition consumes the same hook count');
  // The kind sequence must match across the three transitions too.
  assert.deepEqual(result.kinds[0], result.kinds[1]);
  assert.deepEqual(result.kinds[1], result.kinds[2]);
  // The three props really did exercise the three render branches.
  const [pendingText, historicalText, currentText] = result.trees.map((tree) => fake.textOf(tree));
  assert.ok(pendingText.includes('结论待生成'));
  assert.ok(historicalText.includes('第一轮结论'));
  assert.ok(currentText.includes('第二轮结论'));
  // A round with delta data must not leak the cross-round record onto the conclusion page.
  assert.ok(!historicalText.includes('复审对比'));
  assert.ok(!currentText.includes('复审对比'));
});

test('rerender catches a hook-kind drift that keeps the hook count stable', () => {
  const { fake } = loadClient();
  const { React } = fake;
  // Both orders consume exactly two hooks, so `counts` alone sees no drift; the kind
  // sequence is what exposes the conditional hook order change between renders.
  function Drifter(props) {
    if (props.memoFirst) React.useMemo(() => props.label, []);
    else React.useState(props.label);
    React.useState(0);
    return React.createElement('div', null, props.label);
  }
  const result = fake.rerender(Drifter, [
    { memoFirst: true, label: 'a' },
    { memoFirst: false, label: 'b' },
  ]);
  assert.deepEqual(result.counts, [2, 2]);
  assert.deepEqual(result.kinds[0], ['memo', 'state']);
  assert.deepEqual(result.kinds[1], ['state', 'state']);
  assert.notDeepEqual(result.kinds[0], result.kinds[1]);
});

test('the publish modal opens only when the preview flag is set alongside a preview', () => {
  const client = loadClient();
  const { parts, fake } = client;
  const t = translator(parts);
  const review = makeReview({ round: 1 });
  // The model the container builds (overview page on the embedded layer).
  const model = {
    t,
    onClose: null,
    inputActions: null,
    embedded: false,
    sidebar: false,
    rootRef: { current: null },
    list: { prs: [{ number: 7, title: 'Fix', headSha: review.headSha }], reviews: {}, lastPollAt: 0, autoAnalyze: true },
    listError: '',
    listBusy: false,
    prNumber: 7,
    setPrNumber: () => {},
    review,
    reviewError: '',
    filePath: '',
    contextBusy: false,
    contextError: '',
    contextBlocked: false,
    setContextAttempt: () => {},
    currentExplanation: null,
    suggestionNotice: '',
    reviewRounds: [],
    latestRoundNumber: 1,
    selectedRoundNumber: 1,
    selectRound: () => {},
    mode: 'overview',
    setMode: () => {},
    phase: { phase: 'concluded', progress: null, nextAction: 'publish', version: 1 },
    staleInfo: null,
    sidebarPane: 'diff',
    setSidebarPane: () => {},
    sidebarWidth: 0,
    filesWidth: 0,
    setFilesWidth: () => {},
    detailWidth: 0,
    setDetailWidth: () => {},
    startReview: () => {},
    refreshPulls: () => {},
    openFile: () => {},
    requestAnalyzeAll: () => {},
    analyzeAllBusy: false,
    orderedFiles: review.files,
    historicalView: false,
    publishError: '',
    feedbackError: '',
    fileDiffError: '',
    fileContentError: '',
    overlayDraft: '',
    overlayBusy: false,
    setOverlayDraft: () => {},
    sendOverlayMessage: () => {},
    preview: null,
    previewModalOpen: false,
    previewBusy: false,
    previewError: '',
    previewRefreshBusy: false,
    publishBusy: false,
    closePreview: () => {},
    submitPublish: () => {},
    walkFloat: null,
    activeHunk: 0,
    closeWalkFloat: () => {},
    expandHunkContext: () => {},
    askInChat: () => {},
    currentLogic: '',
    currentWalkthrough: [],
    openWalkFloat: () => {},
    showFullFile: false,
    fileContentBusy: false,
    fileContent: null,
    toggleFullFile: () => {},
    wrap: false,
    setWrap: () => {},
    fileDiff: null,
    diffScrollRef: { current: null },
    expandedHunks: new Set(),
    collapseHunkContext: () => {},
    setActiveHunk: () => {},
  };
  const preview = { markdown: 'preview body', round: 1, version: 1, conflict: '', items: [], selectionSupported: false, selectedIds: [] };

  // The conclusion page prefetches quietly: `preview` exists while the flag stays down.
  const hidden = fake.render(fake.React.createElement(parts.WorkspaceView, {
    model: { ...model, preview, previewModalOpen: false },
  }));
  assert.equal(
    hidden.elements.some((element) => element.props?.className === 'prr-modal-backdrop'),
    false,
    'a quiet prefetch keeps the preview without opening the modal',
  );

  const open = fake.render(fake.React.createElement(parts.WorkspaceView, {
    model: { ...model, preview, previewModalOpen: true },
  }));
  assert.ok(
    open.elements.some((element) => element.props?.className === 'prr-modal-backdrop'),
    'the confirmation dialog opens when the flag is set with a preview',
  );
  assert.ok(open.textOnly.includes('preview body'));
});

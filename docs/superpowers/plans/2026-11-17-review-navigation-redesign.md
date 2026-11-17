# 总览导航重构（总览 / 明细 / 结论 三页模式）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 `docs/superpowers/specs/2026-11-17-review-navigation-redesign-design.md` 把审查面板重组为「总览 / 明细 / 结论」三页：derivePhase 状态归一、左栏 sticky 结论入口、处置记录归总览页、总览只呈现已核实事实与完备性、发布装配进入结论页。宿主 `index.js` / `llm.js` 与 prompt 零改动。

**Architecture:** 全部改动在浏览器侧 chunk（`client.core.js` / `client.views.js` / `client.conclusion.js` / `client.preview.js` / `client.workspace.js` / `client.hooks.js` / `client.i18n.js`）。新增纯函数 `derivePhase`（状态归一）与展示组件 `PhaseBar` / `FindingList` / `ConclusionPage` / `OverviewPage`；`OverviewPanel` 拆为两页；发布勾选从弹窗迁移到结论条目。测试在 `tests/client.test.js` 的 vm 沙箱 + 假 React 内完成（SSR 式单次渲染，effect 不执行——涉及 `actionsBridge` effect 的行为直接测 `overviewFooter` 纯函数）。

**Tech Stack:** 无新依赖。React（宿主注入）、`node --test` + vm 沙箱假 React。每次改动 chunk 后先 `pnpm stamp`（刷新 client.js 内的 chunk 清单），再跑测试。

**执行纪律：** 每个任务一个 commit；任务内严格 TDD（先写失败测试）。测试命令统一用：

```bash
pnpm stamp && node --test tests/client.test.js
```

**EXPOSED 机制：** `tests/client.test.js` 顶部有 `EXPOSED` 数组（约 25-80 行），每个新导出的内部名必须加入，否则加载时断言失败。本计划每任务注明要追加的名字。

---

### Task 1: `derivePhase` + 徽标文案纯函数（client.core.js）

**Files:**
- Modify: `client.core.js`（`staleInfoOf` 之后、`isRoundVersionPublished` 附近新增；文件底部 return 导出表追加）
- Test: `tests/client.test.js`

- [ ] **Step 1: 把新内部名加入 EXPOSED**

在 `tests/client.test.js` 的 `EXPOSED` 数组里追加（保持字母序就近放置即可）：

```js
  'derivePhase',
  'phaseStateText',
  'conclusionBadgeText',
```

- [ ] **Step 2: 写失败测试**

在 `tests/client.test.js` 末尾追加（fixture `makeReview` / `plain` 已存在）：

```js
test('derivePhase folds host state into one phase', () => {
  const { parts } = loadClient();
  const base = makeReview({ round: 2 });
  assert.equal(parts.derivePhase({ ...base, status: 'error' }, null).phase, 'error');
  assert.equal(parts.derivePhase({ ...base, status: 'reviewing' }, null).phase, 'reviewing');
  assert.equal(
    parts.derivePhase({ ...base, concluding: { stage: 'model', startedAt: 1 } }, null).phase,
    'concluding',
  );

  const analyzing = { ...base, status: 'done', analyzing: { done: 12, total: 30, failed: 1, current: 'src/a.js' } };
  const phase = parts.derivePhase(analyzing, null);
  assert.equal(phase.phase, 'analyzing');
  assert.deepEqual(plain(phase.progress), { done: 12, total: 30, failed: 1 });
  assert.equal(phase.nextAction, null);
  assert.equal(parts.derivePhase(analyzing, null, { manual: true }).nextAction, 'analyzeAll');

  assert.equal(parts.derivePhase({ ...base, conclusion: null, conclusionAt: 0 }, null).phase, 'ready');
  assert.equal(parts.derivePhase({ ...base, conclusion: null, conclusionAt: 0 }, null).nextAction, 'conclude');
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

test('phase and conclusion badge text follow the phase', () => {
  const { parts } = loadClient();
  const t = (key) => key;
  const analyzing = { phase: 'analyzing', progress: { done: 12, total: 30, failed: 2 }, nextAction: null, version: 0 };
  assert.equal(
    parts.phaseStateText(analyzing, t),
    'badgeAnalyzing-fallback badgeAnalyzingFailed-fallback',
  );
});
```

> 注意：最后这条断言依赖 `fill()` 对缺失 key 的行为。若 `fill` 对未知 key 原样返回模板（含 `{done}`），就按实际输出改断言——先跑一次看输出再定字符串，断言改为精确等于实际拼接结果。

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm stamp && node --test tests/client.test.js 2>&1 | tail -20`
Expected: FAIL，`client internals changed: derivePhase is exported by no chunk`。

- [ ] **Step 4: 实现（client.core.js）**

在 `staleInfoOf` 函数之后插入：

```js
    /**
     * The single phase the whole panel shows. Everything the host already reports — review
     * status, batch progress, the conclude job, conclusion versions, published entries and
     * staleness — folds into one enum so the status bar, the rail badges and the footer
     * cannot disagree. `staleInfo` is staleInfoOf()'s result (null = not stale); options
     * carry per-workspace flags ({ manual: true } = autoAnalyze off).
     */
    function derivePhase(review, staleInfo, options = {}) {
      const data = review ?? {};
      if (data.status === 'error') return { phase: 'error', progress: null, nextAction: null, version: 0 };
      const analyzing = isAnalyzing(data.analyzing) ? data.analyzing : null;
      const progress = analyzing === null
        ? null
        : {
            done: Math.min(Math.max(analyzing.done ?? 0, 0), analyzing.total),
            total: analyzing.total,
            failed: Math.min(Math.max(analyzing.failed ?? 0, 0), analyzing.total),
          };
      const rounds = roundsOf(data);
      const current = rounds.length > 0 ? rounds[rounds.length - 1] : null;
      const versions = versionsOf(data, current, true);
      const version = versions.length > 0 ? versions[versions.length - 1].version : 0;
      const hasConclusion = versions.length > 0;
      const stale = staleInfo !== null && staleInfo !== undefined;
      if (data.status === 'reviewing') return { phase: 'reviewing', progress: null, nextAction: null, version };
      if (data.concluding !== null && data.concluding !== undefined) {
        return { phase: 'concluding', progress: null, nextAction: null, version };
      }
      if (analyzing !== null) {
        return {
          phase: 'analyzing',
          progress,
          nextAction: options.manual === true ? 'analyzeAll' : null,
          version,
        };
      }
      if (!hasConclusion) return { phase: 'ready', progress: null, nextAction: 'conclude', version };
      const published = hasConclusion === true
        && isRoundVersionPublished(data.published, current === null ? 1 : current.round, version);
      if (published && stale) return { phase: 'published-stale', progress: null, nextAction: 'regenerate', version };
      if (published) return { phase: 'published', progress: null, nextAction: 'append', version };
      if (stale) return { phase: 'concluded-stale', progress: null, nextAction: 'regenerate', version };
      return { phase: 'concluded', progress: null, nextAction: 'publish', version };
    }

    /** The process-side state line: one text for the status bar and the overview badge. */
    function phaseStateText(phase, t) {
      if (phase === null || phase === undefined) return '';
      if (phase.phase === 'reviewing') return t('badgeReviewing');
      if (phase.phase === 'concluding') return t('badgeConcluding');
      if (phase.phase === 'error') return t('badgeError');
      if (phase.phase === 'analyzing') {
        const base = fill(t('badgeAnalyzing'), {
          done: phase.progress?.done ?? 0,
          total: phase.progress?.total ?? 0,
        });
        const failed = (phase.progress?.failed ?? 0) > 0
          ? fill(t('badgeAnalyzingFailed'), { failed: phase.progress.failed })
          : '';
        return failed === '' ? base : `${base} ${failed}`;
      }
      return t('badgeDone');
    }

    /** The conclusion-side badge: version-aware, none while no conclusion exists. */
    function conclusionBadgeText(phase, t) {
      if (phase === null || phase === undefined) return t('badgeConclusionNone');
      const version = phase.version ?? 0;
      if (phase.phase === 'concluding') return t('badgeConcluding');
      if (phase.phase === 'concluded') return fill(t('badgeConclusionDraft'), { version });
      if (phase.phase === 'concluded-stale') return fill(t('badgeConclusionStale'), { version });
      if (phase.phase === 'published') return fill(t('badgePublished'), { version });
      if (phase.phase === 'published-stale') return fill(t('badgePublishedStale'), { version });
      return t('badgeConclusionNone');
    }
```

在文件底部导出表（`findingKey, FEEDBACK_LABEL_KEYS, ...` 那一段）追加三个名字：

```js
        derivePhase, phaseStateText, conclusionBadgeText,
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm stamp && node --test tests/client.test.js 2>&1 | tail -5`
Expected: PASS（含新增三条测试）。

- [ ] **Step 6: Commit**

```bash
git add client.core.js tests/client.test.js
git commit -m "feat(review): derive one review phase from host state"
```

---

### Task 2: 历史轮次落到结论页（applyRoundSelection + hooks historicalView）

**Files:**
- Modify: `client.core.js:128-133`（`applyRoundSelection`）
- Modify: `client.hooks.js`（`useRoundSelection` 内 `historicalView`）
- Test: `tests/client.test.js`

- [ ] **Step 1: 更新失败测试**

`tests/client.test.js:1379-1385` 现有断言（形如）：

```js
  assert.deepEqual(plain(parts.applyRoundSelection(3, 3)), {
    roundPick: null,
    mode: 'overview',
  });
  assert.deepEqual(plain(parts.applyRoundSelection(1, 3)), {
    roundPick: 1,
    mode: 'overview',
  });
```

把第二条的历史轮期望改为 `'conclusion'`（第一条「选最新轮」保持 `'overview'`）：

```js
  assert.deepEqual(plain(parts.applyRoundSelection(3, 3)), {
    roundPick: null,
    mode: 'overview',
  });
  assert.deepEqual(plain(parts.applyRoundSelection(1, 3)), {
    roundPick: 1,
    mode: 'conclusion',
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm stamp && node --test tests/client.test.js 2>&1 | grep -A 3 applyRoundSelection | head -8`
Expected: 深比较 FAIL（`mode: 'overview'` vs `'conclusion'`）。

- [ ] **Step 3: 实现**

`client.core.js` 的 `applyRoundSelection` 改为：

```js
    /**
     * State transition for picking a round: the latest one keeps following (null) and lands on
     * the overview; a pinned historical round lands on the conclusion page — history persists
     * conclusions/delta/feedback/published, so the conclusion is its main artifact.
     */
    function applyRoundSelection(round, latestRoundNumber) {
      const historical = round !== latestRoundNumber;
      return {
        roundPick: historical ? round : null,
        mode: historical ? 'conclusion' : 'overview',
      };
    }
```

`client.hooks.js` 的 `useRoundSelection` 内，`historicalView` 一行改为：

```js
      const historicalView = (mode === 'overview' || mode === 'conclusion') && review !== null && selectedIsCurrent === false;
```

- [ ] **Step 4: 运行确认通过**

Run: `pnpm stamp && node --test tests/client.test.js 2>&1 | tail -3`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add client.core.js client.hooks.js tests/client.test.js
git commit -m "feat(review): land historical rounds on the conclusion page"
```

---

### Task 3: i18n 新增 key（zh + en）

**Files:**
- Modify: `client.i18n.js`（zh 表约 42-190 行区域、en 表对应区域）

- [ ] **Step 1: zh 表新增**

在 zh 表 `overview: '总览',` 之后插入：

```js
        conclusionNav: '结论',
        digestTitle: '改动概述',
        findingList: '审查发现',
        findingListEmpty: '未发现问题',
        findingOpenContext: '在明细页查看上下文',
        completenessTitle: '审查完备性',
        completenessClean: '其中 {clean} 个文件核查后未发现问题',
        conclusionPendingCard: '结论待生成',
        publishInclude: '纳入发布',
        publishPreviewSection: '评论预览',
        historyNoReport: '历史轮次不含改动概述',
        phaseRound: '第 {round} 轮',
        badgeReviewing: '审查中…',
        badgeAnalyzing: '分析 {done}/{total}',
        badgeAnalyzingFailed: '+{failed} 失败',
        badgeConcluding: '汇总中…',
        badgeDone: '审查完成',
        badgeConclusionNone: '未生成',
        badgeConclusionDraft: 'v{version} 草稿',
        badgeConclusionStale: 'v{version} 已过期',
        badgePublished: 'v{version} 已发布',
        badgePublishedStale: 'v{version} 已发布 · 有更新',
        badgeError: '审查失败',
```

- [ ] **Step 2: en 表新增**

在 en 表 `overview: 'Overview',` 之后插入：

```js
        conclusionNav: 'Conclusion',
        digestTitle: 'Change digest',
        findingList: 'Findings',
        findingListEmpty: 'No findings',
        findingOpenContext: 'Open in file detail',
        completenessTitle: 'Review completeness',
        completenessClean: '{clean} files checked with no findings',
        conclusionPendingCard: 'Conclusion pending',
        publishInclude: 'Include in publish',
        publishPreviewSection: 'Comment preview',
        historyNoReport: 'This round has no change digest',
        phaseRound: 'Round {round}',
        badgeReviewing: 'Reviewing…',
        badgeAnalyzing: 'Analyzing {done}/{total}',
        badgeAnalyzingFailed: '+{failed} failed',
        badgeConcluding: 'Concluding…',
        badgeDone: 'Review done',
        badgeConclusionNone: 'None',
        badgeConclusionDraft: 'v{version} draft',
        badgeConclusionStale: 'v{version} stale',
        badgePublished: 'v{version} published',
        badgePublishedStale: 'v{version} published · has updates',
        badgeError: 'Review failed',
```

- [ ] **Step 3: 运行确认无回归**

Run: `pnpm stamp && node --test tests/client.test.js 2>&1 | tail -3`
Expected: PASS（i18n 无独立测试，靠现有套件兜底）。

- [ ] **Step 4: Commit**

```bash
git add client.i18n.js
git commit -m "feat(review): strings for the three-page navigation"
```

---

### Task 4: CSS 增补（client.core.js 的 CSS 模板）

**Files:**
- Modify: `client.core.js`（CSS 模板字符串，`.prr-sidebar .prr-files{...}`（约 959 行）之后）

- [ ] **Step 1: 追加样式**

在 CSS 模板里 `.prr-sidebar .prr-files{flex:0 0 146px;min-width:104px}` 之后追加：

```css
.prr-files-tail{margin-top:auto;flex:0 0 auto;border-top:1px solid var(--dsw-alias-border-l1)}
.prr-navrow-badge{margin-left:auto;flex:0 0 auto;font:11px/1.3 inherit;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.prr-phasebar{display:flex;gap:10px;align-items:center;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);font:12px/1.4 inherit;color:var(--dsw-alias-label-secondary)}
.prr-finding{border-bottom:1px dashed var(--dsw-alias-border-l1)}
.prr-finding:last-child{border-bottom:0}
.prr-finding-head{display:flex;align-items:flex-start;gap:6px;width:100%;padding:6px 10px;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer}
.prr-finding-point{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.prr-finding-caret{flex:0 0 auto;color:var(--dsw-alias-label-secondary)}
.prr-finding-detail{padding:2px 10px 8px 10px}
.prr-completeness{padding:6px 10px;font:12px/1.5 inherit;color:var(--dsw-alias-label-secondary)}
.prr-include{display:inline-flex;align-items:center;flex:0 0 auto;cursor:pointer}
.prr-preview-section{margin-top:8px}
.prr-preview-section .prr-dock-toggle{width:100%;border:0;background:transparent;color:var(--dsw-alias-label-primary);padding:4px 0;text-align:left;cursor:pointer}
```

- [ ] **Step 2: 用 cssRule 断言锁定（tests/client.test.js 追加）**

```js
test('navigation redesign css ships the new selectors', () => {
  const { parts } = loadClient();
  assert.ok(parts.CSS.includes('.prr-files-tail'));
  assert.ok(parts.CSS.includes('.prr-phasebar'));
  assert.ok(parts.CSS.includes('.prr-finding-head'));
  assert.ok(cssRule(parts.CSS, '.prr-completeness').includes('padding'));
});
```

- [ ] **Step 3: 运行 + Commit**

```bash
pnpm stamp && node --test tests/client.test.js 2>&1 | tail -3
git add client.core.js tests/client.test.js
git commit -m "feat(review): css for phase bar, sticky tail and finding rows"
```

---

### Task 5: PhaseBar 组件（client.views.js）

**Files:**
- Modify: `client.views.js`（新增组件；views 的 core 解构追加 `phaseStateText`；底部 return 导出表追加）
- Test: `tests/client.test.js`

- [ ] **Step 1: EXPOSED 追加 `'PhaseBar'`；写失败测试**

```js
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
  const empty = fake.render(fake.React.createElement(parts.PhaseBar, { phase: null, round: 1, t }));
  assert.equal(empty.textOnly, '');
});
```

- [ ] **Step 2: 运行确认失败**（`PhaseBar is exported by no chunk`）

- [ ] **Step 3: 实现（client.views.js）**

views 的 core 解构行追加 `phaseStateText`：

```js
        staleInfoOf, versionsOf, isRoundVersionPublished, STATUS_KEY, actionsBridge, shortSha,
        phaseStateText,
```

在 `FilesPane` 之后新增：

```js
      /** One shared status line: the round plus the single derived phase. */
      function PhaseBar(props) {
        const { phase, round, t } = props;
        if (phase === null || phase === undefined) return null;
        return h(
          'div',
          { className: 'prr-phasebar' },
          h('span', null, fill(t('phaseRound'), { round: round ?? 1 })),
          h('span', null, phaseStateText(phase, t)),
        );
      }
```

底部导出表改为：

```js
      return {
        FilesPane, PhaseBar, DiffView, FullFileView, FileDetailPanel, ChatBox, OverviewPanel, WorkspaceCenter,
      };
```

（`OverviewPanel` 在 Task 8 拆分后由 `OverviewPage`/`ConclusionPage` 取代导出。）

- [ ] **Step 4: 运行确认通过 + Commit**

```bash
pnpm stamp && node --test tests/client.test.js 2>&1 | tail -3
git add client.views.js tests/client.test.js
git commit -m "feat(review): shared PhaseBar status line"
```

---

### Task 6: FindingList + findingsOf + cleanCountOf（client.views.js）

**Files:**
- Modify: `client.views.js`（core 解构追加 `fileLineLabel`；新增三个导出）
- Test: `tests/client.test.js`

- [ ] **Step 1: EXPOSED 追加 `'FindingList'`、`'findingsOf'`、`'cleanCountOf'`；写失败测试**

```js
test('findingsOf flattens and orders file findings', () => {
  const { parts } = loadClient();
  const groups = [
    { file: 'src/b.js', issues: [{ severity: 'suggest', point: 'b 问题', line: 3 }], suggestions: ['b 建议'] },
    { file: 'src/a.js', issues: [{ severity: 'block', point: 'a 阻塞', line: 8 }, { severity: 'suggest', point: 'a 问题', line: 2 }], suggestions: [] },
  ];
  const rows = parts.findingsOf(groups);
  assert.deepEqual(rows.map((row) => [row.severity, row.file]), [
    ['block', 'src/a.js'],
    ['suggest', 'src/a.js'],
    ['suggest', 'src/b.js'],
    ['suggestion', 'src/b.js'],
  ]);
  assert.equal(rows[0].line, 8);
  assert.equal(parts.findingsOf([]).length, 0);
});

test('FindingList renders rows and the empty state', () => {
  const { parts, fake } = loadClient();
  const t = translator(parts);
  const empty = fake.render(fake.React.createElement(parts.FindingList, { groups: [], t, onOpenFile: () => {} }));
  assert.ok(empty.textOnly.includes('未发现问题'));

  const view = fake.render(fake.React.createElement(parts.FindingList, {
    groups: [{ file: 'src/a.js', issues: [{ severity: 'block', point: 'a 阻塞', line: 8 }], suggestions: [] }],
    t,
    onOpenFile: () => {},
  }));
  assert.ok(view.textOnly.includes('src/a.js:8'));
  assert.ok(view.textOnly.includes('a 阻塞'));
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
  assert.deepEqual(plain(parts.cleanCountOf(review)), { done: 2, clean: 1 });
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现（client.views.js，`PhaseBar` 之后）**

core 解构追加 `fileLineLabel`：

```js
        staleInfoOf, versionsOf, isRoundVersionPublished, STATUS_KEY, actionsBridge, shortSha,
        phaseStateText, fileLineLabel,
```

组件代码：

```js
      /**
       * Flatten the per-file findings into the page's single ordered list: block first, then
       * suggest, then suggestions; ties break by path and line. This is the one place the
       * overview speaks about findings — detail pages and the conclusion reference, not repeat.
       */
      function findingsOf(groups) {
        const rows = [];
        for (const group of Array.isArray(groups) ? groups : []) {
          if (group === null || typeof group !== 'object') continue;
          const file = typeof group.file === 'string' ? group.file : '';
          for (const issue of Array.isArray(group.issues) ? group.issues : []) {
            if (issue === null || typeof issue !== 'object') continue;
            const point = typeof issue.point === 'string' ? issue.point.trim() : '';
            if (point === '') continue;
            rows.push({
              kind: 'issue',
              severity: issue.severity === 'block' ? 'block' : 'suggest',
              file,
              line: Number.isFinite(issue.line) && issue.line > 0 ? Math.floor(issue.line) : 0,
              point,
            });
          }
          for (const suggestion of Array.isArray(group.suggestions) ? group.suggestions : []) {
            const point = suggestionText(suggestion).trim();
            if (point === '') continue;
            rows.push({ kind: 'suggestion', severity: 'suggestion', file, line: 0, point });
          }
        }
        const rank = { block: 0, suggest: 1, suggestion: 2 };
        rows.sort((a, b) => rank[a.severity] - rank[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
        return rows;
      }

      /** The expandable findings list: one row per finding, detail unfolds in place. */
      function FindingList(props) {
        const { groups, t, onOpenFile } = props;
        const rows = findingsOf(groups);
        const [openKey, setOpenKey] = React.useState(null);
        if (rows.length === 0) return h('div', { className: 'prr-subtle' }, t('findingListEmpty'));
        return h(
          'div',
          { className: 'prr-card' },
          rows.map((row, index) => {
            const key = `${row.kind}-${row.file}-${row.line}-${index}`;
            const open = openKey === key;
            const label = row.file === '' ? row.point : `${fileLineLabel(row.file, row.line)} — ${row.point}`;
            return h(
              'div',
              { className: 'prr-finding', key },
              h(
                'button',
                {
                  type: 'button',
                  className: 'prr-finding-head',
                  'data-open': open ? 'true' : 'false',
                  title: row.point,
                  onClick: () => setOpenKey(open ? null : key),
                },
                row.kind === 'suggestion'
                  ? h('span', { className: 'prr-tag' }, t('suggestionTag'))
                  : h(VerdictPill, { verdict: row.severity, t }),
                h('span', { className: 'prr-finding-point' }, label),
                h('span', { className: 'prr-finding-caret', 'aria-hidden': 'true' }, open ? '▾' : '▸'),
              ),
              open
                ? h(
                    'div',
                    { className: 'prr-finding-detail' },
                    h('div', { className: 'prr-text' }, row.point),
                    row.file === ''
                      ? null
                      : h(
                          'button',
                          {
                            type: 'button',
                            className: 'prr-linklike',
                            onClick: () => onOpenFile(row.file, row.line),
                          },
                          t('findingOpenContext'),
                        ),
                  )
                : null,
            );
          }),
        );
      }

      /** How many finished analyses found no issues: the review's visible negative result. */
      function cleanCountOf(review) {
        const entries = Array.isArray(review?.explanations) ? review.explanations : [];
        let done = 0;
        let clean = 0;
        for (const entry of entries) {
          if (entry === null || typeof entry !== 'object') continue;
          if (entry.status !== 'done' || entry.explanation === null || entry.explanation === undefined) continue;
          done += 1;
          const issues = Array.isArray(entry.explanation.issues) ? entry.explanation.issues : [];
          if (issues.length === 0) clean += 1;
        }
        return { done, clean };
      }
```

底部导出表追加 `FindingList, findingsOf, cleanCountOf`。

- [ ] **Step 4: 运行确认通过 + Commit**

```bash
pnpm stamp && node --test tests/client.test.js 2>&1 | tail -3
git add client.views.js tests/client.test.js
git commit -m "feat(review): expandable findings list with the negative-result count"
```

---

### Task 7: overviewFooter 增加 `page` 参数（client.conclusion.js）

**Files:**
- Modify: `client.conclusion.js:426-523`（`overviewFooter`）
- Test: `tests/client.test.js`

- [ ] **Step 1: 写失败测试（追加到 client.test.js 末尾）**

```js
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
    isOlderVersion: false,
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
```

- [ ] **Step 2: 运行确认失败**（overview 页也出现发布按钮 / notice 非空）

- [ ] **Step 3: 实现（overviewFooter 开头与 notice/publish 段）**

解构行加 `page`，函数体开头改为：

```js
      function overviewFooter(props, derived) {
        const { report, pull, selectedVersion, staleInfo, isCurrent, isOlderVersion, page } = derived;
        const t = props.t;
        const review = props.review;
        const onConclusion = page !== 'overview';
        if (report === null || report === undefined || isCurrent !== true) {
          return { actions: null, notice: null };
        }
```

发布按钮（`selectedVersion === null ? null : h(Btn, {...})` 一段）外层加闸门：

```js
          onConclusion === false || selectedVersion === null
            ? null
            : h(Btn, {
                label: publishLabel,
                primary: staleInfo === null && isOlderVersion !== true,
                disabled: props.publishBusy === true || props.previewBusy === true
                  || review.publishing === true || isOlderVersion === true,
                title: publishTitle,
                onClick: props.onPublish,
              }),
```

notice 段改为：

```js
        const coverageMissing = (props.explainedCount ?? 0) < (props.totalFiles ?? 0);
        const notice = onConclusion === false
          ? null
          : (staleInfo !== null
              ? {
                  tone: 'warn',
                  summary: fill(t('staleSummary'), { count: staleInfo.count }),
                  detail: staleDetailOf(staleInfo, coverageMissing === true, props.autoReconclude === true, t),
                }
              : (coverageMissing === true
                  ? { tone: 'note', summary: t('coverageIncomplete'), detail: null }
                  : null));
        return { actions, notice };
```

（原有的 `const notice = staleInfo !== null ? ... : (coverageMissing ...)` 整段被上面的三元替换。）

- [ ] **Step 4: 运行确认通过 + Commit**

```bash
pnpm stamp && node --test tests/client.test.js 2>&1 | tail -3
git add client.conclusion.js tests/client.test.js
git commit -m "feat(review): overviewFooter publishes only from the conclusion page"
```

---

### Task 8: OverviewPage 重写（client.views.js）

**Files:**
- Modify: `client.views.js:481-707`（`OverviewPanel` 整体替换为 `OverviewPage`；conclusion 解构追加 `ConcludingProgress` 不需要——总览不用；views 底部导出表更新）
- Modify: `client.workspace.js:867-891`（`WorkspaceOverviewPane` 的 props 传递）
- Test: `tests/client.test.js`

- [ ] **Step 1: EXPOSED 追加 `'OverviewPage'`；写失败测试**

```js
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
    fileFindings: [{ file: 'src/a.js', issues: [{ severity: 'block', point: 'a 阻塞', line: 8 }], suggestions: [] }],
    feedbackBusy: false,
    onCheckFeedback: () => {},
  }));
  const text = view.textOnly;
  assert.ok(text.includes('整体总结内容'));
  assert.ok(!text.includes('总体初筛风险'));
  assert.ok(!text.includes('初筛风险点'));
  assert.ok(text.includes('审查发现'));
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
  const review = makeReview({ round: 2, roundHistory: [makeRound(1), pinned] });
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
```

- [ ] **Step 2: 运行确认失败**（`OverviewPage is exported by no chunk`）

- [ ] **Step 3: 实现 — 用以下代码整体替换 `client.views.js` 里的 `function OverviewPanel(props) { ... }`（原 486-707 行）**

```js
      /**
       * Overview page: the fix record first (round >= 2), then the change digest, the single
       * findings list and the completeness line. Only verified facts and pending actions live
       * here — initial-screen risks, unverified notes and the report verdict are pipeline
       * internals and never render; the only decision surface is the conclusion page.
       */
      function OverviewPage(props) {
        const { review, t } = props;
        const report = review.report;
        const rounds = React.useMemo(() => roundsOf(review), [review]);
        const latestRound = rounds.length === 0 ? null : rounds[rounds.length - 1];
        const requestedRound = typeof props.selectedRoundNumber === 'number' ? props.selectedRoundNumber : null;
        const selectedRound = requestedRound === null
          ? latestRound
          : (rounds.find((entry) => entry.round === requestedRound) ?? latestRound);
        const roundNumber = selectedRound === null ? 1 : selectedRound.round;
        const isCurrent = latestRound === null || selectedRound === null || selectedRound.round === latestRound.round;
        const feedback = isCurrent ? (review.feedback ?? selectedRound?.feedback ?? null) : (selectedRound?.feedback ?? null);
        const anyPublished = Array.isArray(review.published) && review.published.length > 0;

        // The current round needs a report before anything renders; a historical round keeps
        // its own feedback/delta even though `record.report` is reset on a new round.
        if ((report === null || report === undefined) && isCurrent) {
          return h('div', { className: 'prr-zero' }, review.status === 'reviewing' ? t('reportPending') : t('noReport'));
        }

        const roundTop = roundNumber >= 2
          ? h(
              React.Fragment,
              null,
              h(FeedbackBlock, {
                feedback,
                t,
                canCheck: isCurrent === true && anyPublished === true,
                hasBaseline: anyPublished === true,
                feedbackBusy: props.feedbackBusy,
                onCheckFeedback: props.onCheckFeedback,
              }),
              h(DeltaBlock, { delta: isCurrent ? (review.delta ?? selectedRound?.delta ?? null) : (selectedRound?.delta ?? null), t }),
            )
          : null;

        if (!isCurrent) {
          return h(
            'div',
            null,
            roundTop,
            h('div', { className: 'prr-zero' }, t('historyNoReport')),
          );
        }

        const findingCount = (props.fileFindings ?? []).reduce(
          (sum, group) => sum + (group.issues?.length ?? 0) + (group.suggestions?.length ?? 0),
          0,
        );
        const clean = cleanCountOf(review);
        const coverage = review.coverage ?? null;
        const analyzed = coverage !== null && typeof coverage.analyzed === 'number' ? coverage.analyzed : clean.done;
        const total = coverage !== null && typeof coverage.total === 'number' ? coverage.total : (props.totalFiles ?? 0);

        const footer = overviewFooter(props, {
          report,
          pull: review.pull ?? {},
          selectedVersion: null,
          staleInfo: null,
          isCurrent: true,
          isOlderVersion: false,
          hasVersion: false,
          selectedPublished: false,
          page: 'overview',
        });
        React.useEffect(() => {
          actionsBridge.set(footer.actions);
          actionsBridge.setNotice(footer.notice);
          return undefined;
        }, [footer.actions, footer.notice]);
        React.useEffect(() => () => {
          actionsBridge.set(null);
          actionsBridge.setNotice(null);
        }, []);

        return h(
          'div',
          null,
          roundTop,
          h('div', { className: 'prr-h2' }, t('digestTitle')),
          h('div', { className: 'prr-card' }, h('div', { className: 'prr-text' }, report.summary)),
          h('div', { className: 'prr-h2' }, `${t('findingList')} · ${findingCount}`),
          h(FindingList, { groups: props.fileFindings ?? [], t, onOpenFile: props.onOpenFile }),
          h('div', { className: 'prr-h2' }, t('completenessTitle')),
          h(
            'div',
            { className: 'prr-completeness' },
            fill(t('metaCoverage'), { analyzed, total }),
            clean.clean > 0 ? ` · ${fill(t('completenessClean'), { clean: clean.clean })}` : null,
          ),
        );
      }
```

views 底部导出表更新（OverviewPanel 移除、OverviewPage/FindingList 等在 Task 5/6 已加）：

```js
      return {
        FilesPane, PhaseBar, DiffView, FullFileView, FileDetailPanel, ChatBox,
        OverviewPage, findingsOf, cleanCountOf, FindingList, WorkspaceCenter,
      };
```

同时删除 views 里现已无引用的组件解构与死代码：`RiskList` 从 components 解构行移除（`UnverifiedBlock` 函数定义在 views 258 行附近，明细页 343 行还在用——**保留**）。

- [ ] **Step 4: 更新 `WorkspaceOverviewPane`（client.workspace.js:849-896）**

`h(OverviewPanel, {...})` 整段替换为：

```js
              h(PhaseBar, { phase: model.phase, round: model.selectedRoundNumber ?? review?.round ?? 1, t }),
              h(OverviewPage, {
                review: review ?? { report: null, number: prNumber ?? 0, pull: null, status: 'idle', conclusion: null },
                t,
                selectedRoundNumber,
                onOpenFile: (path, line) => void openFile(path, line),
                explainedCount,
                totalFiles: (review?.files ?? []).length,
                fileFindings,
                feedbackBusy,
                onCheckFeedback: () => void checkFeedback(),
                concludeBusy,
                reviewBusy,
                onConclude: () => void runConclude(),
              }),
```

并在 `WorkspaceOverviewPane` 顶部的 model 解构里补 `phase`（`concludeBusy, concluding, ...` 行已有，无需改）。

- [ ] **Step 5: 运行确认通过 + Commit**

```bash
pnpm stamp && node --test tests/client.test.js 2>&1 | tail -3
git add client.views.js client.workspace.js tests/client.test.js
git commit -m "feat(review): overview page shows only verified facts and completeness"
```

---

### Task 9: ConclusionPage + 条目「纳入发布」开关（views + conclusion.js）

**Files:**
- Modify: `client.conclusion.js:145-239`（`ConclusionBlock` 加 `includeControl`）
- Modify: `client.views.js`（新增 `ConclusionPage`、`PublishPreviewSection`；conclusion 解构追加 `ConcludingProgress`；导出表更新）
- Modify: `client.workspace.js`（新增 `WorkspaceConclusionPane`；导出表追加）
- Test: `tests/client.test.js`

- [ ] **Step 1: EXPOSED 追加 `'ConclusionPage'`、`'PublishPreviewSection'`、`'WorkspaceConclusionPane'`；写失败测试**

```js
test('ConclusionPage renders the pending card and the published conclusion', () => {
  const { parts, fake } = loadClient();
  const t = translator(parts);
  const pending = fake.render(fake.React.createElement(parts.ConclusionPage, {
    review: makeReview({ round: 1, conclusion: null, conclusionAt: 0, coverage: { analyzed: 0, total: 2 } }),
    t,
    selectedRoundNumber: null,
    versionPick: {},
    onPickVersion: () => {},
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
    versionPick: {},
    onPickVersion: () => {},
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
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现 `ConclusionBlock` 的 `includeControl`（client.conclusion.js）**

`ConclusionBlock` 的 `section` 内（`list.map((item, index) => ...)` 里），在 `withVerdict === true ? h(VerdictPill, ...)` 之前插入勾选框，并把 `includeControl` 从 props 读出：

```js
      function ConclusionBlock(props) {
        const conclusion = props.conclusion;
        if (conclusion === null || conclusion === undefined) return null;
        const states = props.feedbackStates ?? {};
        const include = props.includeControl ?? null;
```

`section` 内每条 item 的返回元素，在 `withVerdict` pill 之前加：

```js
                  include !== null
                    ? h(
                        'label',
                        { className: 'prr-include', title: props.t('publishInclude') },
                        h('input', {
                          type: 'checkbox',
                          checked: include.isSelected(idKey),
                          onChange: () => include.onToggle(idKey),
                        }),
                      )
                    : null,
```

（`idKey` 已在该 map 内定义：`typeof item.id === 'string' && item.id !== '' ? item.id : ''`——勾选框仅在 `idKey !== ''` 时有意义，`isSelected` 对空 id 返回 false 即可不渲染勾选。实现时把 label 的渲染条件写成 `include !== null && idKey !== ''`。）

- [ ] **Step 4: 实现 `PublishPreviewSection` 与 `ConclusionPage`（client.views.js）**

views 的 conclusion 解构追加 `ConcludingProgress`：

```js
      const {
        ConclusionBlock, FeedbackBlock, PublishedBlock, conclusionMetaLine, overviewFooter,
        ConcludingProgress,
      } = conclusion;
```

在 `OverviewPage` 之后新增：

```js
      /** Collapsible live comment preview: what the current selection will post. */
      function PublishPreviewSection(props) {
        const { preview, busy, refreshing, t } = props;
        const [open, setOpen] = React.useState(false);
        if (preview === null || preview === undefined) return null;
        return h(
          'div',
          { className: 'prr-preview-section' },
          h(
            'button',
            { type: 'button', className: 'prr-dock-toggle', onClick: () => setOpen(!open) },
            h('span', { 'aria-hidden': 'true' }, open ? '▾' : '▸'),
            t('publishPreviewSection'),
            busy === true || refreshing === true
              ? h('span', { className: 'prr-subtle' }, refreshing === true ? t('previewRefreshing') : t('previewLoading'))
              : null,
          ),
          open ? h('pre', { className: 'prr-markdown' }, text(preview.markdown)) : null,
        );
      }

      /**
       * Conclusion page: the versioned decision (card, items with publish toggles, next
       * steps), the live comment preview, published records and the action footer. Dialogue
       * records (author replies, cross-round delta) live on the overview page.
       */
      function ConclusionPage(props) {
        const { review, t } = props;
        const rounds = React.useMemo(() => roundsOf(review), [review]);
        const latestRound = rounds.length === 0 ? null : rounds[rounds.length - 1];
        const requestedRound = typeof props.selectedRoundNumber === 'number' ? props.selectedRoundNumber : null;
        const selectedRound = requestedRound === null
          ? latestRound
          : (rounds.find((entry) => entry.round === requestedRound) ?? latestRound);
        const roundNumber = selectedRound === null ? 1 : selectedRound.round;
        const isCurrent = latestRound === null || selectedRound === null || selectedRound.round === latestRound.round;
        const versions = React.useMemo(
          () => versionsOf(review, selectedRound, isCurrent),
          [review, selectedRound, isCurrent],
        );
        const latestVersion = versions.length === 0 ? null : versions[versions.length - 1];
        const versionPick = props.versionPick ?? {};
        const pickedVersion = typeof versionPick[roundNumber] === 'number' ? versionPick[roundNumber] : null;
        const selectedVersion = versions.find((entry) => entry.version === pickedVersion) ?? latestVersion;
        const isOlderVersion = selectedVersion !== null
          && latestVersion !== null
          && selectedVersion.version !== latestVersion.version;
        const publishedEntries = publishedOfRound(review, roundNumber);
        const feedback = isCurrent ? (review.feedback ?? selectedRound?.feedback ?? null) : (selectedRound?.feedback ?? null);
        const feedbackStates = (feedback?.states ?? {}) ?? {};

        const versionHeader = h(
          React.Fragment,
          null,
          h(VersionSelector, {
            versions,
            selectedVersion: selectedVersion === null ? null : selectedVersion.version,
            onSelect: (version) => props.onPickVersion(
              roundNumber,
              version,
              latestVersion === null ? version : latestVersion.version,
            ),
            t,
          }),
          selectedVersion === null
            ? null
            : h('span', { className: 'prr-tag' }, t(selectedVersion.source === 'human' ? 'versionSourceHuman' : 'versionSourceModel')),
          isOlderVersion === true ? h('span', { className: 'prr-tag' }, t('versionReadOnly')) : null,
        );
        const metaLine = conclusionMetaLine(review, roundNumber, selectedVersion, publishedEntries, isCurrent, t);

        const footer = overviewFooter(props, {
          report: review.report ?? null,
          pull: review.pull ?? {},
          selectedVersion,
          staleInfo: props.staleInfo ?? null,
          isCurrent,
          isOlderVersion,
          hasVersion: versions.length > 0,
          selectedPublished: isRoundVersionPublished(
            publishedEntries,
            roundNumber,
            selectedVersion === null ? 0 : selectedVersion.version,
          ),
          page: 'conclusion',
        });
        React.useEffect(() => {
          actionsBridge.set(footer.actions);
          actionsBridge.setNotice(footer.notice);
          return undefined;
        }, [footer.actions, footer.notice]);
        React.useEffect(() => () => {
          actionsBridge.set(null);
          actionsBridge.setNotice(null);
        }, []);

        if (!isCurrent) {
          return h(
            'div',
            null,
            h(RoundMeta, { round: selectedRound, t }),
            selectedVersion === null || selectedVersion === undefined
              ? h('div', { className: 'prr-subtle' }, t('historyNoConclusion'))
              : h(ConclusionBlock, {
                  conclusion: selectedVersion.conclusion,
                  t,
                  onOpenFile: props.onOpenFile,
                  feedbackStates,
                  headerExtra: versionHeader,
                  metaLine,
                }),
            roundNumber >= 2 ? h(DeltaBlock, { delta: selectedRound?.delta ?? null, t }) : null,
            h(PublishedBlock, { entries: publishedEntries, t }),
            h('div', { className: 'prr-subtle', style: { marginTop: '10px' } }, t('historyReadOnly')),
          );
        }

        if (selectedVersion === null || selectedVersion === undefined) {
          const concluding = props.concluding ?? null;
          const coverage = review.coverage ?? null;
          return h(
            'div',
            null,
            h(
              'div',
              { className: 'prr-card' },
              concluding !== null
                ? h(ConcludingProgress, { concluding, t, cancelBusy: props.cancelBusy, onCancel: props.onCancelConclude })
                : h('div', { className: 'prr-zero' }, t('conclusionPendingCard')),
            ),
            h(
              'div',
              { className: 'prr-completeness' },
              coverage !== null && coverage !== undefined
                ? fill(t('metaCoverage'), { analyzed: coverage.analyzed ?? 0, total: coverage.total ?? 0 })
                : fill(t('metaCoverage'), { analyzed: props.explainedCount ?? 0, total: props.totalFiles ?? 0 }),
            ),
            concluding === null
              ? h(Btn, {
                  label: t('conclude'),
                  primary: true,
                  disabled: props.concludeBusy === true || props.reviewBusy === true,
                  onClick: props.onConclude,
                })
              : null,
          );
        }

        const selectedIds = props.preview !== null && props.preview !== undefined && Array.isArray(props.preview.selectedIds)
          ? props.preview.selectedIds
          : null;
        const includeControl = props.preview !== null && props.preview !== undefined && props.preview.selectionSupported === true
          ? {
              isSelected: (id) => selectedIds === null ? true : selectedIds.includes(id),
              onToggle: props.onToggleInclude,
            }
          : null;

        return h(
          'div',
          null,
          h(ConclusionBlock, {
            conclusion: selectedVersion.conclusion,
            t,
            onOpenFile: props.onOpenFile,
            feedbackStates,
            headerExtra: versionHeader,
            metaLine,
            includeControl,
          }),
          h(PublishPreviewSection, {
            preview: props.preview,
            busy: props.previewBusy,
            refreshing: props.previewRefreshBusy,
            t,
          }),
          roundNumber >= 2
            ? h(DeltaBlock, { delta: review.delta ?? selectedRound?.delta ?? null, t })
            : null,
          h(PublishedBlock, { entries: publishedEntries, t }),
          review.concludeError === null || review.concludeError === undefined || review.concludeError === ''
            ? null
            : h('div', { className: 'prr-conclude-note' }, String(review.concludeError)),
        );
      }
```

底部导出表更新：

```js
      return {
        FilesPane, PhaseBar, DiffView, FullFileView, FileDetailPanel, ChatBox,
        OverviewPage, FindingList, findingsOf, cleanCountOf,
        ConclusionPage, PublishPreviewSection, WorkspaceCenter,
      };
```

- [ ] **Step 5: 实现 `WorkspaceConclusionPane`（client.workspace.js，放在 `WorkspaceOverviewPane` 之后）**

```js
      /** Conclusion pane: the decision page with the shared status bar and the composer. */
      function WorkspaceConclusionPane({ model, paneHeader, chat }) {
        const {
          t, review, prNumber, sidebar, selectedRoundNumber,
          versionPick, pickConclusionVersion,
          concludeBusy, concluding, concludeCancelBusy, cancelConclude, reviewBusy, runConclude,
          openFile, explainedCount, fileFindings, phase,
          publishBusy, previewBusy, previewRefreshBusy, feedbackBusy, checkFeedback,
          preview, togglePreviewItem,
        } = model;
        return h(
          'section',
          { className: 'prr-overview-pane' },
          paneHeader,
          h(
            'div',
            { className: 'prr-overview-scroll' },
            h(
              'div',
              { className: 'prr-overview-inner' },
              h(PhaseBar, { phase, round: selectedRoundNumber ?? review?.round ?? 1, t }),
              h(ConclusionPage, {
                review: review ?? { report: null, number: prNumber ?? 0, pull: null, status: 'idle', conclusion: null },
                t,
                selectedRoundNumber,
                versionPick,
                onPickVersion: pickConclusionVersion,
                concludeBusy,
                concluding,
                cancelBusy: concludeCancelBusy,
                onCancelConclude: () => void cancelConclude(),
                reviewBusy,
                onConclude: () => void runConclude(),
                onOpenFile: (path, line) => void openFile(path, line),
                explainedCount,
                totalFiles: (review?.files ?? []).length,
                publishBusy,
                previewBusy,
                previewRefreshBusy,
                feedbackBusy,
                onCheckFeedback: () => void checkFeedback(),
                preview,
                onToggleInclude: (id) => togglePreviewItem(id),
                autoReconclude: model.autoReconclude,
                staleInfo: model.staleInfo,
              }),
              sidebar ? null : h('div', { className: 'prr-overview-chat' }, chat),
            ),
          ),
        );
      }
```

workspace 底部导出表（`ReviewWorkspace, WorkspaceView, WorkspaceOverviewPane, ...` 一行）追加 `WorkspaceConclusionPane`。

- [ ] **Step 6: 运行确认通过 + Commit**

```bash
pnpm stamp && node --test tests/client.test.js 2>&1 | tail -3
git add client.views.js client.conclusion.js client.workspace.js tests/client.test.js
git commit -m "feat(review): conclusion page with publish toggles and live preview"
```

---

### Task 10: 发布装配 — 安静预览 + 弹窗退化（hooks + preview.js + workspace）

**Files:**
- Modify: `client.hooks.js`（`usePublish`：`requestPreview` 加 `options.quiet`；新增 `previewModalOpen` 状态并导出）
- Modify: `client.preview.js`（弹窗移除勾选区）
- Modify: `client.workspace.js`（modal 渲染条件 + composer 预取 effect）
- Test: `tests/client.test.js`

- [ ] **Step 1: 更新弹窗测试**

找到现有 `PublishPreviewModal` 的渲染测试（`grep -n "PublishPreviewModal" tests/client.test.js`）。凡断言勾选区（`previewItems` 计数、`onToggleItem`、`selectAll`/`selectNone` 按钮、`previewSelectNoneHint`）的用例整段删除，替换为：

```js
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
```

- [ ] **Step 2: 实现 hooks（client.hooks.js 的 `usePublish`）**

在 `usePublish` 的 state 区加：

```js
      const [previewModalOpen, setPreviewModalOpen] = React.useState(false);
```

`requestPreview` 开头加一行（保持原取数逻辑不动）：

```js
      const requestPreview = React.useCallback(async (options = {}) => {
        setPreviewModalOpen(options.quiet !== true);
        // ...原有取数逻辑保持不变...
```

返回对象加 `previewModalOpen`：

```js
        return {
          preview, setPreview, previewBusy, setPreviewBusy, previewError, setPreviewError,
          previewRefreshBusy, setPreviewRefreshBusy, publishBusy, setPublishBusy, publishError, setPublishError,
          requestPreview, refreshPreview, closePreview, togglePreviewItem,
          selectAllPreviewItems, selectNonePreviewItems, submitPublish,
          previewModalOpen,
        };
```

`closePreview` 里补 `setPreviewModalOpen(false);`。

- [ ] **Step 3: 实现弹窗简化（client.preview.js）**

`PublishPreviewModal` 内删除：`items` / `selectionSupported` / `selectedCount` / `nothingSelected` / `selectedIds` / `selected` / `toggleItem` / `selectAll` / `selectNone` 的定义与 `itemList` 整段（36-97 行）、`previewItemsHint` / `previewSelectNoneHint` 渲染、modal footer 按钮的 `nothingSelected === true` disabled 条件。保留：标题、`prr-markdown` 预览、conflict 两条 warn、error、取消/确认按钮。props 解构改为：

```js
      function PublishPreviewModal(props) {
        const { preview, t, busy, error, onConfirm, onCancel } = props;
        const conflict = typeof preview?.conflict === 'string' ? preview.conflict : '';
        const refreshing = props.refreshing === true;
```

确认按钮 disabled：`disabled: busy === true || refreshing === true`。

- [ ] **Step 4: workspace 接线（client.workspace.js）**

容器（`ReviewWorkspace`）从 `usePublish(...)` 的解构行补 `previewModalOpen`；model 对象补 `previewModalOpen`。

`WorkspaceView` 里 modal 渲染条件（约 770 行）改为：

```js
            preview === null || previewModalOpen !== true
              ? null
              : h(PublishPreviewModal, {
                  key: 'publish-preview',
                  preview,
                  t,
                  busy: publishBusy,
                  refreshing: previewRefreshBusy,
                  error: previewError,
                  onConfirm: (force) => void submitPublish(force),
                  onCancel: closePreview,
                }),
```

（`onToggleItem / onSelectAll / onSelectNone` 三个 prop 移除。）

`WorkspaceView` 解构行补 `previewModalOpen`。

容器内新增 composer 预取 effect（`phase` memo 在 Task 11 之后也可先加本 effect，引用 `mode` 与 `review`）：

```js
        // The conclusion page composes the publish inline: keep a preview prepared (quietly,
        // without opening the modal) while that page is visible with a conclusion present.
        React.useEffect(() => {
          if (mode !== 'conclusion') return;
          if (review === null || review.conclusion === null || review.conclusion === undefined) return;
          if (preview !== null || previewBusy === true) return;
          void requestPreview({ quiet: true });
        }, [mode, review, preview, previewBusy, requestPreview]);
```

- [ ] **Step 5: 运行确认通过 + Commit**

```bash
pnpm stamp && node --test tests/client.test.js 2>&1 | tail -3
git add client.hooks.js client.preview.js client.workspace.js tests/client.test.js
git commit -m "feat(review): compose the publish on the page, modal confirms only"
```

---

### Task 11: Workspace 接线 — mode 扩展 / sticky 结论入口 / derivePhase / 自动切换

**Files:**
- Modify: `client.workspace.js`（容器 state 与 effect；`WorkspaceView` 布局；`FilesPane` props；`model`）
- Modify: `client.views.js`（`FilesPane`：结论入口 + 徽标）
- Test: `tests/client.test.js`

- [ ] **Step 1: 写失败测试（FilesPane 尾区 + 徽标）**

```js
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

  const active = fake.render(fake.React.createElement(parts.FilesPane, {
    ...base,
    conclusionMode: true,
    phase: { phase: 'published', progress: null, nextAction: 'append', version: 3 },
  }));
  assert.ok(active.textOnly.includes('v3 已发布'));
});
```

- [ ] **Step 2: 运行确认失败**

- [ ] **Step 3: 实现 FilesPane（client.views.js，整体替换现有 `FilesPane`）**

```js
      /**
       * Left column: the overview entry, the changed-file header, the file list, and — pinned
       * to the bottom regardless of list length — the conclusion entry. The rail order is the
       * review's reading order: overview, files, conclusion; badges carry the live state.
       */
      function FilesPane(props) {
        const {
          t, overviewMode, conclusionMode, onSelectOverview, onSelectConclusion,
          files, filePath, review, onOpenFile, phase,
        } = props;
        const width = typeof props.width === 'number' && props.width > 0 ? props.width : 0;
        const style = width === 0 ? undefined : { flex: `0 0 ${width}px`, minWidth: `${width}px` };
        const analyzing = isAnalyzing(props.analyzing) ? props.analyzing : null;
        const done = analyzing === null ? 0 : Math.min(Math.max(analyzing.done ?? 0, 0), analyzing.total);
        const failed = analyzing === null ? 0 : Math.min(Math.max(analyzing.failed ?? 0, 0), analyzing.total);
        const countLabel = analyzing === null
          ? `${files.length} ${t('fileUnit')}`
          : fill(t('analyzingFiles'), { done, total: analyzing.total })
            + (failed > 0 ? fill(t('analyzingFailed'), { failed }) : '');
        return h(
          'aside',
          { className: 'prr-files', style },
          h(
            'button',
            {
              type: 'button',
              className: 'prr-navrow',
              'data-active': overviewMode === true ? 'true' : 'false',
              onClick: () => onSelectOverview(),
            },
            h('span', { className: 'prr-navrow-mark' }),
            t('overview'),
            h('span', { className: 'prr-navrow-badge' }, phaseStateText(phase, t)),
          ),
          h(
            'div',
            { className: 'prr-pane-head' },
            `${t('files')}`,
            h('span', { className: 'prr-count', title: analyzing === null ? undefined : analyzing.current }, countLabel),
            props.manual === true && analyzing === null && files.length > 0
              ? h(Btn, {
                  small: true,
                  label: props.analyzeAllBusy === true ? t('explaining') : t('analyzeAll'),
                  title: t('analyzeAllHint'),
                  disabled: props.analyzeAllBusy === true,
                  onClick: () => props.onAnalyzeAll(),
                })
              : null,
          ),
          h(
            'div',
            { className: 'prr-filelist' },
            files.length === 0
              ? h('div', { className: 'prr-zero' }, review === null ? t('emptyReview') : t('noFiles'))
              : files.map((item) =>
                  h(FileRow, {
                    key: item.path,
                    item,
                    active: item.path === filePath,
                    onOpen: onOpenFile,
                  }),
                ),
          ),
          h(
            'div',
            { className: 'prr-files-tail' },
            h(
              'button',
              {
                type: 'button',
                className: 'prr-navrow',
                'data-active': conclusionMode === true ? 'true' : 'false',
                onClick: () => onSelectConclusion(),
              },
              h('span', { className: 'prr-navrow-mark' }),
              t('conclusionNav'),
              h('span', { className: 'prr-navrow-badge' }, conclusionBadgeText(phase, t)),
            ),
          ),
        );
      }
```

views 的 core 解构追加 `conclusionBadgeText`（Task 1 已导出）。

- [ ] **Step 4: 容器接线（client.workspace.js 的 `ReviewWorkspace` 容器内）**

① 在 `const concluding = review?.concluding ?? null;` 附近新增派生：

```js
        const staleInfo = React.useMemo(() => {
          if (review === null || review === undefined) return null;
          const current = reviewRounds.length === 0 ? null : reviewRounds[reviewRounds.length - 1];
          return staleInfoOf(review, versionsOf(review, current, true));
        }, [review, reviewRounds]);
        const phase = React.useMemo(
          () => derivePhase(review, staleInfo, { manual: list?.autoAnalyze === false }),
          [review, staleInfo, list],
        );
```

（`derivePhase` / `staleInfoOf` / `versionsOf` 来自容器已有的 deps 解构；若容器解构没有它们，在 `createWorkspace(deps)` 的解构里补。）

② 自动切换 effect（放在 phase 定义之后）：

```js
        // When concluding finishes, land on the conclusion page — but only from the overview;
        // a reviewer reading a file is not interrupted, the badges carry the state instead.
        const previousPhaseRef = React.useRef(null);
        React.useEffect(() => {
          const previous = previousPhaseRef.current;
          previousPhaseRef.current = phase.phase;
          if (previous !== 'concluding') return;
          if (phase.phase !== 'concluded' && phase.phase !== 'concluded-stale'
            && phase.phase !== 'published' && phase.phase !== 'published-stale') return;
          if (mode !== 'overview' || selectedIsCurrent !== true) return;
          setMode('conclusion');
        }, [phase, mode, selectedIsCurrent]);
```

③ `model` 对象补：`phase, staleInfo, previewModalOpen`。

- [ ] **Step 5: 布局接线（`WorkspaceView`）**

解构补 `phase`。三处修改：

① `const overviewMode`（约 595 行）改为：

```js
        const conclusionMode = mode === 'conclusion';
        const overviewMode = mode === 'overview' || (filePath === '' && mode !== 'conclusion');
```

② `overviewPane`（约 633 行）之后新增：

```js
        const conclusionPane = h(WorkspaceConclusionPane, { model, paneHeader, chat: chatBox('pull') });
```

③ `filesPane`（约 687-703 行）的 props 增加：

```js
          conclusionMode,
          onSelectConclusion: () => setMode('conclusion'),
          phase,
```

并删除已不存在的 `overviewMode` 传参语义不变（保留）。四组布局分支（726-744 行）里，`overviewMode ? overviewPane : ...` 之前插入 conclusion 分支——把每处的三元链改成：

```js
                  : (conclusionMode
                      ? h('div', { className: 'prr-body' }, filesPane, resizer('files'), conclusionPane)
                      : overviewMode
                        ? h('div', { className: 'prr-body' }, filesPane, resizer('files'), overviewPane)
                        : narrowFile
                          ? ...（原样）
                          : ...（原样）)
```

（sidebar 与非 sidebar 两组都照此包一层 `conclusionMode` 分支；narrow 分支内部不变。）

④ `WorkspaceFileDetailPane`（916-924 行）加 PhaseBar：

```js
      function WorkspaceFileDetailPane({ paneHeader, analysis, chat, width, phaseBar }) {
        return h(
          'aside',
          { className: 'prr-detail', style: { flex: `0 0 ${width}px`, minWidth: '120px' } },
          paneHeader,
          phaseBar,
          analysis,
          chat,
        );
      }
```

调用处（约 680-685 行）传 `phaseBar: h(PhaseBar, { phase: model.phase, round: model.selectedRoundNumber ?? review?.round ?? 1, t: model.t })`。`WorkspaceView` 需要能构造它——在 model 解构处补 `phase` 后就地构造。

- [ ] **Step 6: 运行确认通过 + Commit**

```bash
pnpm stamp && node --test tests/client.test.js 2>&1 | tail -3
git add client.workspace.js client.views.js tests/client.test.js
git commit -m "feat(review): three-pane wiring with sticky conclusion entry and auto-switch"
```

---

### Task 12: 全量验证 + README 同步

**Files:**
- Modify: `README.zh-CN.md`（功能与使用两节）
- Modify: `README.md`（对应英文节）

- [ ] **Step 1: 全量测试**

Run: `pnpm test`
Expected: stamp:check 通过，全部测试 PASS。若有既有用例因「总览不再渲染初筛风险/未验证」而断言失败，按新契约更新这些断言（删除对 `initialRisks` / `unverified` 区块的断言），不改实现去迎合旧断言。

- [ ] **Step 2: README.zh-CN.md 更新**

「功能」节替换三条 bullet：

```markdown
- **审查面板**：会话内右侧边栏面板——总览 / 变更文件 / 结论三页导航。总览呈现对话状态（作者回复与跨轮对照）、改动概述、唯一一份审查发现清单与审查完备性；点击文件进入 diff 与逐文件分析；结论页承载最终结论、发布装配与已发布记录。列宽可拖动。
- **最终结论**：后台生成，展示阶段进度、可随时取消；结论带审查覆盖率与版本号，过期时提示重新生成。面板上唯一的判定出口，总览不再显示初筛判定。
- **发布**：在结论页条目上直接勾选「纳入发布」，评论预览按勾选实时生成；发布弹窗只做最终确认（全文与冲突提示）。每轮追加一条新评论，并标注被审 commit、轮次、结论版本与覆盖率。
```

「使用」节第 3、5、6 步替换：

```markdown
3. 总览页看改动概述、审查发现与完备性；左栏点文件进入明细页看 diff 与逐段讲解。
5. 左栏「结论」入口进入结论页，点「生成最终结论」；生成完成会自动切到结论页（在明细页阅读时不会被打断）。
6. 在结论条目上勾选「纳入发布」，展开「评论预览」确认 markdown 后点「发布」。
```

`README.md` 对应英文段做同义替换（Findings / Conclusion / publish composing 表述）。

- [ ] **Step 3: Commit**

```bash
git add README.zh-CN.md README.md
git commit -m "docs(review): document the three-page navigation and inline publish composing"
```

---

## 自查记录（写计划时已核对）

- **Spec 覆盖**：§4 derivePhase → Task 1；§5 sticky 入口/徽标/历史落点 → Task 2、11；§6.1 总览页 → Task 5-8、11；§6.3 结论页 + 发布装配 → Task 7、9、10；§6.4 PhaseBar → Task 5、11；§7 自动切换 → Task 11；§9 i18n → Task 3；§10 测试 → 各任务；§12 为后续期不在本计划。PublishedBlock 经核对已是紧凑形态（仅元信息行），无需改写，仅在 Task 9 原样迁移——此处与 spec §6.3 第 4 条「紧凑化」表述的差异是 spec 对现状的误记，实现以现状为准。
- **占位符**：Task 1 Step 2 末条断言依赖 `fill` 对未知 key 的行为，已注明「先跑再定字符串」——这是唯一允许现场校准的点，其余步骤均含完整代码。
- **命名一致性**：`derivePhase(review, staleInfo, options)` / `phaseStateText(phase, t)` / `conclusionBadgeText(phase, t)` / `findingsOf(groups)` / `cleanCountOf(review)` / `FindingList{groups,t,onOpenFile}` / `ConclusionPage` props（`preview, onToggleInclude, staleInfo, ...`）在各任务间一致；`includeControl = { isSelected, onToggle }`。

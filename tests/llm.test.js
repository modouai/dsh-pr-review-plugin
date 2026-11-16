/**
 * Unit tests for the conclusion-history contract (§5) in llm.js.
 *
 * Run with: node --test tests/
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PLATFORM_LABELS,
  buildCommentMarkdown,
  buildConcludePrompt,
  buildExplainPrompt,
  buildExplainVerifyPrompt,
  buildFeedbackPrompt,
  buildReportPrompt,
  buildReportVerifyPrompt,
  calibrateVerdict,
  callModel,
  commentItems,
  compareComments,
  conclusionCoverage,
  extractJson,
  itemId,
  mergeConclusion,
  normalizeConcerns,
  normalizeConclusion,
  normalizeEvidenceNeeds,
  normalizeExplanation,
  normalizeReport,
  normalizeUnverified,
  normalizeVerdict,
  partitionSuggestions,
  partitionVerdicts,
  parseFeedbackReply,
  platformLabel,
  textSimilarity,
} from '../llm.js';

test('normalizeVerdict: keeps known verdicts and falls back on anything else', () => {
  assert.equal(normalizeVerdict('block'), 'block');
  assert.equal(normalizeVerdict('suggest'), 'suggest');
  assert.equal(normalizeVerdict('pass'), 'pass');
  assert.equal(normalizeVerdict('BLOCK'), 'suggest');
  assert.equal(normalizeVerdict('nonsense'), 'suggest');
  assert.equal(normalizeVerdict(undefined), 'suggest');
  assert.equal(normalizeVerdict(null, 'pass'), 'pass');
  assert.equal(normalizeVerdict('', 'block'), 'block');
});

test('itemId: stable, kind-prefixed and distinct', () => {
  const blocker = itemId('blocker', 'src/a.js', '空指针风险');
  assert.match(blocker, /^b-[0-9a-f]{6}$/);
  assert.equal(blocker, itemId('blocker', 'src/a.js', '空指针风险'));
  // Whitespace/case never change the id.
  assert.equal(blocker, itemId('blocker', ' src/a.js ', '  空指针风险 '));
  assert.match(itemId('suggestion', 'src/a.js', '补测试'), /^s-[0-9a-f]{6}$/);
  assert.notEqual(blocker, itemId('suggestion', 'src/a.js', '空指针风险'));
  assert.notEqual(blocker, itemId('blocker', 'src/a.js', '另一个问题'));
  assert.notEqual(blocker, itemId('blocker', 'src/b.js', '空指针风险'));
});

test('normalizeConclusion: drops empty items, dedupes, marks unknown files, keeps unique model ids', () => {
  const conclusion = normalizeConclusion({
    verdict: 'block',
    summary: '  总结  ',
    blockers: [
      { file: 'src/a.js', point: '  问题一  ', id: 'model-id-1' },
      { file: 'src/a.js', point: '问题一' },
      { file: 'src/missing.js', point: '问题二' },
      { file: 'src/a.js', point: '   ' },
      null,
    ],
    suggestions: [
      { file: 'src/b.js', point: '建议一' },
      { file: 'src/b.js', point: '建议一' },
    ],
    nextSteps: [' 第一步 ', '  ', 3],
  }, { files: ['src/a.js', 'src/b.js'] });

  assert.equal(conclusion.verdict, 'block');
  assert.equal(conclusion.summary, '总结');
  // The duplicate (same point, different/no id) is removed.
  assert.equal(conclusion.blockers.length, 2);
  assert.equal(conclusion.blockers[0].id, 'model-id-1');
  assert.equal(conclusion.blockers[0].point, '问题一');
  assert.equal(conclusion.blockers[0].file, 'src/a.js');
  // Unknown file is dropped from `file` and marked inside the point.
  assert.equal(conclusion.blockers[1].file, '');
  assert.equal(conclusion.blockers[1].point, '（未定位：src/missing.js）问题二');
  assert.equal(conclusion.suggestions.length, 1);
  assert.match(conclusion.suggestions[0].id, /^s-[0-9a-f]{6}$/);
  assert.deepEqual(conclusion.nextSteps, ['第一步']);
});

test('normalizeConclusion: rejects invalid/duplicate model ids and defaults bad verdicts', () => {
  const conclusion = normalizeConclusion({
    verdict: 'whatever',
    blockers: [
      { file: 'a.js', point: '一', id: '1' },
      { file: 'a.js', point: '二', id: '1' },
      { file: 'a.js', point: '三', id: 'b-abcdef' },
    ],
  });
  assert.equal(conclusion.verdict, 'suggest');
  // "1" is not a safe id → generated; the second item cannot reuse it.
  assert.match(conclusion.blockers[0].id, /^b-[0-9a-f]{6}$/);
  assert.notEqual(conclusion.blockers[1].id, conclusion.blockers[0].id);
  // A safe unique model id is preserved.
  assert.equal(conclusion.blockers[2].id, 'b-abcdef');
});

test('normalizeConclusion: parses line as a positive integer, otherwise 0', () => {
  const conclusion = normalizeConclusion({
    blockers: [
      { file: 'a.js', point: '行号有效', line: 12 },
      { file: 'a.js', point: '行号为 0', line: 0 },
      { file: 'a.js', point: '负行号', line: -3 },
      { file: 'a.js', point: '小数行号', line: 4.7 },
      { file: 'a.js', point: '字符串行号', line: '9' },
      { file: 'a.js', point: '缺省行号' },
    ],
  });
  assert.deepEqual(conclusion.blockers.map((item) => item.line), [12, 0, 0, 0, 0, 0]);
  // line is always present in the item shape, never omitted.
  for (const item of conclusion.blockers) assert.equal(typeof item.line, 'number');
});

test('commentItems + buildCommentMarkdown: renders path:line, plain path, or no location', () => {
  const conclusion = {
    verdict: 'suggest',
    summary: 's',
    blockers: [{ id: 'b-abcdef', file: 'src/a.js', point: '位于第 12 行', line: 12 }],
    suggestions: [
      { id: 's-abcdef', file: 'src/b.js', point: '无行号', line: 0 },
      { id: 's-oooooo', file: '', point: '未定位条目', line: 3 },
    ],
    nextSteps: [],
  };
  const items = commentItems(conclusion);
  assert.deepEqual(items.map((item) => item.line), [12, 0, 3]);
  const zh = buildCommentMarkdown(conclusion, { number: 1, title: 't' }, 1, { language: 'zh' });
  assert.match(zh, /1\. `src\/a\.js:12` — 位于第 12 行/);
  assert.match(zh, /2\. `src\/b\.js` — 无行号/);
  assert.match(zh, /3\. 未定位条目/);
  const en = buildCommentMarkdown(conclusion, { number: 1, title: 't' }, 1, { language: 'en' });
  assert.match(en, /1\. `src\/a\.js:12` — 位于第 12 行/);
  assert.match(en, /2\. `src\/b\.js` — 无行号/);
});

test('conclusionCoverage: counts finished explanations against the changed files', () => {
  const explanations = new Map([
    ['a.js', { status: 'done', explanation: { summary: 's' } }],
    ['b.js', { status: 'error', explanation: null }],
    ['c.js', { status: 'done', explanation: { summary: 's' } }],
  ]);
  const coverage = conclusionCoverage(explanations, [{ path: 'a.js' }, { path: 'b.js' }, { path: 'd.js' }]);
  assert.deepEqual(coverage, { analyzed: 1, total: 3, unanalyzed: ['b.js', 'd.js'] });

  // Plain string file lists and object/array explanation shapes are accepted too.
  assert.deepEqual(
    conclusionCoverage({ 'a.js': { status: 'done' } }, ['a.js', 'b.js']),
    { analyzed: 1, total: 2, unanalyzed: ['b.js'] },
  );
  assert.deepEqual(conclusionCoverage([], []), { analyzed: 0, total: 0, unanalyzed: [] });
});

test('calibrateVerdict: the four contract rules', () => {
  const base = { verdict: 'pass', summary: 's', blockers: [], suggestions: [], nextSteps: [] };
  // Rule 1: human edited → untouched object.
  const human = { ...base, verdict: 'pass', blockers: [{ id: 'b-1', file: '', point: 'x' }] };
  assert.equal(calibrateVerdict(human, { humanEdited: true }), human);
  // Rule 2: blockers force block.
  assert.equal(calibrateVerdict({ ...base, blockers: [{ id: 'b-1', file: '', point: 'x' }] }).verdict, 'block');
  // Rule 3: any explicit block severity forces block.
  assert.equal(calibrateVerdict(base, { fileSeverities: [{ file: 'a.js', severity: 'block' }] }).verdict, 'block');
  assert.equal(calibrateVerdict({ ...base, suggestions: [{ id: 's-1', file: '', point: 'x', severity: 'block' }] }).verdict, 'block');
  // Rule 4: pass with suggestions becomes suggest.
  assert.equal(calibrateVerdict({ ...base, suggestions: [{ id: 's-1', file: '', point: 'x' }] }).verdict, 'suggest');
  // Otherwise unchanged.
  assert.equal(calibrateVerdict({ ...base, verdict: 'suggest' }).verdict, 'suggest');
});

test('mergeConclusion: inherits ids for reworded items, keeps locked items, assigns new ids', () => {
  const previous = {
    verdict: 'block',
    summary: '旧',
    blockers: [
      { id: 'b-aaaaaa', file: 'a.js', point: '这里存在空指针风险，可能导致崩溃', line: 10 },
      { id: 'b-bbbbbb', file: 'b.js', point: '人工确认必须修复的旧问题', line: 7 },
    ],
    suggestions: [{ id: 's-cccccc', file: 'c.js', point: '补充单元测试覆盖', line: 30 }],
    nextSteps: [],
  };
  const generated = {
    verdict: 'block',
    summary: '新',
    blockers: [
      // Reworded but same kind+file and similar point → inherits b-aaaaaa (and its line).
      { file: 'a.js', point: '这里存在空指针风险，可能会导致崩溃', line: 0 },
      // Brand new finding.
      { file: 'd.js', point: '新增的并发问题', line: 20 },
    ],
    suggestions: [],
    nextSteps: ['修'],
  };
  const merged = mergeConclusion(previous, generated, { lockedItemIds: ['b-bbbbbb', 's-cccccc'] });
  assert.equal(merged.summary, '新');
  assert.equal(merged.verdict, 'block');
  assert.equal(merged.blockers.length, 3);
  assert.equal(merged.blockers[0].id, 'b-aaaaaa');
  // Reworded match with line 0 inherits the previous line.
  assert.equal(merged.blockers[0].line, 10);
  assert.equal(merged.blockers[1].file, 'd.js');
  assert.equal(merged.blockers[1].line, 20);
  assert.match(merged.blockers[1].id, /^b-[0-9a-f]{6}$/);
  assert.notEqual(merged.blockers[1].id, merged.blockers[0].id);
  // Locked previous item the model dropped is appended verbatim (own line kept).
  assert.deepEqual(merged.blockers[2], { id: 'b-bbbbbb', file: 'b.js', point: '人工确认必须修复的旧问题', line: 7 });
  // The locked suggestion is preserved too.
  assert.equal(merged.suggestions.length, 1);
  assert.equal(merged.suggestions[0].id, 's-cccccc');
  assert.deepEqual(merged.nextSteps, ['修']);
});

test('compareComments: reworded items stay open, deleted items resolve, ids win', () => {
  const previous = [
    { kind: 'blocker', id: 'b-oldab', file: 'a.js', point: '这里存在空指针风险，可能导致崩溃' },
    { kind: 'suggestion', file: 'b.js', point: '建议补充单元测试覆盖' },
    { kind: 'suggestion', file: 'c.js', point: '完全删除的建议' },
  ];
  const current = [
    // Same id, different wording → still open.
    { kind: 'blocker', id: 'b-oldab', file: 'a.js', point: '换了措辞但仍是那条' },
    // No id, reworded, high similarity → still open.
    { kind: 'suggestion', file: 'b.js', point: '建议补充单元测试的覆盖' },
  ];
  const { resolved, stillOpen } = compareComments(previous, current);
  assert.equal(stillOpen.length, 2);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].point, '完全删除的建议');
  // Similarity helper itself is sane.
  assert.equal(textSimilarity('abc', 'abc'), 1);
  assert.ok(textSimilarity('abcdef', 'abcdeg') > 0.8);
});

test('commentItems: numbered, keyed and carrying the stable id', () => {
  const items = commentItems({
    blockers: [{ id: 'b-abcdef', file: 'a.js', point: '问题' }],
    suggestions: [{ file: 'b.js', point: '建议' }],
  });
  assert.equal(items.length, 2);
  assert.equal(items[0].id, 'b-abcdef');
  assert.equal(items[0].index, 1);
  assert.equal(items[1].index, 2);
  assert.match(items[1].id, /^s-[0-9a-f]{6}$/);
  assert.equal(items[0].key, 'blocker|a.js|问题');
});

test('buildCommentMarkdown: zh footer, checkbox, coverage, round title', () => {
  const conclusion = {
    verdict: 'block',
    summary: '有阻塞项。',
    blockers: [{ id: 'b-1', file: 'src/a.js', point: '必须修' }],
    suggestions: [{ id: 's-1', file: 'src/b.js', point: '可以修' }],
    nextSteps: ['先修阻塞项'],
  };
  const markdown = buildCommentMarkdown(conclusion, { number: 12, title: '标题' }, 2, {
    language: 'zh',
    coverage: { analyzed: 3, total: 5, unanalyzed: ['x.js', 'y.js'] },
  });
  assert.match(markdown, /^## PR 审查结论（第 2 轮复审）：阻塞/);
  // A bare count is named; the appendix pointer only appears when it lists the files.
  assert.match(markdown, /覆盖：已分析 3\/5 个变更文件（2 个未分析）。/);
  assert.match(markdown, /### 阻塞项/);
  assert.match(markdown, /1\. `src\/a\.js` — 必须修/);
  assert.match(markdown, /### 修改建议/);
  assert.match(markdown, /### 下一步/);
  assert.match(markdown, /- \[ \] 先修阻塞项/);
  assert.match(markdown, /<sub>由 DeepSeek harness PR 审查插件生成 · /);
  assert.doesNotMatch(markdown, /Acme PR 审查插件生成/);
});

test('buildCommentMarkdown: en footer and labels', () => {
  const markdown = buildCommentMarkdown(
    { verdict: 'suggest', summary: 'ok', blockers: [], suggestions: [{ file: '', point: 'add test' }], nextSteps: ['ship'] },
    { number: 3, title: 'Title' },
    1,
    { language: 'en', coverage: { analyzed: 1, total: 1, unanalyzed: [] } },
  );
  assert.match(markdown, /^## PR review conclusion: Suggest/);
  assert.match(markdown, /Coverage: analyzed 1\/1 changed files\./);
  assert.match(markdown, /### Blockers\nNo blockers\./);
  assert.match(markdown, /- \[ \] ship/);
  assert.match(markdown, /<sub>Generated by DeepSeek harness PR review plugin · /);
});

test('buildCommentMarkdown: commit/version header, selection note and appendix', () => {
  const conclusion = {
    verdict: 'suggest',
    summary: '整体建议',
    blockers: [{ id: 'b-1', file: 'src/a.js', point: '必须修', line: 12 }],
    suggestions: [],
    nextSteps: ['补测试'],
  };
  const markdown = buildCommentMarkdown(conclusion, { number: 7, title: '标题' }, 2, {
    language: 'zh',
    coverage: { analyzed: 1, total: 3, unanalyzed: ['src/b.js', 'src/c.js'] },
    headSha: 'abcdef1234567890',
    version: 2,
    selection: { total: 3, included: 1, omittedBlockers: 1, omittedSuggestions: 1 },
    appendix: {
      risks: [{ severity: 'suggest', file: 'src/a.js', point: '初筛风险' }],
      files: [{ file: 'src/a.js', issues: [{ severity: 'block', point: '细节', line: 5 }], suggestions: ['补注释'] }],
      order: [{ file: 'src/a.js', reason: '入口' }],
      delta: { resolved: [{ file: 'src/a.js', point: '老问题' }], stillOpen: [] },
      unanalyzed: ['src/b.js', 'src/c.js'],
    },
  });

  // Traceability: reviewed commit + round + conclusion version.
  assert.match(markdown, /`commit abcdef12` · 第 2 轮 · 结论 v2/);
  // Never claim completeness when the selection left items out.
  assert.match(markdown, /本次评论仅纳入 1\/3 条审查意见/);
  assert.match(markdown, /本次评论未纳入 1 条阻塞项/);
  assert.match(markdown, /本次评论未纳入 1 条修改建议/);
  // Unanalyzed files are named, not just counted.
  assert.match(markdown, /覆盖：已分析 1\/3 个变更文件（2 个未分析，清单见附录）/);
  // The appendix carries the panel-only content.
  assert.match(markdown, /<details>/);
  assert.match(markdown, /#### 总体初筛风险/);
  assert.match(markdown, /\[提示\] `src\/a\.js` — 初筛风险/);
  assert.match(markdown, /#### 逐文件审查发现/);
  assert.match(markdown, /\[阻塞\] 细节（行 5）/);
  assert.match(markdown, /- 建议：补注释/);
  assert.match(markdown, /#### 审查顺序/);
  assert.match(markdown, /1\. `src\/a\.js` — 入口/);
  assert.match(markdown, /#### 复审对比/);
  assert.match(markdown, /- 已修复：`src\/a\.js` — 老问题/);
  assert.match(markdown, /#### 未分析文件/);
  assert.match(markdown, /- `src\/b\.js`/);
  // The appendix sits before the footer, inside the body.
  assert.ok(markdown.indexOf('<details>') < markdown.indexOf('<sub>'));
});

test('buildCommentMarkdown stays under the platform limit by shrinking the appendix', () => {
  const risks = Array.from({ length: 400 }, (_, index) => ({
    severity: 'suggest',
    file: `src/file-${index}.ts`,
    point: '这是一条足够长的初筛风险说明，用于撑大评论长度。'.repeat(4),
  }));
  const files = Array.from({ length: 200 }, (_, index) => ({
    file: `src/file-${index}.ts`,
    issues: Array.from({ length: 20 }, (_, issue) => ({
      severity: 'block',
      point: '详细问题描述'.repeat(10),
      line: issue + 1,
    })),
    suggestions: Array.from({ length: 20 }, () => '建议内容'.repeat(10)),
  }));
  const options = {
    language: 'zh',
    coverage: { analyzed: 1, total: 2, unanalyzed: ['a.js'] },
    appendix: { risks, files, order: [], delta: null, unanalyzed: ['a.js'] },
  };
  // A huge appendix is compacted, not truncated away.
  const compacted = buildCommentMarkdown(
    { verdict: 'suggest', summary: '长评论', blockers: [], suggestions: [], nextSteps: [] },
    { number: 9, title: '大 PR' },
    2,
    options,
  );
  assert.ok(compacted.length <= 60000, `comment is ${compacted.length} chars`);
  assert.match(compacted, /长评论/);
  assert.match(compacted, /…另有 \d+ 条/);

  // A huge conclusion body cannot fit at all: the appendix is dropped, then the body is cut.
  const huge = {
    verdict: 'suggest',
    summary: '巨额评论',
    blockers: [],
    suggestions: Array.from({ length: 4000 }, (_, index) => ({
      id: `s-${index}`,
      file: `src/file-${index % 50}.ts`,
      point: '这条修改建议很长，用来把评论体撑爆。'.repeat(5),
    })),
    nextSteps: ['继续'],
  };
  const truncated = buildCommentMarkdown(huge, { number: 9, title: '大 PR' }, 2, options);
  assert.ok(truncated.length <= 60000, `comment is ${truncated.length} chars`);
  assert.match(truncated, /评论过长已截断|附录过长已省略/);
  assert.match(truncated, /巨额评论/);
});

test('buildConcludePrompt: coverage, unanalyzed (<=20), previous ids, locked ids, feedback, chat, schema id', () => {
  const unanalyzed = Array.from({ length: 25 }, (_, index) => `file-${index + 1}.js`);
  const explanations = new Map([
    ['a.js', { verdict: 'suggest', summary: 's', issues: [], suggestions: [] }],
  ]);
  const pullChat = Array.from({ length: 15 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `消息-${index + 1}-${'z'.repeat(500)}`,
  }));
  const prompt = buildConcludePrompt(
    { platform: 'forgejo', repo: 'acme/demo', number: 7, title: 't', headRef: 'h', baseRef: 'b', changedFiles: 26, additions: 1, deletions: 2 },
    { verdict: 'suggest', summary: '报告', risks: [] },
    explanations,
    { verdict: 'suggest', summary: '当前', blockers: [{ id: 'b-current', file: 'a.js', point: 'p' }], suggestions: [], nextSteps: [] },
    {
      coverage: { analyzed: 1, total: 26, unanalyzed },
      previousItems: [{ kind: 'blocker', id: 'b-prev01', file: 'a.js', point: '上一轮的问题', line: 5 }],
      humanItemIds: ['b-prev01'],
      feedback: { states: { 'b-prev01': { status: 'fixed-claimed', reason: '已修复' } }, notes: ['整体看过了'] },
      pullChat,
    },
  );
  const text = prompt.messages[0].content[0].text;
  assert.match(text, /## 覆盖率/);
  assert.match(text, /已分析 1\/26 个变更文件/);
  assert.match(text, /file-1\.js/);
  assert.match(text, /file-20\.js/);
  assert.doesNotMatch(text, /file-21\.js/);
  assert.match(text, /等 25 个/);
  assert.match(text, /b-prev01/);
  assert.match(text, /a\.js:5 — 上一轮的问题/);
  assert.match(text, /人工锁定 id（这些条目由人工确认，必须原样保留，不得删除或改写其 point）：b-prev01/);
  assert.match(text, /## 实现者反馈/);
  assert.match(text, /作者表示已修复或已改：已修复/);
  assert.match(text, /## 人机讨论（最近 12 条，每条截断 400 字）/);
  assert.match(text, /消息-15-/);
  assert.doesNotMatch(text, /消息-3-/);
  assert.doesNotMatch(text, new RegExp(`z{450}`));
  assert.match(text, /"id": "可选：沿用上一轮条目的 id"/);
  assert.match(text, /"line": 0/);
  assert.match(text, /line 为 PR head 新文件行号/);
});

test('buildConcludePrompt: marks truncated report/explanations explicitly', () => {
  const explanations = new Map([
    ['a.js', { verdict: 'suggest', summary: 'y'.repeat(20000), issues: [], suggestions: [] }],
  ]);
  const prompt = buildConcludePrompt(
    { platform: 'forgejo', repo: 'acme/demo', number: 1, title: 't', headRef: 'h', baseRef: 'b', changedFiles: 1, additions: 0, deletions: 0 },
    { verdict: 'suggest', summary: 'x'.repeat(6000), risks: [] },
    explanations,
    null,
  );
  const text = prompt.messages[0].content[0].text;
  assert.match(text, /……（内容过长，已截断，剩余 \d+ 字符未提供）/);
});

test('platformLabel: known aliases, normalization and unknown values', () => {
  assert.equal(platformLabel('GitHub'), 'GitHub');
  assert.equal(platformLabel(' gItLaB '), 'GitLab');
  assert.equal(platformLabel('gitea'), 'Gitea/Forgejo');
  assert.equal(platformLabel('forgejo'), 'Gitea/Forgejo');
  assert.equal(platformLabel(''), '未知平台');
  assert.equal(platformLabel('   '), '未知平台');
  assert.equal(platformLabel(123), '未知平台');
  assert.equal(platformLabel({}), '未知平台');
  assert.equal(platformLabel(null), '未知平台');
  assert.equal(platformLabel('bitbucket'), '未知平台（bitbucket）');
  assert.equal(platformLabel('bad\nvalue'), '未知平台（badvalue）');
  assert.equal(platformLabel('x'.repeat(60)), `未知平台（${'x'.repeat(40)}）`);
});

test('prompts: name the real platform and keep unknown values neutral', () => {
  const base = {
    repo: 'group/project', number: 1, title: 't', author: 'a',
    headRef: 'h', baseRef: 'b', changedFiles: 0, additions: 0, deletions: 0, body: '',
  };
  for (const [platform, label] of Object.entries(PLATFORM_LABELS)) {
    const prompt = buildReportPrompt({ ...base, platform }, [], new Map(), { maxDiffCharsPerFile: 14000 });
    assert.ok(prompt.messages[0].content[0].text.includes(`平台：${label}；`), platform);
  }

  const mixed = buildReportPrompt({ ...base, platform: ' GitHub ' }, [], new Map(), { maxDiffCharsPerFile: 14000 });
  assert.ok(mixed.messages[0].content[0].text.includes('平台：GitHub；'));

  for (const [platform, expected] of [
    ['bitbucket', '未知平台（bitbucket）'],
    ['', '未知平台'],
    ['   ', '未知平台'],
    [undefined, '未知平台'],
    [null, '未知平台'],
    [123, '未知平台'],
    [{}, '未知平台'],
  ]) {
    const prompt = buildReportPrompt({ ...base, platform }, [], new Map(), { maxDiffCharsPerFile: 14000 });
    const text = prompt.messages[0].content[0].text;
    assert.ok(!text.includes('平台：Gitea/Forgejo；'), String(platform));
    assert.ok(text.includes(`平台：${expected}；`), String(platform));
  }

  const explain = buildExplainPrompt(
    { ...base, platform: 'gitlab' },
    { path: 'a.js', status: 'modified', additions: 1, deletions: 1 },
    '', null, '', '',
  );
  assert.ok(explain.messages[0].content[0].text.includes('平台：GitLab；'));
});

test('prompts: one stack-agnostic review framework, language follows the comment setting', () => {
  const pull = {
    repo: 'group/project', number: 1, title: 't', author: 'a',
    headRef: 'h', baseRef: 'b', changedFiles: 1, additions: 1, deletions: 0, body: '',
  };
  const files = [{ path: 'a.js', status: 'modified', additions: 1, deletions: 0 }];
  const zh = buildReportPrompt(pull, files, new Map(), { maxDiffCharsPerFile: 14000, commentLanguage: 'zh' });
  const system = zh.system;

  // The project shape is inferred from the PR, not hard-coded to one tech stack.
  assert.doesNotMatch(system, /Electron \+ React \+ TypeScript/);
  for (const axis of ['正确性', '可读性', '架构与一致性', '安全', '性能', '跨平台']) {
    assert.match(system, new RegExp(axis));
  }
  assert.match(system, /证据要求/);
  assert.match(system, /化简审查/);
  assert.match(system, /使用简体中文/);

  const en = buildReportPrompt(pull, files, new Map(), { maxDiffCharsPerFile: 14000, commentLanguage: 'en' });
  assert.match(en.system, /Write every human-readable field in English/);
  assert.doesNotMatch(en.system, /使用简体中文/);
});

test('explain prompt: test gaps, adaptive length and the issue shape', () => {
  const prompt = buildExplainPrompt(
    {
      repo: 'group/project', number: 1, title: 't', author: 'a',
      headRef: 'h', baseRef: 'b', changedFiles: 1, additions: 1, deletions: 0, body: '',
    },
    { path: 'a.js', status: 'modified', additions: 1, deletions: 0 },
    '', null, '', '', { language: 'zh' },
  );
  const text = prompt.messages[0].content[0].text;
  assert.match(text, /同时看测试/);
  assert.match(text, /篇幅随改动规模自适应/);
  assert.match(text, /问题 \+ 影响 \+ 修法/);
});

test('prompt language normalizes case and region tags and falls back to Chinese', () => {
  const pull = {
    repo: 'group/project', number: 1, title: 't', author: 'a',
    headRef: 'h', baseRef: 'b', changedFiles: 1, additions: 1, deletions: 0, body: '',
  };
  const file = { path: 'a.js', status: 'modified', additions: 1, deletions: 0 };
  const reportSystem = (commentLanguage) => buildReportPrompt(
    pull, [file], new Map(), { maxDiffCharsPerFile: 1000, commentLanguage },
  ).system;

  for (const value of ['en', 'EN', 'en-US', 'en_us', ' en ']) {
    assert.match(reportSystem(value), /Write every human-readable field in English/, String(value));
  }
  for (const value of ['zh', 'fr', '', '  ', undefined, null, 42]) {
    assert.doesNotMatch(reportSystem(value), /Write every human-readable field in English/, String(value));
    assert.match(reportSystem(value), /使用简体中文/, String(value));
  }

  // The builder-options path normalizes exactly the same way.
  assert.match(buildExplainPrompt(pull, file, '', null, '', '', { language: 'EN-us' }).system, /in English/);
  assert.doesNotMatch(buildExplainPrompt(pull, file, '', null, '', '').system, /in English/);
});

test('the report prompt keeps the output contract even though its wording changed', () => {
  const prompt = buildReportPrompt(
    {
      repo: 'group/project', number: 1, title: 't', author: 'a',
      headRef: 'h', baseRef: 'b', changedFiles: 0, additions: 0, deletions: 0, body: '',
    },
    [], new Map(), { maxDiffCharsPerFile: 1000 },
  );
  const text = prompt.messages[0].content[0].text;
  for (const field of ['"verdict"', '"summary"', '"concerns"', '"evidenceNeeds"', '"order"', '"focus"']) {
    assert.ok(text.includes(field), `missing ${field}`);
  }
  assert.match(text, /block \| suggest \| pass/);
  // The old "uncertain" escape hatch is gone: unverified points belong in their own field.
  assert.ok(!text.includes('（不确定：'));
  assert.ok(!prompt.system.includes('（不确定：'));
});

test('the feedback prompt uses the compact system, not the full framework', () => {
  const pull = { repo: 'group/project', number: 1, title: 't' };
  const compact = buildFeedbackPrompt(pull, [], [], { language: 'zh' }).system;
  assert.match(compact, /严重度/);
  assert.doesNotMatch(compact, /化简审查/);
  assert.doesNotMatch(compact, /六个维度/);
  assert.doesNotMatch(buildFeedbackPrompt(pull, [], [], { language: 'en' }).system, /使用简体中文/);
});

test('conclude prompt: names residual risks and follows the comment language', () => {
  const prompt = buildConcludePrompt(
    {
      repo: 'group/project', number: 1, title: 't', author: 'a',
      headRef: 'h', baseRef: 'b', changedFiles: 0, additions: 0, deletions: 0, body: '',
    },
    null,
    new Map(),
    null,
    { language: 'en' },
  );
  const text = prompt.messages[0].content[0].text;
  assert.match(text, /未发现阻塞项/);
  assert.match(text, /只写要执行的动作与要补的测试/);
  assert.match(prompt.system, /Write every human-readable field in English/);

  // The Chinese default carries the same contract, just in the other language.
  const zh = buildConcludePrompt(
    {
      repo: 'group/project', number: 1, title: 't', author: 'a',
      headRef: 'h', baseRef: 'b', changedFiles: 0, additions: 0, deletions: 0, body: '',
    },
    null,
    new Map(),
    null,
  );
  assert.match(zh.messages[0].content[0].text, /未发现阻塞项/);
  assert.match(zh.messages[0].content[0].text, /问题 \+ 影响 \+ 修法/);
  assert.match(zh.system, /使用简体中文/);
});

test('parseFeedbackReply: regression', () => {
  const parsed = parseFeedbackReply(JSON.stringify({
    items: [
      { index: 1, status: 'fixed-claimed', reason: '已改' },
      { index: 2, status: 'nonsense', reason: '' },
      { index: 0, status: 'accepted' },
    ],
    notes: ['补充说明'],
  }));
  assert.deepEqual(parsed.states, [
    { index: 1, status: 'fixed-claimed', reason: '已改' },
    { index: 2, status: 'question', reason: '' },
  ]);
  assert.deepEqual(parsed.notes, ['补充说明']);
  // Unparseable replies keep the raw text and no states.
  const fallback = parseFeedbackReply('not json');
  assert.deepEqual(fallback.states, []);
  assert.equal(fallback.raw, 'not json');
});

test('extractJson: fenced and prose-wrapped replies', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('前言 {"a":2} 后记'), { a: 2 });
  assert.equal(extractJson('nothing'), null);
});

test('callModel: honours request.signal by throwing a 已取消 error', async () => {
  const controller = new AbortController();
  const ctx = {
    llm: {
      stream: (options) => (async function* () {
        await new Promise((resolve, reject) => {
          if (options.signal.aborted) {
            reject(new Error('This operation was aborted'));
            return;
          }
          options.signal.addEventListener('abort', () => reject(new Error('This operation was aborted')), { once: true });
        });
        yield { type: 'text-delta', text: 'late' };
      })(),
    },
  };
  const promise = callModel(ctx, { provider: 'p', model: 'm' }, {
    messages: [{ role: 'user', content: 'x' }],
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(promise, /已取消/);
});

test('callModel: assembles text and returns it on the normal path', async () => {
  const ctx = {
    llm: {
      stream: () => (async function* () {
        yield { type: 'text-delta', text: 'hel' };
        yield { type: 'text-delta', text: 'lo' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })(),
    },
  };
  const text = await callModel(ctx, { provider: 'p', model: 'm' }, { messages: [] });
  assert.equal(text, 'hello');
});

test('index.js re-exports buildCommentMarkdown from llm.js', async () => {
  const index = await import('../index.js');
  const conclusion = { verdict: 'pass', summary: 'ok', blockers: [], suggestions: [], nextSteps: [] };
  const expected = buildCommentMarkdown(conclusion, { number: 1, title: 't' }, 1, { language: 'zh' });
  const actual = index.buildCommentMarkdown(conclusion, { number: 1, title: 't' }, 1, { language: 'zh' });
  // The timestamp differs between calls; compare the stable prefix.
  assert.equal(actual.split(' · ')[0], expected.split(' · ')[0]);
});

test('normalizeConcerns / normalizeEvidenceNeeds drop malformed entries', () => {
  assert.deepEqual(
    normalizeConcerns([{ point: '  p  ', severity: 'block', file: 'a.js' }, { point: '   ' }, null]),
    [{ severity: 'block', file: 'a.js', point: 'p', line: 0 }],
  );
  assert.deepEqual(
    normalizeEvidenceNeeds([
      { concern: 2, kind: 'callers', path: '  x.js  ' },
      { kind: 'not-a-kind' },
      { concern: 1, kind: 'definition', symbol: ' startReview ' },
    ]),
    [
      { concern: 2, kind: 'callers', path: 'x.js', symbol: '', reason: '' },
      { concern: 1, kind: 'definition', path: '', symbol: 'startReview', reason: '' },
    ],
  );
});

test('normalizeUnverified keeps only points with text', () => {
  assert.deepEqual(
    normalizeUnverified([{ point: ' a ', missing: ' m ' }, { point: '   ' }, null]),
    [{ point: 'a', missing: 'm' }],
  );
});

test('partitionVerdicts: 80 is a finding, 25-79 is unverified, below 25 is dropped', () => {
  const concerns = [
    { severity: 'block', file: 'a.js', point: 'A', line: 3 },
    { severity: 'suggest', file: 'b.js', point: 'B', line: 0 },
    { severity: 'suggest', file: 'c.js', point: 'C', line: 1 },
  ];
  const raw = {
    results: [
      { index: 1, confidence: 80, severity: 'block', point: 'A2', line: 5 },
      { index: 2, confidence: 79, point: 'B2', missing: '缺调用方' },
      { index: 3, confidence: 24, point: 'C2' },
    ],
    extraIssues: [{ severity: 'suggest', point: 'D', line: 9 }],
  };
  const { issues, unverified, dropped } = partitionVerdicts(raw, concerns);
  assert.deepEqual(issues.map((item) => item.point), ['A2', 'D']);
  // Missing fields fall back to the candidate the verifier was scoring.
  assert.equal(issues[0].file, 'a.js');
  assert.equal(issues[0].severity, 'block');
  assert.deepEqual(unverified, [{ point: 'B2', missing: '缺调用方' }]);
  assert.equal(dropped, 1, 'below-25 scores are dropped and counted');
});

test('partitionVerdicts dedupes confirmed points and tolerates junk', () => {
  const concerns = [{ severity: 'suggest', file: '', point: 'same', line: 0 }];
  const { issues, unverified } = partitionVerdicts({
    results: [{ index: 1, confidence: 90 }, { index: 9, confidence: 90, point: 'same' }],
    extraIssues: [{ point: 'same' }, null, { point: '   ' }],
  }, concerns);
  assert.deepEqual(issues.map((item) => item.point), ['same']);
  assert.deepEqual(unverified, []);
});

test('normalizeReport and normalizeExplanation keep unverified notes', () => {
  const report = normalizeReport({
    verdict: 'suggest',
    summary: 's',
    risks: [],
    unverified: [{ point: 'x', missing: 'y' }],
    raised: 3,
    discarded: 2,
  }, []);
  assert.deepEqual(report.unverified, [{ point: 'x', missing: 'y' }]);
  assert.equal(report.raised, 3);
  assert.equal(report.discarded, 2);
  const explanation = normalizeExplanation({ issues: [], unverified: [{ point: 'z', missing: '' }] });
  assert.deepEqual(explanation.unverified, [{ point: 'z', missing: '' }]);
});

test('the verifier prompt carries candidates and evidence, not a second review', () => {
  const prompt = buildExplainVerifyPrompt(
    { repo: 'group/project', number: 1, title: 't', platform: 'github' },
    { path: 'a.js', status: 'changed', additions: 1, deletions: 2 },
    [{ severity: 'block', file: 'a.js', point: 'A', line: 3 }],
    '## 证据 1：x.js（callers）\n\n```\nstartReview()\n```',
    ['callers y.js：无法读取'],
    { language: 'zh' },
  );
  const text = prompt.messages[0].content[0].text;
  assert.match(prompt.system, /裁判/);
  assert.match(text, /## 候选问题（index 从 1 开始）/);
  assert.match(text, /1\. \[block\] \[a\.js:3\] A/);
  assert.match(text, /## 证据 1/);
  assert.match(text, /无法读取/);
  assert.doesNotMatch(text, /walkthrough/);
  assert.doesNotMatch(prompt.system, /六个维度/);
  assert.match(buildReportVerifyPrompt({ repo: 'r', number: 2, title: 't' }, [], '', [], { language: 'en' }).system, /English/);
});

test('the review framework states the exclusion list and the call-chain rule', () => {
  const system = buildReportPrompt(
    { repo: 'r', number: 1, title: 't', body: '', author: '', headRef: 'h', baseRef: 'b', changedFiles: 0, additions: 0, deletions: 0 },
    [], new Map(), {},
  ).system;
  assert.match(system, /误报排除/);
  assert.match(system, /本次未修改行/);
  assert.match(system, /调用链/);
  assert.match(system, /evidenceNeeds/);
});

test('a self-reported doubt is never a finding, whatever the score', () => {
  const { issues, unverified, dropped } = partitionVerdicts({
    results: [
      { index: 1, confidence: 95, point: '无法确认该调用方是否兼容' },
      { index: 2, confidence: 95, point: '缺测试' },
    ],
    extraIssues: [
      { confidence: 95, point: '证据不足，无法判断' },
      { confidence: 10, point: '低置信' },
      { point: '缺 confidence 但引用证据' },
    ],
  }, [
    { severity: 'suggest', file: 'a.js', point: 'A', line: 0 },
    { severity: 'suggest', file: 'b.js', point: 'B', line: 0 },
  ]);
  assert.deepEqual(issues.map((item) => item.point), ['缺测试', '缺 confidence 但引用证据']);
  assert.deepEqual(unverified.map((item) => item.point), ['无法确认该调用方是否兼容', '证据不足，无法判断']);
  assert.equal(dropped, 1);
});

test('normalizeEvidenceNeeds accepts every documented kind', () => {
  for (const kind of ['callers', 'definition', 'callee', 'schema', 'test', 'file']) {
    const [need] = normalizeEvidenceNeeds([{ kind, path: 'a.js' }]);
    assert.equal(need.kind, kind);
  }
});

test('partitionSuggestions drops only explicitly rejected suggestions', () => {
  const { kept, dropped } = partitionSuggestions({
    suggestionResults: [{ index: 1, keep: false }, { index: 3, keep: true }, null],
  }, ['已实现', '未表态', '保留']);
  assert.deepEqual(kept, ['未表态', '保留']);
  assert.equal(dropped, 1);
});

test('the verifier prompt carries suggestions and the diff when given', () => {
  const prompt = buildExplainVerifyPrompt(
    { repo: 'r', number: 1, title: 't' },
    { path: 'README.md', status: 'modified', additions: 2, deletions: 0 },
    [],
    '',
    [],
    {
      language: 'zh',
      suggestions: ['补齐三行配置'],
      diffText: '+evidenceVerify: true\n+evidenceMaxFiles: 6',
    },
  );
  const text = prompt.messages[0].content[0].text;
  assert.match(text, /## 候选改进建议/);
  assert.match(text, /1\. 补齐三行配置/);
  assert.match(text, /## 该文件的 diff/);
  assert.match(text, /"suggestionResults"/);
});

test('a candidate the verifier did not answer becomes an unverified note', () => {
  const { issues, unverified } = partitionVerdicts({
    results: [{ index: 1, confidence: 90, point: 'A2' }],
  }, [
    { severity: 'suggest', file: 'a.js', point: 'A', line: 0 },
    { severity: 'suggest', file: 'b.js', point: 'B', line: 0 },
  ]);
  assert.deepEqual(issues.map((item) => item.point), ['A2']);
  assert.deepEqual(unverified, [{ point: 'B', missing: '复审未返回该候选的判定' }]);
});

test('a zero-based results array is shifted instead of misattributed', () => {
  const { issues } = partitionVerdicts({
    results: [{ index: 0, confidence: 90, point: 'A2' }],
  }, [{ severity: 'block', file: 'a.js', point: 'A', line: 0 }]);
  assert.equal(issues[0].file, 'a.js');
  assert.equal(issues[0].severity, 'block');
});

test('an out-of-range result is dropped, not published', () => {
  const { issues, dropped } = partitionVerdicts({
    results: [
      { index: 9, confidence: 95, point: '越界问题' },
      { index: 1, confidence: 95, point: '正常问题' },
    ],
  }, [{ severity: 'suggest', file: 'a.js', point: 'A', line: 0 }]);
  assert.deepEqual(issues.map((item) => item.point), ['正常问题']);
  assert.equal(dropped, 1);
});

test('English self-doubt is treated like Chinese', () => {
  const { unverified, issues } = partitionVerdicts({
    results: [{ index: 1, confidence: 95, point: 'Could not verify the caller contract' }],
  }, [{ severity: 'suggest', file: 'a.js', point: 'A', line: 0 }]);
  assert.deepEqual(issues, []);
  assert.equal(unverified.length, 1);
});

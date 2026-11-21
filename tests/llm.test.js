/**
 * Unit tests for the conclusion-history contract (§5) in llm.js.
 *
 * Run with: node --test tests/
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PLATFORM_LABELS,
  buildChatPrompt,
  buildCommentAppendix,
  buildCommentMarkdown,
  buildConcludePrompt,
  buildExplainOpening,
  buildExplainPrompt,
  buildFeedbackPrompt,
  buildInvestigationStepPrompt,
  buildRefuteStepPrompt,
  buildRefuterSystem,
  buildReportOpening,
  buildReportPrompt,
  calibrateVerdict,
  callModel,
  commentItems,
  compareComments,
  conclusionCoverage,
  extractJson,
  findingsOf,
  itemId,
  mergeConclusion,
  normalizeConclusion,
  normalizeExplanation,
  normalizeFindingOps,
  normalizePreviousVerdicts,
  normalizeRefuted,
  normalizeReport,
  normalizeVerdict,
  parseChatReply,
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
  assert.equal(calibrateVerdict({ ...base, suggestions: [{ id: 's-1', file: '', point: 'x', severity: 'block' }] }).verdict, 'block');
  // 逐文件 block 信号不再强制结论 verdict：结论模型复核后有权否定（PR #32 第 7 轮事故——
  // 逐文件标阻塞、结论复核「均不成立」、校准却把 verdict 抬成「阻塞」配空 blockers）。
  assert.equal(calibrateVerdict(base, { fileSeverities: [{ file: 'a.js', severity: 'block' }] }).verdict, 'pass');
  assert.equal(
    calibrateVerdict({ ...base, verdict: 'suggest', summary: '两条阻塞项经复核均不成立' }, {
      fileSeverities: [{ file: 'a.js', severity: 'block' }],
    }).verdict,
    'suggest',
  );
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
      files: [{ file: 'src/a.js', findings: [{ severity: 'block', point: '细节', suggestion: '补注释', line: 5 }] }],
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
  // The suggestion rides its issue as an indented sub-line, not a sibling bullet.
  assert.match(markdown, /- \[阻塞\] 细节（行 5）\n {2}- 建议：补注释/);
  assert.match(markdown, /#### 审查顺序/);
  assert.match(markdown, /1\. `src\/a\.js` — 入口/);
  // 复审对比已从发布附录移除（H1：对比只属于审核工作面）。
  assert.ok(!markdown.includes('#### 复审对比'));
  assert.ok(!markdown.includes('已修复：`src/a.js`'));
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
    findings: Array.from({ length: 20 }, (_, issue) => ({
      severity: 'block',
      point: '详细问题描述'.repeat(10),
      suggestion: '建议内容'.repeat(10),
      line: issue + 1,
    })),
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

test('buildCommentAppendix: findings render as one list with nested suggestion sub-lines', () => {
  const appendix = {
    risks: [],
    files: [{
      file: 'src/a.js',
      findings: [
        { severity: 'block', point: '会崩', suggestion: '加判空', line: 3 },
        { severity: 'suggest', point: '无建议的意见', suggestion: '', line: 9 },
      ],
    }],
    order: [],
    delta: null,
    unanalyzed: [],
  };
  // zh: the suggestion rides its finding as an indented sub-line; findings without one get none.
  const zh = buildCommentAppendix(appendix, 'zh');
  assert.match(zh, /\*\*src\/a\.js\*\*\n- \[阻塞\] 会崩（行 3）\n {2}- 建议：加判空\n- \[提示\] 无建议的意见（行 9）/);
  // A finding with no suggestion must not grow an empty sub-line (advice !== '' guard).
  assert.doesNotMatch(zh, /\[提示\] 无建议的意见（行 9）\n {2}- /);
  // en: half-width colon after the suggestion label.
  const en = buildCommentAppendix(appendix, 'en');
  assert.match(en, /- \[Block\] 会崩（line 3）\n {2}- Suggestion: 加判空/);
  assert.doesNotMatch(en, /Suggestion：/);
});

test('buildConcludePrompt: coverage, unanalyzed (<=20), previous ids, locked ids, feedback, chat, schema id', () => {
  const unanalyzed = Array.from({ length: 25 }, (_, index) => `file-${index + 1}.js`);
  const explanations = new Map([
    ['a.js', { verdict: 'suggest', summary: 's', issues: [{ severity: 'block', point: 'p', suggestion: '加判空', line: 3 }] }],
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
  // The entries JSON carries each issue's inline suggestion and never the legacy list key.
  // Scoped to the entries line because the output schema legitimately still says "suggestions".
  const entriesJson = text.match(/已逐文件分析（\d+ 个）：([^\n]*)/)?.[1] ?? '';
  assert.doesNotMatch(entriesJson, /"suggestions"/);
  assert.match(entriesJson, /"suggestion":"加判空"/);
});

test('buildConcludePrompt renders a partial pull without throwing', () => {
  const prompt = buildConcludePrompt(
    { platform: 'github', repo: 'o/r', number: 7, title: 't' },
    null,
    new Map(),
    null,
  );
  const text = prompt.messages[0].content[0].text;
  assert.match(text, /PR #7：t/);
  assert.match(text, /规模：0 个文件，\+0 \/ -0/);
});

test('buildConcludePrompt: marks truncated report/explanations explicitly', () => {
  const explanations = new Map([
    ['a.js', { verdict: 'suggest', summary: 'y'.repeat(20000), issues: [] }],
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
  const opening = buildExplainOpening(
    {
      repo: 'group/project', number: 1, title: 't', author: 'a',
      headRef: 'h', baseRef: 'b', changedFiles: 1, additions: 1, deletions: 0, body: '',
    },
    { path: 'a.js', status: 'modified', additions: 1, deletions: 0 },
    '', null, '', '', { language: 'zh' },
  );
  // The opening carries the per-file guidance; the step prompt adds the shared protocol.
  const step = buildInvestigationStepPrompt({
    opening: opening.text,
    system: opening.system,
    claims: [],
    trace: [],
    step: 1,
    budgetLine: '',
    instruction: '',
  });
  const text = step.messages[0].content[0].text;
  assert.match(text, /同时看测试/);
  assert.match(text, /篇幅随改动规模自适应/);
  assert.match(text, /问题 \+ 影响（一条只写一个核心问题）/);
  // 一条意见自带建议；不再有独立的 suggestions 输出。
  assert.ok(!text.includes('"suggestions"'));
  assert.ok(text.includes('"suggestion"'));
  assert.ok(text.includes('不要把修法混进 point'));
  assert.ok(text.includes('纯改进点'));
  // Verdict 三值语义显式定义（改善模型自洽），纯改进点带 nit 措辞引导。
  assert.match(text, /verdict 语义：block=存在应先修复的缺陷/);
  assert.match(text, /pass=可按原样合并/);
  assert.match(text, /「可选：」或「nit：」/);
  // 无基准快照：不含逐条判定段，也不要求 previousVerdicts。
  assert.ok(!text.includes('基准轮审查意见'));
  assert.ok(!text.includes('"previousVerdicts"'));
});

test('explain prompt carries the baseline findings for per-item verdicts', () => {
  const prompt = buildExplainPrompt(
    {
      repo: 'group/project', number: 1, title: 't', author: 'a',
      headRef: 'h', baseRef: 'b', changedFiles: 1, additions: 1, deletions: 0, body: '',
    },
    { path: 'a.js', status: 'modified', additions: 1, deletions: 0 },
    '', null, '', '',
    {
      language: 'zh',
      baselineFindings: [
        { index: 1, file: 'a.js', severity: 'block', point: '空指针风险', line: 2, suggestion: '先判空' },
        { index: 2, file: 'b.js', severity: 'suggest', point: '补测试', line: 0, suggestion: '' },
      ],
    },
  );
  const text = prompt.messages[0].content[0].text;
  assert.match(text, /基准轮审查意见（本轮必须逐条判定修复状态）/);
  assert.match(text, /1\. \[block\] a\.js 空指针风险（行 2） —— 建议：先判空/);
  assert.match(text, /2\. \[suggest\] b\.js 补测试/);
  assert.match(text, /previousVerdicts 必须恰好包含 2 条判定/);
  // still-open 由宿主延续，新发现照常调查；不再要求携带 roundItem 引用。
  assert.match(text, /在 previousVerdicts 输出 "status": "still-open"/);
  assert.match(text, /宿主会据此延续/);
  assert.match(text, /不带 roundItem/);
  // 基准轮字段约定来自 previous-verdicts 片段。
  assert.match(text, /按上面每条基准轮意见的序号逐条给出/);
});

test('normalizePreviousVerdicts keeps one valid verdict per baseline index', () => {
  const verdicts = normalizePreviousVerdicts([
    { index: 1, status: 'fixed' },
    { index: 1, status: 'still-open', point: '重复认领被丢弃' },
    { index: 0, status: 'fixed' },
    { index: 9, status: 'fixed' },
    { index: 2, status: 'nonsense' },
    { index: 3 },
    { index: 2, status: 'still-open', point: ' 补测试 ', line: 7, severity: 'block', suggestion: '补集成测试' },
    'junk',
  ], 3);
  assert.deepEqual(verdicts, [
    { index: 1, status: 'fixed' },
    { index: 2, status: 'still-open', point: '补测试', line: 7, severity: 'block', suggestion: '补集成测试' },
  ]);
  assert.deepEqual(normalizePreviousVerdicts(undefined, 3), []);
  assert.deepEqual(normalizePreviousVerdicts([], 0), []);
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
  const pull = {
    repo: 'group/project', number: 1, title: 't', author: 'a',
    headRef: 'h', baseRef: 'b', changedFiles: 1, additions: 3, deletions: 1, body: '',
  };
  const files = [{ path: 'src/a.js', status: 'modified', additions: 3, deletions: 1 }];
  const diffFiles = new Map([['src/a.js', {
    path: 'src/a.js', additions: 3, deletions: 1, binary: false, hunkCount: 1,
    text: 'diff --git a/src/a.js b/src/a.js\n@@ -1 +1,4 @@\n+const a = 1;',
  }]]);
  const opening = buildReportOpening(pull, files, diffFiles, { maxDiffCharsPerFile: 1000 });
  // The opening carries the file list and the per-file diff excerpts.
  assert.match(opening.text, /- src\/a\.js \| modified \| \+3 \/ -1/);
  assert.match(opening.text, /const a = 1;/);
  // The shared protocol keeps the final-report contract.
  const step = buildInvestigationStepPrompt({
    opening: opening.text,
    system: opening.system,
    claims: [],
    trace: [],
    step: 1,
    budgetLine: '',
    instruction: '',
  });
  const text = step.messages[0].content[0].text;
  for (const field of ['"summary"', '"risks"', '"order"', '"focus"']) {
    assert.ok(text.includes(field), `missing ${field}`);
  }
  assert.match(text, /block \| suggest \| pass/);
  // The old "uncertain" escape hatch is gone.
  assert.ok(!text.includes('（不确定：'));
  assert.ok(!opening.system.includes('（不确定：'));
});

test('the feedback prompt uses the compact system, not the full framework', () => {
  const pull = { repo: 'group/project', number: 1, title: 't' };
  const compact = buildFeedbackPrompt(pull, [], [], { language: 'zh' }).system;
  assert.match(compact, /严重度/);
  assert.doesNotMatch(compact, /化简审查/);
  assert.doesNotMatch(compact, /六个维度/);
  assert.doesNotMatch(buildFeedbackPrompt(pull, [], [], { language: 'en' }).system, /使用简体中文/);
  assert.match(buildFeedbackPrompt(pull, [], [], { language: 'en' }).system, /quoted text verbatim/);
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

test('normalizeReport and normalizeExplanation expose only refuted audit entries', () => {
  const report = normalizeReport({
    verdict: 'suggest', summary: 's',
    refuted: [{ point: ' x ', reason: ' y ' }, { point: '' }, null],
    unverified: [{ point: '旧字段', missing: '旧证据' }],
    raised: 3, discarded: 1,
  }, []);
  assert.deepEqual(report.refuted, [{ point: 'x', reason: 'y' }]);
  assert.equal('unverified' in report, false);
  assert.equal('raised' in report, false);
  assert.equal('discarded' in report, false);
  const explanation = normalizeExplanation({
    issues: [], refuted: [{ point: 'z', reason: '' }],
    unverified: [{ point: '旧字段', missing: '' }],
  });
  assert.deepEqual(explanation.refuted, [{ point: 'z', reason: '' }]);
  assert.equal('unverified' in explanation, false);
});

test('the conclusion prompt omits the internal refuted audit', () => {
  const prompt = buildConcludePrompt(
    { platform: 'github', repo: 'acme/demo', number: 1, title: 't', headRef: 'f', baseRef: 'm' },
    { verdict: 'suggest', summary: 's', risks: [{ severity: 'block', file: 'a.js', point: '风险' }],
      refuted: [{ point: '审计项', reason: '已证伪' }], order: [], focus: {} },
    new Map(), null,
    { coverage: null, previousItems: [], humanItemIds: [], feedback: null, pullChat: [], language: 'zh' },
  );
  const text = prompt.messages[0].content[0].text;
  assert.ok(text.includes('风险'));
  assert.ok(text.includes('"verdict":"suggest"'));
  assert.ok(text.includes('"summary":"s"'));
  assert.ok(!text.includes('审计项'));
});

test('normalizeRefuted caps each reason at 300 chars and the list at 20 entries', () => {
  const items = Array.from({ length: 25 }, (_, index) => ({
    point: `p${index + 1}`,
    reason: 'r'.repeat(400),
  }));
  const refuted = normalizeRefuted(items);
  assert.equal(refuted.length, 20);
  assert.equal(refuted[0].reason.length, 300);
  assert.deepEqual(refuted.map((item) => item.point), items.slice(0, 20).map((item) => item.point));
});

test('the review framework states the exclusion list and the call-chain rule', () => {
  const system = buildReportPrompt(
    { repo: 'r', number: 1, title: 't', body: '', author: '', headRef: 'h', baseRef: 'b', changedFiles: 0, additions: 0, deletions: 0 },
    [], new Map(), {},
  ).system;
  assert.match(system, /误报排除/);
  assert.match(system, /本次未修改行/);
  assert.match(system, /调用链/);
  assert.match(system, /queries/);
});

test('normalizeExplanation merges legacy suggestions into suggest findings and drops the field', () => {
  const explanation = normalizeExplanation({
    verdict: 'suggest',
    summary: 's',
    issues: [{ severity: 'block', point: ' 空指针风险 ', suggestion: ' 补空判断 ', line: 12 }, { severity: 'nope', point: '', line: -3 }],
    // legacy shape 1: plain strings
    suggestions: ['补齐单测', '   '],
    // legacy shape 2: { point|text, line } objects
  });
  assert.deepEqual(explanation.issues, [
    { severity: 'block', point: '空指针风险', suggestion: '补空判断', line: 12 },
    { severity: 'suggest', point: '补齐单测', suggestion: '', line: 0 },
  ]);
  assert.equal(explanation.suggestions, undefined);
});

test('normalizeExplanation folds legacy suggestion objects with point/text and line', () => {
  const explanation = normalizeExplanation({
    issues: [],
    suggestions: [{ point: '抽公共 helper', line: 8 }, { text: '补集成测试', line: 0 }, { line: 3 }, null, '字符串建议'],
  });
  assert.deepEqual(explanation.issues, [
    { severity: 'suggest', point: '抽公共 helper', suggestion: '', line: 8 },
    { severity: 'suggest', point: '补集成测试', suggestion: '', line: 0 },
    { severity: 'suggest', point: '字符串建议', suggestion: '', line: 0 },
  ]);
});

test('findingsOf normalizes issues and folds legacy suggestions for unmigrated records', () => {
  assert.deepEqual(findingsOf({
    issues: [{ severity: 'block', point: 'p', line: 3 }],
    suggestions: [{ text: '旧建议', line: 5 }],
  }), [
    { severity: 'block', point: 'p', suggestion: '', line: 3 },
    { severity: 'suggest', point: '旧建议', suggestion: '', line: 5 },
  ]);
  assert.deepEqual(findingsOf(null), []);
  assert.deepEqual(findingsOf(undefined), []);
  assert.deepEqual(findingsOf({ issues: 'nope' }), []);
});

test('buildChatPrompt file scope lists findings and asks for findingOps', () => {
  const prompt = buildChatPrompt(
    { platform: 'github', repo: 'o/r', number: 1, title: 't' },
    { path: 'a.js', status: 'modified', additions: 1, deletions: 0 },
    { verdict: 'suggest', summary: 's', issues: [{ severity: 'block', point: '会崩', suggestion: '加判空', line: 3 }] },
    null,
    [],
    '第二条不对',
    null,
    {},
  );
  const text = prompt.messages[0].content[0].text;
  assert.match(text, /该文件当前的审查意见/);
  assert.ok(!text.includes('改进建议'));
  assert.match(text, /\[block\] 会崩/);
  assert.match(text, /—— 建议：加判空/);
  assert.ok(text.includes('"findingOps"'));
  assert.ok(!text.includes('"suggestionOps"'));
});

test('buildChatPrompt keeps the walkthrough and omits the refuted audit', () => {
  const prompt = buildChatPrompt(
    { platform: 'github', repo: 'o/r', number: 1, title: 't' },
    null,
    {
      verdict: 'suggest',
      summary: 's',
      logic: 'l',
      walkthrough: [{ title: '入口', detail: '先读缓存', hunk: 1, context: null }],
      changes: 'c',
      issues: [],
      refuted: [{ point: '审计项', reason: '已证伪' }],
    },
    null,
    [],
    'q',
    null,
    {},
  );
  const text = prompt.messages[0].content[0].text;
  assert.ok(text.includes('已有文件分析'));
  assert.ok(text.includes('入口'), 'the structured walkthrough survives in the chat context');
  assert.ok(!text.includes('审计项'), 'the internal refuted audit never reaches the chat prompt');
});

test('normalizeFindingOps maps legacy text to point and accepts field-scoped updates', () => {
  const ops = normalizeFindingOps([
    { op: 'remove', index: 2 },
    { op: 'update', index: 1, text: '旧字段写法' },
    { op: 'update', index: 3, suggestion: '只改修法', severity: 'suggest', line: 9 },
    { op: 'update', index: 4 },
    { op: 'add', point: '新意见', suggestion: '修法', severity: 'block', line: 5 },
    { op: 'add', text: '旧字段新增' },
    { op: 'add' },
  ]);
  assert.deepEqual(ops, [
    { op: 'remove', index: 2 },
    { op: 'update', index: 1, point: '旧字段写法' },
    { op: 'update', index: 3, suggestion: '只改修法', line: 9, severity: 'suggest' },
    { op: 'add', point: '新意见', suggestion: '修法', line: 5, severity: 'block' },
    { op: 'add', point: '旧字段新增' },
  ]);
});

test('parseChatReply reads findingOps with a suggestionOps fallback', () => {
  assert.deepEqual(parseChatReply(JSON.stringify({ answer: 'a', findingOps: [{ op: 'remove', index: 1 }] })).ops,
    [{ op: 'remove', index: 1 }]);
  assert.deepEqual(parseChatReply(JSON.stringify({ answer: 'a', suggestionOps: [{ op: 'add', text: 'x' }] })).ops,
    [{ op: 'add', point: 'x' }]);
});

test('normalizeFindingOps trims padded fields and folds invalid severity and line', () => {
  // The trim here is load-bearing: applyFindingOps writes fields through without trimming.
  assert.deepEqual(normalizeFindingOps([
    { op: 'update', index: 1, point: '  改写后的意见  ', suggestion: '  修法  ', severity: 'warn', line: -3 },
    { op: 'add', point: '  新意见  ', severity: 'warn', line: -3 },
  ]), [
    { op: 'update', index: 1, point: '改写后的意见', suggestion: '修法' },
    { op: 'add', point: '新意见' },
  ]);
});


test('explain prompt truncates the baseline per file and declares the truncation', () => {
  const baselineFindings = Array.from({ length: 13 }, (_, index) => ({
    index: index + 1,
    file: 'a.js',
    severity: 'suggest',
    point: `问题 ${index + 1}`,
    line: index + 1,
    suggestion: '',
  }));
  const prompt = buildExplainPrompt(
    { platform: 'github', repo: 'o/r', number: 1, title: 't' },
    { path: 'a.js', status: 'modified', additions: 1, deletions: 0 },
    '', null, '', '',
    { language: 'zh', baselineFindings },
  );
  const text = prompt.messages[0].content[0].text;
  // 只列前 10 条（block 优先/行号升序）：第 11-13 条不下发。
  assert.ok(text.includes('10. [suggest] a.js 问题 10（行 10）'));
  assert.ok(!text.includes('11. [suggest] a.js 问题 11'));
  // 显式声明截断，并要求判定数等于下发数。
  assert.match(text, /上一轮意见已截断：另有 3 条未列出/);
  assert.match(text, /previousVerdicts 必须恰好包含 10 条判定/);
});

test('the investigation step prompt carries the opening, claims and protocol', () => {
  const prompt = buildInvestigationStepPrompt({
    opening: '## 开篇资料\n\ndiff 在这里',
    system: '你是审查员',
    claims: [{ id: 'C1', statement: '空指针', status: 'investigating', reason: '', evidence: [] }],
    trace: [{
      step: 1,
      claims: [],
      queries: [{ op: 'read', path: 'src/a.js', symbol: '', pattern: '', pathGlob: '', scope: 'repo', limit: 20, startLine: 0, endLine: 0 }],
      results: [{ id: 'E1', block: '## E1 · read\n\nconst a = 1;' }],
      rejected: [],
    }],
    step: 2,
    budgetLine: '已用 1 条证据',
    instruction: '继续调查。',
  });
  const text = prompt.messages[0].content[0].text;
  assert.match(text, /## 开篇资料/);
  assert.match(text, /C1/);
  assert.match(text, /E1 · read/);
  assert.match(text, /"queries"/);
  assert.match(text, /"final"/);
  // The shared protocol carries the untrusted-evidence boundary and the claim limits.
  assert.match(text, /<<<EVIDENCE/);
  assert.match(text, /不可信数据/);
  assert.match(text, /每条 confirmed claim 必须产生恰好一条审查意见/);
  assert.match(text, /claims 总数为最多 12 条/);
  assert.equal(prompt.system, '你是审查员');
  assert.ok(prompt.maxTokens >= 8000);
});

test('the file opening keeps the diff, full file and baseline sections', () => {
  const pull = { platform: 'github', repo: 'acme/demo', number: 1, title: 't', headRef: 'f', baseRef: 'm' };
  const file = { path: 'src/a.js', status: 'modified', additions: 1, deletions: 0 };
  const opening = buildExplainOpening(pull, file, 'diff text', null, '', 'const a = 1;\n', {
    language: 'zh',
    baselineFindings: [{ index: 1, file: 'src/a.js', severity: 'block', point: '旧问题', suggestion: '', line: 0 }],
  });
  assert.match(opening.text, /diff text/);
  assert.match(opening.text, /const a = 1;/);
  assert.match(opening.text, /旧问题/);
  assert.match(opening.text, /previousVerdicts/);
});

test('the refuter prompt lists findings and allows bounded queries', () => {
  const prompt = buildRefuteStepPrompt({
    opening: '开篇',
    system: '反驳者',
    findings: [{ severity: 'block', point: '空指针', claim: 'C1' }],
    trace: [],
    queriesLeft: 3,
    closure: false,
    evidence: '## E1 · read · src/a.js\n\n<<<EVIDENCE E1 START>>>\nconst a = 1;\n<<<EVIDENCE E1 END>>>',
  });
  const text = prompt.messages[0].content[0].text;
  assert.match(text, /C1/);
  assert.match(text, /3/);
  assert.match(text, /"results"/);
  assert.match(text, /## 引用的证据/);
  assert.match(text, /## E1 · read/);
  assert.match(buildRefuterSystem('zh'), /反驳/);
});

test('the refuter closure step forbids further queries', () => {
  const prompt = buildRefuteStepPrompt({
    opening: '开篇',
    system: '反驳者',
    findings: [{ severity: 'block', point: '空指针', claim: 'C1' }],
    trace: [],
    queriesLeft: 3,
    closure: true,
  });
  const text = prompt.messages[0].content[0].text;
  assert.match(text, /直接输出 results/);
  assert.ok(!text.includes('你可以先申请'));
});

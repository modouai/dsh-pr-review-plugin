/**
 * Unit tests for the conclusion-history contract (§5) in llm.js.
 *
 * Run with: node --test tests/
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCommentMarkdown,
  buildConcludePrompt,
  calibrateVerdict,
  callModel,
  commentItems,
  compareComments,
  conclusionCoverage,
  extractJson,
  itemId,
  mergeConclusion,
  normalizeConclusion,
  parseFeedbackReply,
  textSimilarity,
} from '../llm.js';

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

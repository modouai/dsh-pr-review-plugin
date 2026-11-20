# 逐文件分析合并「审查意见」与「改进建议」实现计划（issue #21）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把逐文件分析的 `issues` 与 `suggestions` 两组数据合并为一个列表：每条意见 `{ severity, point, suggestion?, line }` 自带建议；旧缓存读时兼容；prompt / 工具 / 面板 / 总览 / 发布附录 / 逐文件对话全链路收敛到单一意见列表。

**Architecture:** `llm.js` 的 `findingsOf(explanation)` 是唯一的规范化+合并出口（issues 归一 + 旧 `suggestions` 折叠为 suggest 级意见），`normalizeExplanation` 与所有后端读取点复用它；`restoreReviewRecord` 恢复缓存时对每个 explanation 跑 `normalizeExplanation`，使内存中的记录永远是合并后形状。复审管线把 suggestion 从 triage 透传到 verifier 再到最终 issues；独立的 suggestions 复审（`partitionSuggestions`/`suggestionResults`）删除——「diff 已实现」的纯建议现在作为 suggest 级 concern 被低分丢弃，语义等价。结论层（`conclusion.suggestions`）与发布筛选**不动**。

**Tech Stack:** 纯 JavaScript ESM（无框架依赖，客户端为 h() 渲染），`node --test`，`pnpm test` = `node scripts/stamp.js --check && node --test tests/*.test.js`。

**目标数据形状：**

```ts
issue = {
  severity: 'block' | 'suggest',
  point: string,        // 现状/问题 + 影响
  suggestion: string,   // 具体做法；无建议时为 ''（findingsOf 归一后键总存在，存库时随 normalizeExplanation 统一）
  line: number          // 0 = 无行号
}
```

`normalizeExplanation` 输出的 issues 每条固定四键 `{ severity, point, suggestion, line }`（`suggestion` 为 `''` 表示无建议），保持「最多一条建议」的语义且渲染端只判断 truthy。

---

## 现状数据流（已核实，行号基于当前 main）

1. **triage**：`buildExplainPrompt`（llm.js:283）输出 `concerns[]` + `evidenceNeeds[]` + `suggestions[]`（字符串数组）。
2. **规范化**：`normalizeConcerns`（llm.js:648）→ `{ severity, file, point, line }`；`rawSuggestions` 在 index.js:1724 过滤字符串。
3. **取证复审**：`verifyConcerns`（index.js:1270）→ `partitionVerdicts`（llm.js:709，产出 `issues[]{severity,point,line,file}` + `unverified`）；`partitionSuggestions`（llm.js:816，用 `suggestionResults[].keep` 过滤）。
4. **落库**：`explainFileUncached`（index.js:1681）→ `normalizeExplanation`（llm.js:897）→ `{ verdict, summary, logic, walkthrough, changes, issues[], unverified[], suggestions[] }`。
5. **恢复缓存**：`restoreReviewRecord`（index.js:892，第 899 行）**直接透传** `entry.explanation`，不跑 normalize —— 所以「读时兼容」必须在这里补 normalize。
6. **消费点**：`concludeInputsOf`（index.js:1958，只读 issues[].severity）、`buildConcludePrompt` entries（llm.js:562-568）、`commentAppendixOf`（index.js:2371）、`analysisText`（index.js:2759）、`overviewCounts`（index.js:2962）、`clearOverviewFindings`（index.js:2983）、逐文件对话 `chat()`（index.js:1906 → `applySuggestionOps` index.js:418）、工具（review_get 3055 / review_list_files 3071,3089 / review_get_analysis 3100 / review_update_analysis 3230 / review_update_overview 3525-3656 / 快照 2890 / 系统提示 3719）。
7. **客户端**：`fileFindings`（client.hooks.js:763）→ `findingsOf`+`FindingList`（client.views.js:162-242）→ 总览；`FileDetailPanel`（client.views.js:462-559，issues 区块 488-513 + suggestions 区块 515-533）；`ConclusionAppendix`（client.views.js:792-868）；i18n 键（client.i18n.js zh 86-87,104,176,179 / en 322-323,340,412,415）。
8. **客户端 applied 反馈**只读 `applied.length`（client.hooks.js:580-583），op 内部字段可自由调整。

## File Structure

| 文件 | 动作 | 职责 |
|---|---|---|
| `llm.js` | 修改 | `findingsOf` 新增、`normalizeExplanation` 合并、explain prompt / verifier prompt / chat prompt / conclude prompt / 附录渲染、`normalizeSuggestionOps`→`normalizeFindingOps`、删 `partitionSuggestions` |
| `index.js` | 修改 | 缓存恢复 normalize、分析管线透传 suggestion、读取点复用 `findingsOf`、`applyFindingOps`、工具 schema 与文案 |
| `client.hooks.js` | 修改 | `fileFindings` groups 改为 `{ file, findings }` |
| `client.views.js` | 修改 | `findingsOf`/`FindingList`/`FileDetailPanel`/`ConclusionAppendix` 单列表渲染 |
| `client.i18n.js` | 修改 | 删 `fileSuggestions`，改 `suggestionUpdated` 等 4 键 |
| `tests/llm.test.js` | 修改 | prompt/normalize/partition/附录用例 |
| `tests/index.test.js` | 修改 | 管线/工具/对话/清理用例 |
| `tests/client.test.js` | 修改 | 面板渲染用例 |

---

### Task 1: llm.js 数据层 —— `findingsOf` helper + `normalizeExplanation` 合并与旧数据兼容

**Files:**
- Modify: `llm.js:897-930`（normalizeExplanation）
- Modify: `llm.js:895` 附近（新增 findingsOf，放在 normalizeExplanation 上方）
- Test: `tests/llm.test.js`

- [ ] **Step 1: 写失败测试**（加到 `tests/llm.test.js` 末尾；import 块补 `findingsOf`）

```js
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
```

import 块（llm.test.js:10-39）按字母序补一行 `findingsOf,`（在 `extractJson,` 与 `itemId,` 之间合适位置）。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/llm.test.js`
Expected: FAIL — `findingsOf is not exported` / `suggestions` 字段仍在、issues 无 `suggestion` 键。

- [ ] **Step 3: 实现**（llm.js，替换 897-930 的 normalizeExplanation，并在其上方插入 findingsOf）

```js
/**
 * The merged findings of one file explanation: every finding carries its own suggestion.
 * Legacy caches kept suggestions as a second list (plain strings or `{ point|text, line }`
 * objects); they fold in here as `suggest` findings so no reader ever branches on the old
 * shape. This is the single normalization point — normalizeExplanation and every backend
 * reader go through it.
 */
export function findingsOf(explanation) {
  const issues = (Array.isArray(explanation?.issues) ? explanation.issues : [])
    .filter((item) => item !== null && typeof item === 'object')
    .map((item) => ({
      severity: item.severity === 'block' ? 'block' : 'suggest',
      point: typeof item.point === 'string' ? item.point.trim() : '',
      suggestion: typeof item.suggestion === 'string' ? item.suggestion.trim() : '',
      line: typeof item.line === 'number' && Number.isFinite(item.line) && item.line > 0 ? Math.floor(item.line) : 0,
    }))
    .filter((item) => item.point !== '');
  const legacy = (Array.isArray(explanation?.suggestions) ? explanation.suggestions : [])
    .map((item) => {
      if (typeof item === 'string') return { severity: 'suggest', point: item.trim(), suggestion: '', line: 0 };
      if (item === null || typeof item !== 'object') return null;
      const point = typeof item.point === 'string' && item.point.trim() !== ''
        ? item.point.trim()
        : (typeof item.text === 'string' ? item.text.trim() : '');
      if (point === '') return null;
      return {
        severity: 'suggest',
        point,
        suggestion: '',
        line: typeof item.line === 'number' && Number.isFinite(item.line) && item.line > 0 ? Math.floor(item.line) : 0,
      };
    })
    .filter((item) => item !== null && item.point !== '');
  return [...issues, ...legacy];
}

/** Normalize one file explanation (walkthrough included). */
export function normalizeExplanation(raw) {
  const walkthrough = Array.isArray(raw?.walkthrough)
    ? raw.walkthrough.filter((step) => step !== null && typeof step === 'object').map((step) => ({
        title: typeof step.title === 'string' ? step.title : '',
        detail: typeof step.detail === 'string' ? step.detail : '',
        hunk: typeof step.hunk === 'number' && step.hunk > 0 ? Math.floor(step.hunk) : 0,
        context: (() => {
          const rawContext = step.context;
          const startLine = typeof rawContext?.startLine === 'number' ? Math.floor(rawContext.startLine) : 0;
          const endLine = typeof rawContext?.endLine === 'number' ? Math.floor(rawContext.endLine) : 0;
          const label = typeof rawContext?.label === 'string' ? rawContext.label.trim() : '';
          const valid = startLine >= 1 && endLine >= startLine && endLine - startLine <= 400 && label !== '';
          return valid ? { label, startLine, endLine } : null;
        })(),
      }))
    : [];
  return {
    verdict: ['block', 'suggest', 'pass'].includes(raw?.verdict) ? raw.verdict : 'suggest',
    summary: typeof raw?.summary === 'string' ? raw.summary : '',
    logic: typeof raw?.logic === 'string' ? raw.logic : '',
    walkthrough,
    changes: typeof raw?.changes === 'string' ? raw.changes : '',
    issues: findingsOf(raw),
    unverified: normalizeUnverified(raw?.unverified),
  };
}
```

要点：返回对象不再有 `suggestions` 键（`assert.equal(explanation.suggestions, undefined)` 通过）；模型若无视 prompt 仍输出旧 `suggestions`，`findingsOf(raw)` 读 `raw.suggestions` 兜底合并，内容不丢。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/llm.test.js`
Expected: PASS（本任务新增 3 个用例 + 既有 `normalizeReport and normalizeExplanation keep unverified notes` 仍通过——若该用例断言了 `suggestions` 字段则同步移除该断言）。

- [ ] **Step 5: 提交**

```bash
git add llm.js tests/llm.test.js
git commit -m "feat(llm): findingsOf merges per-file issues and legacy suggestions into one list"
```

---

### Task 2: llm.js 复审管线 —— prompt 与解析带 `suggestion`，删除独立 suggestions 复审

**Files:**
- Modify: `llm.js:283-322`（buildExplainPrompt）
- Modify: `llm.js:339-401`（verifyPromptBody）
- Modify: `llm.js:427-448`（buildExplainVerifyPrompt）
- Modify: `llm.js:648-658`（normalizeConcerns）
- Modify: `llm.js:709-809`（partitionVerdicts）
- Delete: `llm.js:811-831`（partitionSuggestions）
- Test: `tests/llm.test.js`

- [ ] **Step 1: 写失败测试**

`tests/llm.test.js` 改造以下用例：

a) `explain prompt: test gaps, adaptive length and the issue shape`（:527）追加断言：

```js
  // 一条意见自带建议；不再有独立的 suggestions 输出。
  assert.match(prompt.user!.match(/"concerns": \[[^\]]*\]/)?.[0] ?? '', /"suggestion"/);
  assert.ok(!prompt.user.includes('"suggestions"'));
  assert.match(prompt.user, /point 只写问题与影响|不要把修法混进 point/);
  assert.match(prompt.user, /纯改进点/);
```

（按该测试现有的解构方式接入；核心断言：模板含 `"concerns"` + `"suggestion"`，不含 `"suggestions"`。）

b) `normalizeConcerns / normalizeEvidenceNeeds drop malformed entries`（:696）追加：

```js
  const concerns = normalizeConcerns([
    { severity: 'block', point: ' p ', suggestion: ' 修法 ', line: 2 },
    { severity: 'suggest', point: 'q', suggestion: '   ' },
    { point: 'no-suggestion' },
  ]);
  assert.deepEqual(concerns, [
    { severity: 'block', file: '', point: 'p', suggestion: '修法', line: 2 },
    { severity: 'suggest', file: '', point: 'q', suggestion: '', line: 0 },
    { severity: 'suggest', file: '', point: 'no-suggestion', suggestion: '', line: 0 },
  ]);
```

c) `partitionVerdicts: 80 is a finding...`（:721）追加 suggestion 保留断言：

```js
  const kept = partitionVerdicts(
    { results: [{ index: 1, confidence: 90, point: '重写后的问题', suggestion: '重写后的修法', line: 7 }] },
    [{ severity: 'block', file: '', point: '候选', suggestion: '候选修法', line: 0 }],
  );
  assert.equal(kept.issues[0].suggestion, '重写后的修法');
  // 模型没给 suggestion 时沿用候选的修法；都没有则键为 ''。
  const carried = partitionVerdicts(
    { results: [{ index: 1, confidence: 85, point: 'x' }] },
    [{ severity: 'suggest', file: '', point: '候选', suggestion: '候选修法', line: 0 }],
  );
  assert.equal(carried.issues[0].suggestion, '候选修法');
```

d) `the verifier prompt carries suggestions and the diff when given`（:836）改写 —— verifier 不再收独立建议列表，diff 保留用于判断「已实现」，schema 带 suggestion：

```js
test('the verifier prompt keeps the diff for implemented-checks and asks for a suggestion field', () => {
  const prompt = buildExplainVerifyPrompt(
    { platform: 'github', repo: 'o/r', number: 1, title: 't' },
    { path: 'a.js', status: 'modified', additions: 2, deletions: 1 },
    [{ severity: 'suggest', file: '', point: '抽 helper', suggestion: '抽成函数', line: 0 }],
    '证据',
    [],
    { diffText: '@@ -1 +1,2 @@\n+2' },
  );
  assert.ok(prompt.messages[0].content[0].text.includes('## 该文件的 diff'));
  assert.ok(!prompt.messages[0].content[0].text.includes('候选改进建议'));
  assert.ok(prompt.messages[0].content[0].text.includes('—— 建议：抽成函数'));
  assert.ok(prompt.messages[0].content[0].text.includes('"suggestion"'));
  assert.ok(!prompt.messages[0].content[0].text.includes('suggestionResults'));
});
```

e) 删除 `partitionSuggestions drops only explicitly rejected suggestions`（:828）与 import 里的 `partitionSuggestions`；新增：

```js
test('verifier prompt drops the implemented-suggestion rule in favour of confidence', () => {
  const prompt = buildExplainVerifyPrompt(
    { platform: 'github', repo: 'o/r', number: 1, title: 't' },
    { path: 'a.js', status: 'modified', additions: 0, deletions: 0 },
    [{ severity: 'suggest', file: '', point: '纯改进点', suggestion: '', line: 0 }],
    '证据',
    [],
    {},
  );
  assert.ok(prompt.messages[0].content[0].text.includes('已经由'));
  assert.ok(prompt.messages[0].content[0].text.includes('keep'));
});
```

等等——「keep」语义删掉了，这条断言不对。正确的新规则是：已实现的候选给低分丢弃。改为断言 prompt 含「已实现」与「confidence」：

```js
test('verifier prompt tells the model to score already-implemented candidates low', () => {
  const prompt = buildExplainVerifyPrompt(
    { platform: 'github', repo: 'o/r', number: 1, title: 't' },
    { path: 'a.js', status: 'modified', additions: 0, deletions: 0 },
    [{ severity: 'suggest', file: '', point: '纯改进点', suggestion: '', line: 0 }],
    '证据',
    [],
    {},
  );
  assert.ok(prompt.messages[0].content[0].text.includes('已实现'));
  assert.ok(!prompt.messages[0].content[0].text.includes('suggestionResult'));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/llm.test.js`
Expected: FAIL（新断言未满足 / partitionSuggestions import 报错）。

- [ ] **Step 3: 实现**

**buildExplainPrompt（llm.js:283-322）**：JSON 模板（304-313）改为：

```js
    '  "changes": "逐类说明具体变化：新增了什么、删除了什么、重命名/移动了什么",',
    '  "concerns": [{ "severity": "block | suggest", "point": "问题 + 影响（一条只写一个核心问题）", "suggestion": "具体修法（可选；没有明确修法就省略，不要把修法写进 point）", "line": 0 }],',
    '  "evidenceNeeds": [{ "concern": 1, "kind": "callers | definition | callee | schema | test | file", "path": "文件路径", "symbol": "符号名", "reason": "为什么需要它" }],',
    '  "verdict": "block | suggest | pass"',
    '}',
    'logic 只写全局、walkthrough 只写局部，两者不得互相复述；walkthrough 按 diff 规模 1-3 条（改动很小时 1 条即可）、按 diff 的 hunk 顺序覆盖主要改动；hunk 是该条分析对应的 diff hunk 序号（从 1 开始，按 @@ 出现顺序计数），不确定写 0；title 禁止出现「hunk」「第 N 段」这类编号；detail 面向第一次读这段代码的人，术语首次出现要顺带解释，问题与建议写到 concerns，不要写进 walkthrough；',
```

（即：concerns 行加 `suggestion` 字段、point 描述改为「问题 + 影响」；删除 `'"suggestions": ["可执行的修改建议"],'` 一行；314 行「concerns/suggestions」→「concerns」。）

指令行（原 317-318）替换为：

```js
    '如果这次改动引入重复分支、兼容回退或单次使用的包装层，在 concerns 里用 suggest 指出可化简之处；纯改进点（补测试、抽公共 helper 等没有具体缺陷的）也必须作为 severity 为 suggest 的 concern 输出，修法写进 suggestion。',
    'concerns 为空数组表示没有发现问题；point 只写问题与影响，不要把修法混进 point；line 用 diff 中的新文件行号，不确定写 0。',
```

（319 行 evidenceNeeds 指令不变。）

**normalizeConcerns（llm.js:648-658）**：map 里补 suggestion：

```js
    .map((item) => ({
      severity: item.severity === 'block' ? 'block' : 'suggest',
      file: typeof item.file === 'string' ? item.file : '',
      point: typeof item.point === 'string' ? item.point.trim() : '',
      suggestion: typeof item.suggestion === 'string' ? item.suggestion.trim() : '',
      line: typeof item.line === 'number' && Number.isFinite(item.line) ? Math.floor(item.line) : 0,
    }))
```

**verifyPromptBody（llm.js:339-401）**：

- 删 342-344 的 `suggestions` 收集（`extra.suggestions`）；`diffText` 保留（345）。
- 候选列表行（346-351）带建议续行：

```js
  const candidateLines = list.length === 0
    ? ['（无候选问题）']
    : list.map((item, index) => {
        const where = item.file === '' ? '' : ` [${item.file}${item.line > 0 ? `:${item.line}` : ''}]`;
        const advice = typeof item.suggestion === 'string' && item.suggestion !== ''
          ? `\n   —— ${language === 'en' ? 'Suggestion' : '建议'}：${item.suggestion}`
          : '';
        return `${index + 1}. [${item.severity}]${where} ${item.point}${advice}`;
      });
```

- diff 块标题（366）改为 `'## 该文件的 diff（用来判断候选是否已经实现）'`；删除「候选改进建议」section（368-370）。
- 判定规则：删除 387-392 的 suggestionResults 块；在判定规则列表追加一行：

```js
    '候选（含纯 suggest 改进点）已经由本次 diff 或现有代码实现、或只是复述现状的，confidence 打 24 以下直接丢弃；不要因为「有价值」而保留已经实现的条目。',
```

- 输出 schema（393-399）：

```js
  lines.push('', '请输出严格 JSON（不要输出 JSON 以外的解释）：', '{');
  lines.push('  "results": [{ "index": 1, "confidence": 85, "severity": "block | suggest", "point": "问题 + 影响", "suggestion": "具体修法（可选；沿用候选的修法或按证据修正）", "line": 0, "missing": "" }],');
  lines.push('  "extraIssues": [{ "confidence": 90, "severity": "block | suggest", "point": "问题 + 影响", "suggestion": "具体修法（可选）", "line": 0 }]');
  lines.push('}', language === 'en' ? 'Write the human-readable fields in English.' : '');
```

（原 395 行尾的 `suggestions.length > 0 ? ',' : ''` 分支删除。）

**buildExplainVerifyPrompt（llm.js:441）**：`{ suggestions: options.suggestions, diffText: options.diffText }` → `{ diffText: options.diffText }`。

**partitionVerdicts addIssue（llm.js:722-736）**：suggestion 先取模型改写、再沿用候选：

```js
  const addIssue = (item, fallback) => {
    const point = typeof item?.point === 'string' && item.point.trim() !== ''
      ? item.point.trim()
      : (fallback?.point ?? '');
    if (point === '' || seen.has(point)) return;
    seen.add(point);
    const modelSuggestion = typeof item?.suggestion === 'string' ? item.suggestion.trim() : '';
    const fallbackSuggestion = typeof fallback?.suggestion === 'string' ? fallback.suggestion.trim() : '';
    const suggestion = modelSuggestion !== '' ? modelSuggestion : fallbackSuggestion;
    issues.push({
      severity: severityOf(item, fallback),
      point,
      suggestion,
      line: typeof item?.line === 'number' && Number.isFinite(item.line)
        ? Math.floor(item.line)
        : (fallback?.line ?? 0),
      file: typeof item?.file === 'string' ? item.file : (fallback?.file ?? ''),
    });
  };
```

**删除 partitionSuggestions（llm.js:811-831 整段）**。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/llm.test.js`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add llm.js tests/llm.test.js
git commit -m "feat(llm): one concern carries one suggestion through triage and verification"
```

---

### Task 3: index.js 分析管线 —— 缓存恢复兼容 + `explainFileUncached` 透传 suggestion

**Files:**
- Modify: `index.js:52` import 块（补 `findingsOf`）
- Modify: `index.js:892-903`（restoreReviewRecord 的 explanations 恢复）
- Modify: `index.js:1718-1767`（explainFileUncached 的解析与复审段）
- Test: `tests/index.test.js`

- [ ] **Step 1: 写失败测试**

a) 旧缓存恢复合并（参考 index.test.js 既有缓存恢复用例的写法——搜索现有 `restoreReviewRecord` 或从缓存 JSON 恢复的测试搭同样的环境；如果现有测试直接构造 `saved.explanations` 数组再调内部恢复路径，照抄其环境）。新用例：

```js
test('restored legacy cache folds suggestions into suggest findings', async () => {
  // 环境与现有「从缓存恢复」用例一致：写缓存文件 → 启动插件 → 读 record。
  const record = /* 同现有恢复用例的获取方式 */;
  const entry = record.explanations.get('src/a.js');
  assert.deepEqual(entry.explanation.issues, [
    { severity: 'block', point: '旧问题', suggestion: '', line: 1 },
    { severity: 'suggest', point: '旧的独立建议', suggestion: '', line: 4 },
  ]);
  assert.equal(entry.explanation.suggestions, undefined);
});
```

（执行者须先在 tests/index.test.js 里找现有的缓存恢复测试——例如以 `loadCache` / `state.persisted` 断言的用例——复用其 fixture 搭法，explanation 填：

```js
{ verdict: 'block', summary: '旧分析', issues: [{ severity: 'block', point: '旧问题', line: 1 }], suggestions: [{ text: '旧的独立建议', line: 4 }], unverified: [] }
```

）

b) `evidenceVerify off keeps the single-pass contract`（:2891）扩展：模型的 explain 回复 concerns 带 suggestion，落库的 issues 保留它；回复若仍带旧 `suggestions` 字段也被合并：

```js
  // 在现有用例的 llm 回复 JSON 里把 concern 加上 suggestion，并断言落库形状：
  assert.deepEqual(entry.explanation.issues, [
    { severity: '...', point: '...', suggestion: '修法', line: ... },
  ]);
```

c) `a concern becomes a finding only after the verifier scores it against evidence`（:2834）扩展：verifier 回复 results 带 suggestion，最终 issues.suggestion 为 verifier 的改写；verifier 不给时沿用候选的。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/index.test.js`
Expected: FAIL。

- [ ] **Step 3: 实现**

**import（index.js:52 附近）**：`normalizeExplanation,` 后补 `findingsOf,`（保持字母序放在合适位置）。

**restoreReviewRecord（index.js:896-902）**：

```js
      explanations.set(entry.file, {
        status: entry.status ?? 'done',
        error: entry.error ?? null,
        // Normalize on restore: legacy caches carry a separate `suggestions` list, which
        // normalizeExplanation folds into `issues` (severity 'suggest') in place.
        explanation: entry.explanation === null || entry.explanation === undefined
          ? null
          : normalizeExplanation(entry.explanation),
        chat: Array.isArray(entry.chat) ? entry.chat : [],
        updatedAt: entry.updatedAt ?? 0,
      });
```

**explainFileUncached（index.js:1718-1767）**：解析到落库段替换为：

```js
    const parsed = answer.parsed;
    if (parsed === null || !answerHasContent(parsed)) {
      throw new Error(`模型没有返回完整的分析 JSON。原始输出：${answer.raw.slice(0, 400)}`);
    }
    const concerns = normalizeConcerns(parsed.concerns);
    // 旧 prompt 的 suggestions 输出由 normalizeExplanation 读时兼容兜底（findingsOf 会把
    // parsed.suggestions 合并进 issues），这里不再单独走「候选建议复审」。
    let issues = [];
    let unverified = [];
    if (concerns.length > 0) {
      if (settings.evidenceVerify === false) {
        issues = concerns.map(({ severity, point, suggestion, line }) => ({ severity, point, suggestion, line }));
      } else {
        const verdicts = await verifyConcerns(
          record,
          concerns,
          parsed.evidenceNeeds,
          (evidence, missing) => buildExplainVerifyPrompt(pull, file, concerns, evidence, missing, {
            language: commentLanguage(),
            diffText,
          }),
          epoch,
          signal,
        );
        if (verdicts.discarded) return { explanation: null, cached: false, discarded: true };
        issues = verdicts.issues;
        unverified = verdicts.unverified;
      }
    }
    // A confirmed blocker must not sit under a "pass" pill; mirror the report's reconciliation.
    const baseVerdict = parsed.verdict ?? 'suggest';
    const verdict = issues.some((item) => item.severity === 'block')
      ? 'block'
      : (issues.length > 0 && baseVerdict === 'pass' ? 'suggest' : baseVerdict);
    const explanation = normalizeExplanation({
      ...parsed,
      issues,
      unverified,
      verdict,
    });
```

说明：`issues = verdicts.issues` 保留了 partitionVerdicts 产物里的 `file` 键，`normalizeExplanation`→`findingsOf` 归一时丢弃它，落库形状统一为四键。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/index.test.js`
Expected: PASS（`a suggestion the diff already implements is dropped by the verifier`（:3093）此刻会失败——它测旧 suggestionResults 链路。**本任务一并重写该用例**为新语义：verifier 对「diff 已实现的纯改进点」回复低 confidence（<25），断言该意见不出现在 issues。）

- [ ] **Step 5: 提交**

```bash
git add index.js tests/index.test.js
git commit -m "feat(review): restore merges legacy suggestions; analysis carries suggestion through verification"
```

---

### Task 4: index.js 读取与清理 —— 读取点复用 `findingsOf`，`clearOverviewFindings` 新枚举

**Files:**
- Modify: `index.js:2759-2790`（analysisText）
- Modify: `index.js:2371-2422`（commentAppendixOf）
- Modify: `index.js:2962-2972`（overviewCounts）
- Modify: `index.js:2983-3007`（clearOverviewFindings）
- Test: `tests/index.test.js`

- [ ] **Step 1: 写失败测试**

a) `review_update_overview clearFindings keeps block items for narrower scopes`（:1855）改写：

- scope `'suggest'`：clear suggest 级意见 + suggest 级风险，保留 block 级两者；
- scope `'all'`：全清；
- scope `'suggestions'`（弃用别名）：行为等同 `'suggest'`；
- scope `'none'`：不清。

（explanation fixture 用合并后形状：`issues: [{ severity: 'block', point: '阻塞', suggestion: '', line: 1 }, { severity: 'suggest', point: '改进', suggestion: '修法', line: 2 }]`，不再有 `suggestions` 键。）

b) 新用例 `analysisText renders one findings section with inline suggestions`（若现有测试已覆盖 analysisText 输出，改造之；否则经 `review_get_analysis` 工具断言）：

```js
// explanation: { verdict: 'suggest', summary: 's', issues: [
//   { severity: 'block', point: '会崩', suggestion: '加判空', line: 3 },
//   { severity: 'suggest', point: '补测试', suggestion: '', line: 0 },
// ] }
// 期望文本（不含「改进建议：」段落）：
// 审查意见：
// - [block] 会崩（行 3）—— 建议：加判空
// - [suggest] 补测试
```

c) `commentAppendixOf` 的下游断言：现有附录相关测试（搜 `appendix`）里 files 条目从 `{ issues, suggestions }` 改为 `{ findings }`。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/index.test.js`
Expected: FAIL。

- [ ] **Step 3: 实现**

**analysisText（index.js:2773-2789）**：

```js
    const findings = findingsOf(explanation);
    if (findings.length > 0) {
      lines.push('审查意见：');
      for (const item of findings) {
        const where = item.line > 0 ? `（行 ${item.line}）` : '';
        const advice = item.suggestion !== '' ? `—— 建议：${item.suggestion}` : '';
        lines.push(`- [${item.severity}] ${item.point}${where}${advice === '' ? '' : ` ${advice}`}`);
      }
    }
    return toolText(lines);
```

**commentAppendixOf（index.js:2382-2398）**：

```js
    const files = [];
    for (const file of Array.isArray(record.files) ? record.files : []) {
      const entry = record.explanations.get(file.path);
      if (entry === undefined || entry.status !== 'done' || entry.explanation === null || entry.explanation === undefined) continue;
      const findings = findingsOf(entry.explanation).filter((item) => item.point !== '');
      if (findings.length === 0) continue;
      files.push({ file: file.path, findings });
    }
```

**overviewCounts（index.js:2961-2972）**：

```js
  /** Totals the overview shows: initial risks and per-file findings (suggestions included). */
  function overviewCounts(record) {
    const risks = Array.isArray(record.report?.risks) ? record.report.risks.length : 0;
    let issues = 0;
    for (const entry of record.explanations.values()) {
      if (entry.status !== 'done' || entry.explanation === null || entry.explanation === undefined) continue;
      issues += findingsOf(entry.explanation).length;
    }
    return { risks, issues };
  }
```

**clearOverviewFindings（index.js:2974-3007）**（整段替换；docstring 同步更新）：

```js
  /**
   * Clear the findings the overview renders, at the scope the caller names:
   * - `suggest`: every suggest-severity finding plus suggest-severity initial risks;
   * - `all`: every finding and every initial risk.
   * `suggestions` is the deprecated pre-merge alias and behaves like `suggest`.
   * Block-severity items always survive unless the scope is `all`.
   * `at` stamps the edits: callers writing a conclusion pass the same instant they used
   * for it, so a cleared finding can never look newer than the conclusion it belongs to.
   */
  function clearOverviewFindings(record, scope, at = Date.now()) {
    const cleared = { issues: 0, risks: 0 };
    const effective = scope === 'suggestions' ? 'suggest' : scope;
    if (effective !== 'suggest' && effective !== 'all') return cleared;
    for (const entry of record.explanations.values()) {
      if (entry.status !== 'done' || entry.explanation === null || entry.explanation === undefined) continue;
      const findings = findingsOf(entry.explanation);
      const nextFindings = effective === 'all' ? [] : findings.filter((item) => item.severity === 'block');
      cleared.issues += findings.length - nextFindings.length;
      if (nextFindings.length === findings.length) continue;
      entry.explanation = { ...entry.explanation, issues: nextFindings };
      entry.updatedAt = at;
    }
    const risks = Array.isArray(record.report?.risks) ? record.report.risks : [];
    const nextRisks = effective === 'all' ? [] : risks.filter((item) => item?.severity === 'block');
    cleared.risks = risks.length - nextRisks.length;
    if (cleared.risks > 0) record.report = { ...record.report, risks: nextRisks };
    return cleared;
  }
```

注意：写入的 `issues` 数组保留 findingsOf 的四键形状，后续读取一致。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/index.test.js`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add index.js tests/index.test.js
git commit -m "feat(review): readers use findingsOf; clearFindings collapses to none/suggest/all"
```

---

### Task 5: 逐文件对话 —— `findingOps` 作用于合并列表

**Files:**
- Modify: `llm.js:465-544`（buildChatPrompt 文件 scope）
- Modify: `llm.js:1046-1067`（normalizeSuggestionOps → normalizeFindingOps）
- Modify: `llm.js:1069-1077`（parseChatReply）
- Modify: `index.js:312-411`（applyOverviewOps 读 `op.point`）
- Modify: `index.js:413-438`（applySuggestionOps → applyFindingOps）
- Modify: `index.js:1906-1940`（chat()）
- Test: `tests/llm.test.js`、`tests/index.test.js`

- [ ] **Step 1: 写失败测试**

a) llm.test.js 新增：

```js
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
```

b) index.test.js：现有总览对话用例（:1058、:1107 附近 `suggestionOps: [{ op: 'update', target: ..., text: ... }]`）行为不变，只需确认仍通过（text→point 映射在解析层完成）。新增文件 scope 用例：

```js
test('a file chat applies findingOps to the merged findings list', async () => {
  // 环境照抄现有 chat 用例；explanation 预置：
  // issues: [{ severity: 'block', point: '第一条', suggestion: '修法一', line: 1 },
  //          { severity: 'suggest', point: '第二条', suggestion: '', line: 2 }]
  // 模型回复 { answer: '好', findingOps: [
  //   { op: 'update', index: 2, point: '改写后的第二条', suggestion: '新修法' },
  //   { op: 'remove', index: 1 },
  //   { op: 'add', point: '新增意见', severity: 'block', line: 9 } ] }
  // 断言 entry.explanation.issues deepEqual：
  //   [{ severity: 'suggest', point: '改写后的第二条', suggestion: '新修法', line: 2 },
  //    { severity: 'block', point: '新增意见', suggestion: '', line: 9 }]
  // 且 HTTP 返回 applied.length === 3。
});
```

（旧写法兼容断言补一条：模型用 `suggestionOps: [{ op: 'update', index: 1, text: '旧写法' }]` 也生效。）

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/llm.test.js tests/index.test.js`
Expected: FAIL。

- [ ] **Step 3: 实现**

**buildChatPrompt（llm.js:465-466、492-515）**：

```js
  const isFileScope = file !== null && file !== undefined;
  const currentFindings = findingsOf(explanation);
```

scopeSection 文件分支：

```js
  const scopeSection = isFileScope
    ? `## 该文件当前的审查意见（编号从 1 开始，用于这次讨论的增删改）\n${numbered(currentFindings, (item, i) => `${i + 1}. [${item.severity}] ${item.point}${item.line > 0 ? `（行 ${item.line}）` : ''}${item.suggestion === '' ? '' : `\n   —— 建议：${item.suggestion}`}`)}`
    : overviewLines();
```

outputLines 文件分支：

```js
  const outputLines = isFileScope
    ? [
        '"findingOps": [',
        '  { "op": "remove", "index": 1 },',
        '  { "op": "update", "index": 2, "point": "改写后的问题与影响", "suggestion": "改写后的具体修法（可选）", "severity": "block | suggest", "line": 12 },',
        '  { "op": "add", "point": "新意见的问题与影响", "suggestion": "可选：具体修法", "severity": "suggest", "line": 0 }',
        ']',
        'findingOps 只用于按这次讨论修改「该文件当前的审查意见」：某条不成立就 remove 对应编号；要改写就 update（只给要改的字段：point 写问题与影响，suggestion 写具体做法，severity/line 可一并改）；讨论出新意见就 add。没有要改的就输出空数组。不要通过 answer 代替操作。',
      ]
    : [ /* 总览分支保持原样（suggestionOps + target + text） */ ];
```

**normalizeSuggestionOps → normalizeFindingOps（llm.js:1046-1067）**（函数整体替换；导出名改）：

```js
/**
 * Normalize the mutations a discussion turn asks for. Overview ops carry a `target`
 * (risk/blocker/suggestion/nextStep) and must bring a non-empty point; file-scope ops
 * act on the merged findings list and may change only severity/suggestion/line. `text`
 * is the legacy field name (overview prompts and older models) and means `point`.
 */
export function normalizeFindingOps(raw) {
  if (!Array.isArray(raw)) return [];
  const ops = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const index = typeof item.index === 'number' ? Math.floor(item.index) : 0;
    const file = typeof item.file === 'string' ? item.file.trim() : '';
    const severity = item.severity === 'block' ? 'block' : item.severity === 'suggest' ? 'suggest' : '';
    const line = Number.isInteger(item.line) && item.line > 0 ? Math.floor(item.line) : 0;
    const suggestion = typeof item.suggestion === 'string' && item.suggestion.trim() !== '' ? item.suggestion.trim() : '';
    const point = (typeof item.point === 'string' ? item.point : (typeof item.text === 'string' ? item.text : '')).trim();
    const target = ['risk', 'blocker', 'suggestion', 'nextStep'].includes(item.target) ? item.target : '';
    const targetField = target === '' ? {} : { target };
    const scoped = { ...(suggestion === '' ? {} : { suggestion }), ...(line > 0 ? { line } : {}) };
    const severityField = severity === '' ? {} : { severity };
    const fileField = file === '' ? {} : { file };
    if (item.op === 'remove' && index > 0) {
      ops.push({ op: 'remove', index, ...targetField });
    } else if (item.op === 'update' && index > 0) {
      // Overview edits rewrite the text; file-scope edits may touch any subset of fields.
      if (target !== '' && point === '') continue;
      if (point === '' && suggestion === '' && severity === '' && line === 0) continue;
      ops.push({ op: 'update', index, ...(point === '' ? {} : { point }), ...scoped, ...targetField, ...fileField, ...severityField });
    } else if (item.op === 'add' && point !== '') {
      ops.push({ op: 'add', point, ...scoped, ...targetField, ...fileField, ...severityField });
    }
  }
  return ops;
}
```

**parseChatReply（llm.js:1076）**：

```js
  return { answer: parsed.answer.trim(), ops: normalizeFindingOps(parsed.findingOps ?? parsed.suggestionOps) };
```

**applyOverviewOps（index.js:312-411）**：把函数内全部 `op.text` 引用（update nextStep `list[index] = op.text;`、update risk `point: op.text`、update conclusion `point: op.text`、add 各分支 `point: op.text`）改为 `op.point`。docstring 补一句「ops come pre-normalized with `point`」。

**applySuggestionOps → applyFindingOps（index.js:413-438）**（整段替换）：

```js
/**
 * Apply the discussion's finding mutations to one file's merged findings list.
 * Indices are 1-based and validated against the current list, so an out-of-range
 * op from the model is ignored instead of corrupting the data. Update keeps the
 * fields the op does not mention, so a model can rewrite only the suggestion.
 */
function applyFindingOps(existing, ops) {
  const list = findingsOf(existing).map((item) => ({ ...item }));
  const applied = [];
  for (const op of Array.isArray(ops) ? ops : []) {
    const index = typeof op.index === 'number' ? op.index - 1 : -1;
    if (op.op === 'remove') {
      if (index < 0 || index >= list.length) continue;
      list.splice(index, 1);
      applied.push({ op: 'remove', index: index + 1 });
    } else if (op.op === 'update') {
      if (index < 0 || index >= list.length) continue;
      const before = list[index];
      list[index] = {
        severity: op.severity === 'block' || op.severity === 'suggest' ? op.severity : before.severity,
        point: typeof op.point === 'string' && op.point !== '' ? op.point : before.point,
        suggestion: typeof op.suggestion === 'string' ? op.suggestion : before.suggestion,
        line: Number.isInteger(op.line) && op.line > 0 ? op.line : before.line,
      };
      applied.push({ op: 'update', index: index + 1 });
    } else if (op.op === 'add') {
      if (typeof op.point !== 'string' || op.point === '') continue;
      list.push({
        severity: op.severity === 'block' ? 'block' : 'suggest',
        point: op.point,
        suggestion: typeof op.suggestion === 'string' ? op.suggestion : '',
        line: Number.isInteger(op.line) && op.line > 0 ? op.line : 0,
      });
      applied.push({ op: 'add' });
    }
  }
  return { list, applied };
}
```

**chat()（index.js:1930-1936）**：

```js
      if (entry.explanation !== null && entry.explanation !== undefined && ops.length > 0) {
        const result = applyFindingOps(entry.explanation, ops);
        if (result.applied.length > 0) {
          entry.explanation = { ...entry.explanation, issues: result.list };
          applied = result.applied;
        }
      }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/llm.test.js tests/index.test.js`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add llm.js index.js tests/llm.test.js tests/index.test.js
git commit -m "feat(chat): file discussion edits the merged findings list via findingOps"
```

---

### Task 6: index.js 工具 schema 与文案统一

**Files:**
- Modify: `index.js:3040-3058`（review_get 文案）
- Modify: `index.js:3069-3096`（review_list_files 描述与进度文案）
- Modify: `index.js:3098-3116`（review_get_analysis 描述）
- Modify: `index.js:2874-2901`（reviewSnapshotText 文案）
- Modify: `index.js:3229-3302`（review_update_analysis）
- Modify: `index.js:3524-3656`（review_update_overview 描述、clearFindings、审计与输出文案）
- Modify: `index.js:3719`（系统提示文案）
- Test: `tests/index.test.js`

- [ ] **Step 1: 写失败测试**

改造 `review_update_analysis writes with an optimistic lock and records audit`（:1367 与 :1534 两处重复用例）：

- args 只传 `issues`（每条带 `suggestion`），不传 `suggestions`；
- 断言落库 `explanation.issues` 形状含 `suggestion`、`explanation.suggestions === undefined`；
- 断言工具输出文本含「意见 N 条」且不含「/ 建议」。

改造 `review_update_overview` 相关断言：输出不含「建议 N 条」字样（结论层「修改建议 N 条」保留——它属于结论，不属逐文件）。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/index.test.js`
Expected: FAIL。

- [ ] **Step 3: 实现**（逐处文案）

1. **review_get（:3055）**：

```js
            `总览：初筛风险 ${overviewCounts(record).risks} · 逐文件审查意见 ${overviewCounts(record).issues} 条（review_update_overview 可一次改总览）`,
```

2. **review_list_files**：描述（:3071）`意见与建议数量` → `审查意见数量`；进度行（:3089）`已分析（${(entry.explanation?.issues ?? []).length} 条意见）`。

3. **review_get_analysis（:3100）**：`读取单个变更文件的逐文件分析：结论、代码逻辑与审查意见（含建议与行号）。`

4. **reviewSnapshotText（:2890）**：`已分析（${(entry.explanation?.issues ?? []).length} 条意见）`。

5. **review_update_analysis（:3230-3302）**：
   - 描述（:3231）：`更新单个变更文件的逐文件分析（结论/摘要/代码逻辑/审查意见），改写审查数据，右栏面板随后可见。必须带 review_get 返回的 revision 做乐观锁。`
   - 删除 `suggestions` 参数定义（:3246-3250）。
   - `issues` 描述（:3244）：`审查意见列表（传入即整体替换）；每条 { point, suggestion?, line?, severity? }，point 写问题与影响（≤ 500 字），suggestion 写具体修法，一条最多一条。`
   - execute：删除 `suggestions` 的 sanitize 与 next 构造里的 `suggestions` 键（:3265-3267、:3283）；`next` 对象补上 `unverified: Array.isArray(before?.unverified) ? before.unverified : []`（防止 human 编辑丢未验证项——顺手修复，见下方「注意」）；
   - 大小限制报错文案（:3286）：`该文件分析超过 12000 字符，请精简 issues 后重试。`
   - 输出（:3298）：`意见 ${next.issues.length} 条`。

   「注意」：现有 next 构造没有 `unverified`，human 编辑一次就丢未验证项。这是既有缺陷，本次顺手补上（normalizeExplanation 落库路径一直带 unverified）。若不想扩大范围，可省略此行——但推荐保留修复，一行成本。

6. **review_update_overview**：
   - 描述（:3526）：`……可选清理逐文件审查意见（clearFindings）。会刷新结论时间戳（清除 stale），并让面板、发布评论与后续重新生成看到同一份总览；用户说“结论通过 / 清理意见”时优先用它，不要逐个文件改。必须带 revision。`
   - clearFindings（:3560-3564）：`enum: ['none', 'suggest', 'all']`，描述：`清理逐文件/风险层面的 findings：suggest=清 suggest 级审查意见与 suggest 级初筛风险（保留阻塞项）；all=清空全部意见与风险；suggestions 为弃用别名，等同 suggest。默认 none。`
   - beforeCounts（:3578）/afterCounts（:3641）不变（overviewCounts 已无 suggestions）。
   - 审计（:3646）：`风险 ${beforeCounts.risks}→${afterCounts.risks} · 意见 ${beforeCounts.issues}→${afterCounts.issues} · 结论 ${normalized.verdict}`
   - 输出（:3652）：`初筛风险 ${afterCounts.risks} 条 · 逐文件审查意见 ${afterCounts.issues} 条`
   - 清理输出（:3653）：`已清理：意见 ${cleared.issues} 条、风险 ${cleared.risks} 条`

7. **系统提示（:3719）**：`可选 clearFindings 清理逐文件意见与建议` → `可选 clearFindings 清理逐文件审查意见`（其余不变）。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/index.test.js`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add index.js tests/index.test.js
git commit -m "feat(tools): review tools speak one findings list with inline suggestions"
```

---

### Task 7: llm.js 结论输入与发布评论附录

**Files:**
- Modify: `llm.js:562-568`（buildConcludePrompt entries）
- Modify: `llm.js:1442-1457`（buildCommentAppendix 的 files 段）
- Test: `tests/llm.test.js`

- [ ] **Step 1: 写失败测试**

a) `buildConcludePrompt: coverage, unanalyzed...`（:396）：explanation entries 不再含 suggestions——在该测试的 explanation fixture 里不传 suggestions，并断言 prompt 的「已逐文件分析」JSON 不含 `"suggestions"`：

```js
  const prompt = buildConcludePrompt(pull, report, new Map([
    ['a.js', { verdict: 'suggest', summary: 's', issues: [{ severity: 'block', point: 'p', suggestion: 'fix', line: 1 }] }],
  ]), null, {});
  assert.ok(!prompt.messages[0].content[0].text.includes('"suggestions"'));
  assert.ok(prompt.messages[0].content[0].text.includes('"suggestion"'));
```

b) `buildCommentMarkdown: ...appendix`（:299）与 shrink 用例（:347）：appendix fixture 的 files 条目改为 `{ file, findings: [{ severity, point, suggestion, line }] }`；断言输出里建议以缩进子 bullet 呈现：

```js
  // **src/a.js** 下：
  // - [阻塞] 会崩 `（行 3）`
  //   - 建议：加判空
```

（按现有测试断言风格调整——搜该用例现有的 `labels.suggestion` 或 `- 建议：` 断言并替换。）

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/llm.test.js`
Expected: FAIL。

- [ ] **Step 3: 实现**

**buildConcludePrompt entries（llm.js:562-568）**：

```js
  const entries = [...explanations.entries()].map(([filePath, explanation]) => ({
    file: filePath,
    verdict: explanation.verdict ?? '',
    summary: explanation.summary ?? '',
    issues: explanation.issues ?? [],
  }));
```

**buildCommentAppendix files 段（llm.js:1442-1457）**：

```js
  const files = Array.isArray(appendix.files) ? appendix.files : [];
  if (files.length > 0) {
    const blocks = [];
    for (const entry of files.slice(0, caps.files)) {
      const lines = [`**${entry.file}**`];
      for (const finding of (Array.isArray(entry.findings) ? entry.findings : []).slice(0, caps.perFile)) {
        lines.push(appendixBullet(finding, zh));
        if (typeof finding?.suggestion === 'string' && finding.suggestion !== '') {
          lines.push(`  - ${labels.suggestion}：${finding.suggestion}`);
        }
      }
      blocks.push(lines.join('\n'));
    }
    if (files.length > caps.files) blocks.push(more(files.length - caps.files));
    sections.push([`#### ${labels.files}`, ...blocks].join('\n\n'));
  }
```

（`labels.suggestion` 保留在 COMMENT_APPENDIX 里，作为续行标签；en 值 `Suggestion` 续行渲染为 `  - Suggestion: ...`？注意 zh 用全角冒号、en 也沿用同一模板 `：`。为 en 可读，改为 `zh/en` 各自拼：zh `  - 建议：`、en `  - Suggestion: `。实现：

```js
          const suggestionLabel = zh ? `${labels.suggestion}：` : `${labels.suggestion}: `;
          ...
          lines.push(`  - ${suggestionLabel}${finding.suggestion}`);
```

）

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/llm.test.js`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add llm.js tests/llm.test.js
git commit -m "feat(comment): appendix renders one findings list with nested suggestion lines"
```

---

### Task 8: 客户端渲染与 i18n

**Files:**
- Modify: `client.hooks.js:763-778`（fileFindings）
- Modify: `client.views.js:158-242`（findingsOf + FindingList）
- Modify: `client.views.js:462-559`（FileDetailPanel）
- Modify: `client.views.js:806-844`（ConclusionAppendix）
- Modify: `client.i18n.js`（zh 86-87,104,176,179；en 322-323,340,412,415）
- Test: `tests/client.test.js`

- [ ] **Step 1: 写失败测试**

改造 tests/client.test.js：

a) `per-file suggestions render as text whether stored as a string or an object`（:1427）→ 改为合并形状的渲染用例：file detail 的意见行渲染 point + 建议块（`suggestionTag`）+ 行号；不再有独立建议区块：

```js
test('the file detail renders one findings list where each row may carry a suggestion', () => {
  // explanation.issues = [
  //   { severity: 'block', point: '会崩', suggestion: '加判空', line: 3 },
  //   { severity: 'suggest', point: '补测试', suggestion: '', line: 0 },
  // ]
  // 断言：区块标题为 t('issues')（仅一个），行内出现 point 文本与 suggestionTag + 建议文本；
  // 不再出现 t('fileSuggestions')（该键已删除，渲染端也不应引用）。
});
```

b) `the file detail renders suggestion objects written by review_update_analysis`（:1468）→ 改为 review_update_analysis 写入的合并意见（`issues[].suggestion`）渲染用例。

c) 总览 FindingList 用例（搜现有使用 `groups` fixture 的测试，如 suggestionTag 相关 :215 上下文与 1427 附近的 FindingList 断言）：fixture 从 `{ file, issues, suggestions }` 改为 `{ file, findings }`；断言 block 行在前、行详情展开后有建议块。

d) `ConclusionAppendix collapses by default...`（:3398）：`sources.findings` fixture 改为合并行（无 kind），断言建议渲染为独立行且带 `[建议]` 标签（沿用 `suggestionTag`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/client.test.js`
Expected: FAIL。

- [ ] **Step 3: 实现**

**client.hooks.js（763-778）**：

```js
        const fileFindings = React.useMemo(() => {
          const groups = [];
          const orderIndex = new Map((review?.report?.order ?? []).map((item, index) => [item.file, index]));
          for (const entry of review?.explanations ?? []) {
            if (entry.status !== 'done' || entry.explanation === null || entry.explanation === undefined) continue;
            const findings = entry.explanation.issues ?? [];
            if (findings.length === 0) continue;
            groups.push({ file: entry.file, findings });
          }
          groups.sort(
            (a, b) =>
              (orderIndex.get(a.file) ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(b.file) ?? Number.MAX_SAFE_INTEGER),
          );
          return groups;
        }, [review]);
```

**client.views.js findingsOf（162-188）**：

```js
      /**
       * Flatten the per-file findings into the page's single ordered list: block first, then
       * suggest; ties break by path and line. Each row carries its own suggestion, rendered
       * inline. This is the one place the overview speaks about findings.
       */
      function findingsOf(groups) {
        const rows = [];
        for (const group of Array.isArray(groups) ? groups : []) {
          if (group === null || typeof group !== 'object') continue;
          const file = typeof group.file === 'string' ? group.file : '';
          for (const finding of Array.isArray(group.findings) ? group.findings : []) {
            if (finding === null || typeof finding !== 'object') continue;
            const point = typeof finding.point === 'string' ? finding.point.trim() : '';
            if (point === '') continue;
            rows.push({
              severity: finding.severity === 'block' ? 'block' : 'suggest',
              point,
              suggestion: typeof finding.suggestion === 'string' ? finding.suggestion : '',
              file,
              line: Number.isFinite(finding.line) && finding.line > 0 ? Math.floor(finding.line) : 0,
            });
          }
        }
        rows.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'block' ? -1 : 1)
          || a.file.localeCompare(b.file)
          || a.line - b.line);
        return rows;
      }
```

**FindingList 行渲染（199-241）**：头部 pill 不再分支（全部 `h(VerdictPill, { verdict: row.severity, t })`）；detail 展开区在 point 下补建议块：

```js
              open
                ? h(
                    'div',
                    { className: 'prr-finding-detail' },
                    h('div', { className: 'prr-text' }, row.point),
                    row.suggestion === ''
                      ? null
                      : h(
                          'div',
                          { className: 'prr-text' },
                          h('span', { className: 'prr-tag' }, t('suggestionTag')),
                          ` ${row.suggestion}`,
                        ),
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
```

**FileDetailPanel（488-533 与 return 555-557）**：issues 区块行内加建议块；删除整个 suggestions 区块：

```js
        const issues = (detail.issues ?? []).length === 0
          ? null
          : h(
              'div',
              null,
              h('div', { className: 'prr-h2' }, t('issues')),
              h(
                'div',
                { className: 'prr-card' },
                detail.issues.map((issue, index) =>
                  h(
                    'div',
                    { className: 'prr-rowitem', key: index },
                    h(VerdictPill, { verdict: issue.severity, t }),
                    h(
                      'div',
                      { className: 'prr-rowmain' },
                      h('div', { className: 'prr-text' }, issue.point),
                      (typeof issue.suggestion === 'string' && issue.suggestion !== '')
                        ? h(
                            'div',
                            { className: 'prr-text' },
                            h('span', { className: 'prr-tag' }, t('suggestionTag')),
                            ` ${issue.suggestion}`,
                          )
                        : null,
                      issue.line > 0
                        ? h('div', { className: 'prr-subtle' }, `${t('severityLine')} ${issue.line}`)
                        : null,
                    ),
                  ),
                ),
              ),
            );
        const unverified = h(UnverifiedBlock, { t, items: detail.unverified });
```

return 里 `issues, unverified, suggestions,` → `issues, unverified,`。`suggestionText` import 若仅此用途，可从该文件的解构中移除（结论层仍在 client.core.js 使用，core 不动）。

**ConclusionAppendix（806-844）**：注释与渲染改为合并行：

```js
        // Severity markers mirror the comment's appendix bullets (llm.js COMMENT_SEVERITY_LABELS):
        // `[阻塞] `/`[提示] ` for the finding, with its suggestion as a `[建议] ` line below.
        const severityPrefix = (severity) => `[${t(severity === 'block' ? 'verdictBlock' : 'severityHint')}] `;
```

files 段（830-844）：

```js
        if (rows.length > 0) {
          sections.push(section(t('appendixFiles'), h(
            'div',
            null,
            rows.flatMap((row, index) => {
              const base = row.file === '' ? row.point : `${fileLineLabel(row.file, row.line)} — ${row.point}`;
              const main = line(`${severityPrefix(row.severity)}${base}`, `f-${index}`);
              if (row.suggestion === '') return [main];
              return [main, line(`[${t('suggestionTag')}] ${row.suggestion}`, `fs-${index}`)];
            }),
          ), 'files'));
        }
```

**client.i18n.js**：

- zh:87 `suggestionUpdated: '已按讨论更新审查意见'`
- zh:104 删除 `fileSuggestions`
- zh:176 `composerPlaceholder: '讨论并修改总览/文件意见…'`
- zh:179 `conclusionStale: '对话或文件意见已有新改动，建议重新生成最终结论。'`
- en:323 `suggestionUpdated: 'Findings updated from the discussion'`
- en:340 删除 `fileSuggestions`
- en:412 `composerPlaceholder: 'Discuss or edit the overview / file findings…'`
- en:415 `conclusionStale: 'Discussion or file findings changed after this conclusion. Regenerate it.'`

（zh:86 / en:322 `suggestionTag` 保留不动。）

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/client.test.js`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add client.hooks.js client.views.js client.i18n.js tests/client.test.js
git commit -m "feat(client): panel and appendix render one findings list with inline suggestions"
```

---

### Task 9: 全量验证与收尾

**Files:**
- 无新改动（验证 + 遗漏检查）

- [ ] **Step 1: 全量测试**

Run: `pnpm test`
Expected: 全部 PASS（含 stamp 检查）。

- [ ] **Step 2: 全库残留检查**

Run:

```bash
grep -rn "explanation.suggestions\|entry.suggestions\|explanation?.suggestions" index.js llm.js client.*.js || true
grep -rn "fileSuggestions" client.*.js tests/ || true
grep -rn "partitionSuggestions" llm.js tests/llm.test.js || true
```

Expected: 均无输出（README/locale 无需改动——README 中的「建议」均指结论层）。

- [ ] **Step 3: 验收对照（issue #21）**

- 新生成的分析不再输出 `suggestions` 字段；每条意见最多一条 `suggestion` —— Task 1/2/3 落库路径 `normalizeExplanation` 保证。
- 面板详情、总览、发布附录三处只有一个意见列表，每条意见能看到对应建议 —— Task 7/8。
- 打开旧缓存后原 `suggestions` 条目仍可见（并入 issues、`severity: 'suggest'`）—— Task 3（restoreReviewRecord + normalizeExplanation 兼容）+ Task 1 测试。
- 逐文件对话可以增删改问题描述与建议 —— Task 5。
- `clearFindings` 的 `suggest` / `all` 行为与新的单一列表一致；`suggestions` 别名仍可用 —— Task 4。
- `pnpm test` 通过；旧数据合并、prompt 不再输出 suggestions、附录渲染、对话 ops 用例齐备 —— 各 Task + Task 9。

- [ ] **Step 4: 汇报**

对照验收标准逐条汇报；如发现 issue 未覆盖的边角（如某个测试 fixture 仍带 suggestions 键），当场修掉并在汇报中说明。

---

## Self-Review 结论（已核对）

1. **Spec 覆盖**：issue「改动点」1（提示词与规范化）→ Task 1/2；2（工具契约）→ Task 4/6；3（渲染）→ Task 7/8；4（逐文件对话）→ Task 5。验收项全部映射到 Task 9 Step 3 的对照表。`concludeInputsOf` 按 issue 备注不改（只读 issues[].severity）；结论层 `commentItems`/发布筛选/上一轮对比不改。
2. **占位符**：无 TBD/TODO；Task 3/8 的两处「照抄现有用例环境」指的是复用同文件内现成 fixture 搭法（缓存恢复、chat 环境），fixture 数据本身已给出。
3. **类型一致性**：`findingsOf` 输出固定四键 `{ severity, point, suggestion, line }`，Task 4/5/7/8 的消费端均按此形状；`normalizeFindingOps` 输出 `point`（`text` 只在输入侧兼容），Task 5 的 `applyOverviewOps`/`applyFindingOps` 均读 `point`；`commentAppendixOf` 产出 `entry.findings`，Task 7 附录与 Task 8 客户端 appendix 均读 `findings`（客户端走的是 `fileFindings` groups → `group.findings`，同名约定）。

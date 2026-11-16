# 审查取证轮设计（issue #20）

日期：2026-11-16
分支：`worktree-feat+20-review-evidence`

## 1. 背景与目标

当前审查链路是「单轮文本」：报告阶段只拿到变更文件的 diff 节选，逐文件阶段只拿到 diff + 该文件全文。模型看不到调用方、基类、schema 和测试，于是只能把不确定的怀疑降级成建议，并在文案里写「（不确定：……」——等于把核实工作推给用户。

本设计要达成两件事：

1. 报告/建议里只出现**经过取证**的结论；无法核实的点移入单独的「未验证项」，并写明缺哪份证据。
2. 审查沿**调用链**进行：每个改动点先取到调用方/被调方的证据，再判断影响与严重度。

## 2. 非目标

- 不引入 tool-use 循环（模型不能主动调用工具），取证由宿主在两次模型调用之间完成。
- 不做跨 PR 的调用图缓存。
- 不把未验证项发布到 PR 评论。
- 不改动 #22 的范围（draft 门禁、规范文件证据源）。

## 3. 数据契约

### 3.1 持久化结构

`normalizeReport(raw, fallbackOrder)` 新增：

```js
unverified: [{ point: string, missing: string }]
```

`normalizeExplanation(raw)` 新增同名字段。

`unverified[].missing` 说明缺哪份证据，例如「无法读取 `src/foo.js`：文件不存在」或「复审未完成：模型返回无法解析的 JSON」。

### 3.2 中间产物（不持久化）

```js
// 第一轮输出
concerns: [{ point, severity, line, file? }]
evidenceNeeds: [{ concern: number /* 1-based */, kind, path?, symbol?, reason? }]
// kind: 'callers' | 'definition' | 'callee' | 'schema' | 'test' | 'file'

// 第二轮输出
results: [{ index: number /* 对应 concerns 序号，1-based，与 evidenceNeeds.concern 同基准 */, confidence: 0-100, severity, point, line }]
extraIssues: [{ confidence: 0-100, severity, point, line }]   // 取证过程中新发现的问题
```

### 3.3 分档规则（纯函数，可单测）

```js
export const CONFIDENCE_FINDING = 80;
export const CONFIDENCE_UNVERIFIED = 25;
export function partitionVerdicts(raw, concerns) // → { issues, unverified, dropped }
```

- `confidence >= 80` 且 `point` 非空、且 `point` 不含自述不确定措辞 → `issues`
- `25 <= confidence < 80`，或 `point` 自述「无法确认 / 证据不足」→ `unverified`，`missing` 取模型给出的 `missing`，缺省为「证据不足以确认」
- `confidence < 25` → 丢弃并计入 `dropped`
- `extraIssues` 同样走置信度分档（缺省按 `CONFIDENCE_FINDING`，因为它在看证据时产生），不再无条件进入 `issues`

## 4. 两轮流程

### 4.1 报告阶段（`runReview`）

1. `buildReportPrompt` 输出 `verdict / summary / order / focus / concerns / evidenceNeeds`。
2. `concerns` 为空：`risks = []`，`unverified = []`，流程结束（一次调用，与现状成本相同）。
3. 否则：
   - `collectEvidence(record, evidenceNeeds, settings)` → `{ blocks, missing }`
   - `buildReportVerifyPrompt(pull, concerns, blocks, missing, { language })` → `results / extraIssues`
   - `partitionVerdicts` → `risks`、`unverified`
4. `verdict` 按最终 `risks` 修正：存在 block → `block`；否则保留第一轮取值。
5. 复审失败时（模型错误或 JSON 无法解析）：`risks = []`，所有 concerns 进 `unverified`，`missing = '复审未完成：<原因>'`，`console.warn` 记录；报告其余字段照常保存，与逐文件阶段的降级一致。

### 4.2 逐文件阶段（`explainFileUncached`）

1. `buildExplainPrompt` 的 `issues` 字段被 `concerns` + `evidenceNeeds` 取代；`logic / walkthrough / changes / suggestions / summary / verdict` 保持不变。
2. `concerns` 为空：`issues = []`，一次调用结束。
3. 否则同报告阶段：取证 → 复审 → `issues` / `unverified`。
4. 复审失败时（模型错误或 JSON 无法解析）：`issues = []`，所有 concerns 进 `unverified`，`missing = '复审未完成：<原因>'`，`console.warn` 记录，不抛错、不影响本轮其余内容。

### 4.3 取消与轮次切换

沿用 `analysisEpoch`：每轮 await 之后重新校验 epoch，证据收集与复审之间也要校验；丢弃时返回 `{ explanation: null, cached: false, discarded: true }`。

## 5. 证据收集器

`index.js` 新增：

```js
async function collectEvidence(record, needs, settings) // → { blocks: string, missing: string[], used: number }
```

### 5.1 找路径

对每个 need：

1. `need.path` 非空且形如文件路径 → 直接使用；
2. 否则若 `need.symbol` 非空，且本地工作区可用 → `git grep -l -F <symbol>`（限制 5 个结果）；
3. 否则若 need 指向 diff 中出现的 import/require 路径 → 使用；
4. 都不满足 → 记入 `missing`。

本地工作区不可用时（origin 解析失败、非 git 目录、remote 不可识别），跳过第 2 步，退回模型声明与 diff 路径；仍找不到的记入 `missing`，不抛错。

本地工作区可用性的判定：`state.workspaceCwd` 非空，且该目录经 `git remote get-url origin` 解析出的 `platform:repo` 与 `provider` 一致。`state.workspaceCwd` 在 `/context` 路由成功激活仓库时写入。

### 5.2 取正文

一律 `ensureFileContent(record, path)`（内部 `pullFileContent(path, headSha)`），复用 `record.fileContents` 缓存。**本地文件只用于找路径，绝不出现在证据正文里。**

### 5.3 裁剪

- need 带 `symbol`：从正文定位首次出现，取前后各 40 行；
- 否则取前 200 行；
- 证据块标题必须标注实际显示的行范围（如「第 40–120 行（共 300 行）」）或字符截断说明，让裁判知道自己在看片段；
- 单文件上限 `settings.evidenceMaxChars`（默认 6000）；
- 每轮最多 `settings.evidenceMaxFiles`（默认 6）个文件；超出时按 need 顺序截断并记入 `missing`。

### 5.4 输出

```text
## 证据 1：src/foo.js（callers · symbol=startReview）
```js
<裁剪后的代码>
```
```

读不到的文件写进 `missing`，供复审 prompt 使用。

## 6. Prompt 改动（`llm.js`）

### 6.1 `REVIEW_FRAMEWORK`

- 证据要求改写为：无法验证的怀疑**不得**写入 `issues`/`risks`；应写入 `unverified` 并说明缺什么。删除「（不确定：……」出口。
- 新增调用链要求：判断影响前先列举「谁调用它 / 它调用谁 / 状态由谁读写」；列不出的写进 `evidenceNeeds`，不得据此报 block。
- 新增误报排除清单：
  1. 本次改动之前就存在的问题；
  2. 看起来像 bug、实际不是；
  3. 资深工程师不会在评审里提的挑剔；
  4. linter / 类型检查 / 编译器能直接抓到的；
  5. 泛泛的质量问题（缺测试、缺文档、泛泛的安全担忧），除非仓库规范明确要求；
  6. 被 lint-ignore 之类注释显式压制的问题；
  7. 明显是本次有意为之的行为变更；
  8. 落在本次未修改行上的真实问题。

### 6.2 `buildReportPrompt`

输出 JSON：

```json
{
  "verdict": "block | suggest | pass",
  "summary": "...",
  "order": [{ "file": "...", "reason": "..." }],
  "focus": [{ "file": "...", "point": "..." }],
  "concerns": [{ "file": "...", "severity": "block | suggest", "point": "...", "line": 0 }],
  "evidenceNeeds": [{ "concern": 1, "kind": "callers", "path": "...", "symbol": "...", "reason": "..." }]
}
```

`concerns` 每条必须关联至少一个 `evidenceNeeds`；仅凭 diff 即可确认时，给一个 `kind=file`、`path` 指向该改动文件本身的 need（宿主会读取该文件作为证据），不要留空。无问题时两个数组均为 `[]`。

### 6.3 `buildExplainPrompt`

`issues` 字段替换为 `concerns` + `evidenceNeeds`（结构同上，`file` 可省略）。

### 6.4 新增 `buildReportVerifyPrompt` / `buildExplainVerifyPrompt`

输入：候选问题、证据块、缺失说明。输出：

```json
{
  "results": [{ "index": 0, "confidence": 85, "severity": "block | suggest", "point": "...", "line": 12, "missing": "" }],
  "extraIssues": [{ "confidence": 90, "severity": "suggest", "point": "...", "line": 0 }]
}
```

角色设定为「裁判」：只看候选与证据，不得引用第一轮的推理；规范类问题必须引用规范原文。`extraIssues` 必须引用某个证据块中的代码，且同样给出 `confidence`（按 3.3 分档），否则不得输出。证据块只显示文件片段时，不得据此断言文件里不存在某段内容。`maxTokens` 8000，`timeoutMs` 300 000。

## 7. 配置

新增 schema 项：

```js
evidenceVerify: Schema.boolean().default(true),
evidenceMaxFiles: Schema.number().default(6),
evidenceMaxChars: Schema.number().default(6000),
```

`evidenceVerify: false` 时退回当前单轮行为：`concerns` 直接按 severity 转为 `issues`/`risks`，不取证、不产生 `unverified`。

## 8. 渲染（`client.js`）

- 文件详情：`审查意见` 之后新增「未验证项」区块，样式类 `prr-unverified`（弱化文字、虚线分隔），每条显示 `point` 与 `missing`。
- 总览：风险区之后同样一块，标题 `未验证项`。
- 不计入 verdict 着色与文件严重度点。
- i18n 新增：`unverified`、`unverifiedMissing`、`unverifiedHint`（中英两套）。

## 9. 测试策略

- `tests/llm.test.js`
  - `normalizeReport` / `normalizeExplanation` 保留 `unverified` 字段并过滤非法项；
  - `partitionVerdicts` 的 80/25 边界、缺失 point、`extraIssues` 合并；
  - `REVIEW_FRAMEWORK` 不再包含「（不确定：」，包含误报清单与调用链要求；
  - 复审 prompt 只包含候选与证据。
- `tests/index.test.js`
  - 无 concerns：每个文件只调用一次模型；
  - 有 concerns：调用两次，`issues` 来自 confidence ≥ 80；
  - 证据读取失败 / 复审失败：对应项进 `unverified`，不抛错；
  - `evidenceVerify: false`：单轮行为。
- `tests/client.test.js`
  - `unverified` 区块渲染；为空时不渲染。
- 全部现有测试保持通过。

## 10. 风险

- **成本上升**：有候选问题的文件调用数翻倍。缓解：`evidenceVerify` 开关、证据文件与字符上限。
- **自我确认偏差**：复审由同一模型完成。缓解：裁判角色 prompt、只看证据、置信度门槛。
- **本地 grep 误用**：只在 origin 匹配时启用，且只用于找路径。
- **API 限流**：证据读取计入平台配额。缓解：缓存复用 + 每轮文件上限。

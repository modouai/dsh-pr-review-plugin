# 提示词外置为 Markdown 设计

日期：2026-11-21
状态：已实现，待合并
关联：issue #27（审查提示词输出契约手写两遍）

## 背景

审查链路的全部模型调用都有一份输出 JSON 契约。目前每份契约以两种形态存在、两处维护：prompt 内联的字符串模板，与 `llm.js` 里独立的 `normalize*`/`partition*` 解析函数，两者靠人工保持一致。

问题不止于契约：

- 静态提示文本散落在 `llm.js` 的 builder 与 system prompt 函数里，改一处要从长字符串里定位。
- 同一内容多处复述：`"block | suggest"` 枚举 6 处、语言规则 3 处、审查框架与判定规则分处三个 builder。
- `index.js` 注入给 Agent 的审阅数据指引是一整段硬编码中文，和提示词体系分家。

本设计把静态提示文本全部外置为 `prompts/*.md`，用统一加载器组装；动态数据通过具名占位符注入；解析侧行为完全不变。

## 目标

1. 所有提示词的静态文字以 Markdown 文件承载，按标题、列表、围栏 JSON 块组织。
2. `llm.js` 的 6 个 builder（report / explain / verify / chat / conclude / feedback）与 3 个 system prompt（reviewer / compact / verifier）只准备数据并渲染，不再手写提示文本。
3. `index.js` 的 `pr-review: review-data` 系统提示段改为加载 `prompts/review-data.md`。
4. 复述内容归一为共享片段：审查框架、语言规则、取证要求、条件契约字段。
5. 占位符缺值立即抛错，提示词与代码的漂移不能被静默吞掉。

## 非目标

- 不引入 schema DSL，不让同一份描述同时生成 prompt 与解析逻辑。
- 不修改任何 `normalize*` / `partition*` 的行为；防御性容错（0-based 序号纠偏、越界结果丢弃、未回答候选补 unverified）全部保留。
- 不改变审查语义、判定阈值或输出措辞。
- 不拆 `llm.js` 文件；约 15 个 normalize/partition 函数留在原处。
- 不改运行时快照 `reviewSnapshotText()` 的生成逻辑。

## 文件布局

```
prompts/
  reviewer.md              # 通用审查员 system prompt
  reviewer-compact.md      # 短结构化任务 system prompt
  verifier.md              # 取证裁判 system prompt
  report.md                # 总体初筛任务
  explain.md               # 逐文件分析任务
  verify.md                # 取证裁判任务
  chat.md                  # 对话任务
  conclude.md              # 最终结论任务
  feedback.md              # 评论回复解析任务
  review-data.md           # index.js 注入的系统提示段
  fragments/
    review-framework.md    # 严重度、六维、证据要求、误报排除、化简审查
    previous-verdicts.md   # explain 存在基线时才注入的契约字段
    language-zh.md         # system prompt 的输出语言规则
    language-en.md
    language-compact-zh.md # compact system prompt 专用（保留 quoted text 措辞）
    language-compact-en.md
    verify-language-zh.md  # 裁判任务的语言相关判定规则
    verify-language-en.md
    chat-file-contract.md  # 对话：文件范围输出的 findingOps 契约
    chat-overview-contract.md  # 对话：总览范围输出的 suggestionOps 契约
```

`prompts/` 与 `llm.js` 同级。每个任务文件是一份完整的 Markdown 文档，包含：任务说明、动态数据占位符、输出契约（围栏 JSON 代码块）。

## 加载器

新文件 `prompts.js`（ESM，无第三方依赖，不导入 `llm.js` 以避免循环引用）：

```js
loadPrompt(name)            // 读取 prompts/<name>.md，模块初始化时读取并缓存
renderTemplate(template, name, values) // 纯函数：替换占位符、校验、trimEnd
renderPrompt(name, values)  // loadPrompt(name) + renderTemplate(...)
fragment(name)              // 读取 prompts/fragments/<name>.md
```

规则：

- 同步 `readFileSync(new URL('./prompts/<name>.md', import.meta.url), 'utf8')`。
- `prompts.js` 导出 `PROMPT_NAMES` 与 `FRAGMENT_NAMES`，模块初始化时遍历读取全部文件；缺文件在 import 期失败。
- `{{key}}` 只匹配 `[A-Za-z][A-Za-z0-9_]*`。
- `values` 缺少某个占位符对应的键、或值为 `null`/`undefined` → 抛出 `Missing prompt value: <file>#<key>`。显式空字符串 `''` 合法（用于 `{{previousVerdictsField}}`）。
- 替换前检查模板：把合法占位符去掉后模板里仍有 `{{` → 抛出 `Malformed placeholder: <file>`。该检查只看模板，不看替换值，避免 diff 等动态内容里出现 `{{` 时误报。
- 返回值做 `trimEnd()`，不加尾随换行。

`llm.js` 与 `index.js` 都从 `prompts.js` 导入。

## 占位符

### 静态共享片段（由加载器提供）

| 占位符 | 来源 |
|---|---|
| `{{reviewFramework}}` | `fragments/review-framework.md` |
| `{{languageRule}}` | `fragments/language-zh.md` 或 `language-en.md`，由 `normalizeLanguage` 决定 |
| `{{verifyLanguageRule}}` | `fragments/verify-language-zh.md` 或 `verify-language-en.md`，决定裁判任务里「无法确认」类措辞的判据与最终输出语言 |
| `{{previousVerdictsField}}` | 有基线时为 `fragments/previous-verdicts.md`，无基线时为空串（builder 必须显式传值） |

### 动态数据（由 builder 提供）

按任务文件分别定义，包括但不限于：

- `report.md`：`{{platform}}`、`{{repo}}`、`{{pullNumber}}`、`{{title}}`、`{{author}}`、`{{headRef}}`、`{{baseRef}}`、`{{changedFiles}}`、`{{additions}}`、`{{deletions}}`、`{{bodySection}}`、`{{fileLines}}`、`{{order}}`、`{{excerpts}}`
- `explain.md`：PR 元信息、`{{filePath}}`、`{{fileStatus}}`、`{{additions}}`、`{{deletions}}`、`{{focus}}`、`{{reportLine}}`、`{{diff}}`、`{{fileContentSection}}`、`{{baselineSection}}`、`{{previousVerdictsField}}`
- `verify.md`：`{{header}}`、`{{candidates}}`、`{{evidence}}`、`{{missing}}`、`{{diffSection}}`、`{{verifyLanguageRule}}`
- `chat.md`：PR 元信息、`{{scopeLabel}}`、`{{reportLine}}`、`{{explanation}}`、`{{scopeSection}}`、`{{transcriptSection}}`、`{{question}}`、`{{outputContract}}`
- `conclude.md`：PR 元信息、`{{reportLine}}`、`{{entryCount}}`、`{{entries}}`、`{{coverageSection}}`、`{{previousItemsSection}}`、`{{humanItemIdsSection}}`、`{{feedbackSection}}`、`{{chatSection}}`、`{{currentConclusionSection}}`
- `feedback.md`：`{{pullNumber}}`、`{{title}}`、`{{itemLines}}`、`{{commentLines}}`

builder 的职责收敛为三步：

1. 准备上述动态值；
2. `renderPrompt('<task>', values)`；
3. 返回 `{ system, messages, maxTokens, timeoutMs, temperature? }`。

## 语言处理

`reviewer.md`、`reviewer-compact.md`、`verifier.md` 末尾注入 `{{languageRule}}`。

- `fragments/language-zh.md` / `language-en.md`：reviewer 与 verifier 的输出语言规则，保护代码标识符、路径与引用原文。
- `fragments/language-compact-zh.md` / `language-compact-en.md`：compact 专用，沿用原来的「quoted text」措辞（不扩宽为 quoted code），因为反馈任务需要引用开发者回复原话。

`llm.js` 用 `languageRule(language, compact = false)` 统一选择片段。不为整份提示词做 zh/en 双版本，避免两份正文长期漂移。

## index.js 注入

- `systemPrompt.section({ name: 'pr-review: review-data', order: 60, text: loadPrompt('review-data') })`（在 `apply` 内调用一次）。
- `systemPrompt.context({ ... text: (context) => reviewContextText(...) })` 保持不变。运行时快照本身是动态数据，不走 Markdown 模板；它已经是正确的动态注入形态。

## 错误处理

- 占位符缺值、残留占位符、文件缺失均为加载/渲染期异常，测试直接失败。
- 渲染异常不捕获；插件启动时暴露具体文件名与占位符，便于定位。
- 不改变 `callModel` 的取消、超时与重试语义。

## 测试

保留 `tests/llm.test.js` 现有 283 个断言，随渲染方式等价迁移。断言文本不变；Markdown 化只新增标题与列表符号。

新增 `tests/prompts.test.js`：

1. `prompts/` 下所有 `.md` 可加载且非空。
2. 每个 builder 都能成功渲染，结果不含 `{{`。
3. 缺少必需值时抛出异常。
4. `prompts/` 中引用的 fragment 名字全部存在。
5. `package.json` 的 `files` 覆盖 `prompts.js` 与 `prompts/**/*.md`（防止发布时漏文件）。

`pnpm test` 必须全绿。

## 打包

`package.json` 的 `files` 增加 `"prompts.js"` 与 `"prompts/**/*.md"`。

## 风险

- Markdown 化会改变标题层级与少量空白，可能触发既有断言失败；逐条修正，不放宽断言。
- 同步读取发生在模块初始化：任一提示词文件缺失会让插件加载失败。这是有意的快速失败。
- `prompts.js` 与 `llm.js` 的依赖方向必须单向（`llm.js` → `prompts.js`），不得反向导入。
- 动态数据截断逻辑（`truncateWithMarker`、`slice`、字符上限）原样保留在 builder 中，搬家时不改变截断阈值。

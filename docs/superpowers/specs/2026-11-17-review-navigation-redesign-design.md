# 总览导航重构设计：总览 / 明细 / 结论 三页模式

日期：2026-11-17
分支：`docs/navigation-redesign-spec`

## 1. 背景与问题

当前总览（`client.views.js` `OverviewPanel`，486-707 行）按流水线生产顺序堆叠六类区块：

1. （round ≥ 2）实现者反馈 + 轮次对比（522-537 行）；
2. 初筛报告卡：`report.verdict` pill + summary（619-635 行）；
3. 总体初筛风险（636-648 行）；
4. 未验证项（649 行）；
5. 逐文件发现聚合全文（650-700 行）；
6. 最终结论（701 行，带版本选择器）+ 已发布评论（702 行，条目全文再重复一遍）。

由此产生四个问题：

- **判定竞争**：初筛 verdict 与结论 verdict 平权同屏，读者无法判断哪个作准；结论未生成时初筛顶替结论位置，生成后结论压在最底部。
- **状态不可见**：`record.status`、`concluding.stage`、`analyzing`、`coverage`、staleness、published 这些状态在数据层齐全，但 UI 把它们拆成零状态文案、footer 小字（`client.conclusion.js` `overviewFooter`，426 行起）、tag 与按钮禁用态，没有一处回答「现在在干什么」。
- **信息重复**：同一发现以全文出现三次（文件列表严重度圆点 `client.core.js:1059`、总览聚合、结论条目），已发布评论再重复一遍。
- **职责混杂**：总览同时承担过程展示、发现聚合与最终决策三个职责。
- **中间态外流**：初筛风险、未验证项、丢弃计数把核实中的假设推给读者，等于把核实工作交给用户；「没审到」与「核查后干净」在面板上不可区分。

本设计只动客户端渲染与导航，不动数据契约与 prompt。

## 2. 目标

1. **任何时刻只有一条状态、一个主行动**：新增 `derivePhase(review, staleInfo)` 纯函数归一全部状态，供 PhaseBar、左栏徽标、footer 动作三处消费。
2. **三页分离，各答一个问题**：总览（对话状态、改动概述、发现与完备性）/ 明细（单文件全文与代码上下文）/ 结论（决策与发布）。
3. **导航即流程**：左栏 = 审查目录，默认路径「总览 → 明细 → 结论」（引导，不是向导锁）；结论入口 sticky 固定在左栏底部。
4. **形态分层消灭重复**：发现清单（总览，可展开条目）/ 全文与代码上下文（明细）/ 处置（结论）；已发布收成一行元信息。
5. **只呈现已核实事实与待执行行动**：初筛风险、未验证项、丢弃计数等中间态不再展示；面板上唯一的判定在结论页（总览页无 verdict）。

## 3. 非目标

- 不改数据流水线与 prompt：初筛、取证、未验证字段照常产生，本设计只停止其展示；结论结构、判定口径（decision 枚举、questions、覆盖率门禁、blocker 准入）与发现归一（正典清单、五元组、同型聚合、clean-report 结构化）留给下一期（见 §12）。
- 不做初筛与文件发现的自动去重——等正典清单（见 §12）。
- 历史轮次只读语义、乐观锁、`review_*` 对话工具不变；`index.js` / `llm.js` 零改动。
- 不做向导式强制流程。

## 4. 状态模型：derivePhase

位置：`client.core.js`，纯函数，可单测。

```js
derivePhase(review, staleInfo)
// → { phase, progress, nextAction, version }
```

phase 枚举与判定优先级（先命中先得）：

| phase | 条件 | 总览徽标 | 结论徽标 |
|---|---|---|---|
| `error` | `review.status === 'error'` | 审查失败 | 未生成 |
| `reviewing` | `status === 'reviewing'` | 审查中… | 未生成 |
| `concluding` | `review.concluding` 非空（优先于 analyzing） | 汇总中… | 汇总中… |
| `analyzing` | `isAnalyzing(review.analyzing)` | 分析 {done}/{total}（+{failed}） | 未生成 |
| `ready` | 报告完成且无结论版本 | 审查完成 | 未生成 |
| `concluded` | 有最新结论、未发布、未过期 | 审查完成 | v{n} 草稿 |
| `concluded-stale` | 未发布且 `staleInfo` 非空 | 审查完成 | v{n} 已过期 |
| `published` | 当前版本已发布 | 审查完成 | v{n} 已发布 |
| `published-stale` | 已发布且 `staleInfo` 非空 | 审查完成 | v{n} 已发布 · 有更新 |

- `progress`：analyzing → `{done, total, failed}`；其余 null。
- `nextAction`：ready→`conclude`；concluded→`publish`；concluded-stale / published-stale→`regenerate`；published（选中版本已发布且无新变化）→`append`；analyzing 且手动模式→`analyzeAll`；reviewing / concluding / error→null。
- `review.status === 'error'` 时 PhaseBar 不渲染（`client.views.js:726-733` 已有全屏错误态），error 仅用于徽标。
- 输入字段缺失时安全回退为 `ready`，不抛错。

## 5. 左栏导航（FilesPane）

- `mode` 扩展：`'overview' | 'file' | 'conclusion'`（`client.workspace.js:92`）。
- 总览入口（47-57 行）保留，右侧加徽标（derivePhase 过程侧文案）。
- **结论入口新增**：sticky 固定在 aside 底部（flex 列布局的固定尾区，不随文件列表滚动）。位置在文件列表之后表达「先看文件、后做结论」的流程顺序；固定在视口底部保证大 PR 时可达。右侧徽标（结论侧文案）。点击 `setMode('conclusion')`。
- 文件行不变（FileRow 严重度圆点保留）。
- `applyRoundSelection`（`client.core.js:128-133`）：选历史轮次后落到**结论页**（`mode: 'conclusion'`）。历史轮持久化的只有 conclusions / delta / feedback / publishedIds（`roundsOf`，`client.core.js:105-122`），改动概述不保证存在，结论才是历史的主产物。

## 6. 页面

### 6.1 总览页 OverviewPage（OverviewPanel 裁剪）

页面上只呈现两类内容：**已核实的事实**与**待人执行的行动**。初筛风险、未验证项、丢弃计数等流水线中间态不再展示（数据照常产生，只是不流出展示；流水线重整归归一期，见 §12）。

当前轮内容顺序：

1. （round ≥ 2）**上轮处置记录**：FeedbackBlock（作者回复：每条回复 + 状态 + 理由）+ DeltaBlock（已修复 / 仍未解决）。二者是**审查对话的记录**（我们提的意见兑现了没有），不是代码现状，归过程页置顶，作为本轮验证的输入；记录完整不拆分。「仍未解决」的条目本身会作为 blocker 重新出现在本轮结论，结论页不再重复记录区。
2. **改动概述**：`report.summary` 纯事实陈述（做了什么、规模、涉及模块）。**不展示 `report.verdict`**——初筛判定不再以任何形式出现在总览页，面板上唯一的判定在结论页。
3. **审查发现 FindingList（新组件，本页的主干）**：消费现有 `props.fileFindings`，唯一清单：
   - 行 = severity pill（issues）或 [建议] tag（suggestions）+ `file:line` 链接 + point 单行截断（CSS ellipsis，title 属性存全文）；
   - **行可展开**：展开显示 point 完整文本与位置，并提供「在明细页查看上下文」链接（`onOpenFile(file, line)`，`line = 0` 时只显示文件路径）；
   - 排序：block > suggest > 建议；同级按 file path 字典序、再按 line 升序；
   - 区块标题 `审查发现 · {n}`；空态「未发现问题」——与完备性行联动，覆盖完成后即读作「审过且干净」；
   - 五元组结构（问题 / 位置 / 影响 / 修法 / 证据）与同型问题聚合（「同型 × N」）归归一期，本页是其宿主。
4. **审查完备性**：`已分析 {done}/{total}` + 失败数 + 负结果行 `其中 {clean} 个文件核查后未发现问题`（clean = 分析完成且 issues 为空的文件数，phase 1 可由现有数据算出）。让「无发现」有含义：审过且干净，而不是没审到。

移除：650-700 行的全文聚合区块；RiskList（初筛风险）与 UnverifiedBlock（未验证项）及其计数行；ConclusionBlock / PublishedBlock / 版本选择器（全部移至结论页）。

footer：仅 ready 阶段挂 [生成结论]（避免跳页）；发布按钮不在此页。

历史轮次：FeedbackBlock + DeltaBlock（该轮的处置记录，完整保留在此页）+ 改动概述占位「历史轮次不含改动概述」。

### 6.2 明细页 FileDetailPanel

不变。

### 6.3 结论页 ConclusionPage（新）

当前轮内容顺序：

1. 结论卡：复用 ConclusionBlock 主体（verdict pill + summary + metaLine + 版本选择 headerExtra）。
2. 必改 blockers / 建议 suggestions / 下一步 nextSteps（现有渲染与反馈状态 pill 不动——pill 是条目的最小元数据，发布时审查员需要据此避免重复报告已认可/已修复的条目；回复原文与跨轮对照在总览页）。**每条 blocker / suggestion 带「纳入发布」开关**（复用现有 selection 通道 `selectionIncludeIds` / `buildPublishBody`）：发布装配在读结论的同时完成，不推迟到发布那一刻的弹窗。
3. **评论预览（折叠区）**：按当前勾选实时生成的 markdown（lazy 加载，复用现有 preview 接口），标题「评论预览」。面板条目与评论条目本就 1:1（`commentItems`），这里是「发出去会是什么样」的持续可见出口，含截断与附录的收缩结果。
4. 已发布记录 PublishedBlock 紧凑化：每条一行 `v{version} · {时间} · 查看评论`（有 url 时为链接）+ 未发布 tag；**不再渲染条目全文**。
5. footer（沿用 actionsBridge / `overviewFooter`）：[生成结论 / 重新生成] + [发布 / 追加评论] + stale / coverage 提示，仅本页挂载。发布使用页面当前勾选；发布弹窗退化为**最终确认**——markdown 全文 + 冲突提示（已发布 / 发布中），勾选区从弹窗移除。

结论页只回答**代码现状**（能不能合、要改什么）与其**执行**（装配发布、发没发）；审查对话的记录（作者回复、跨轮对照）在总览页，不在本页。

未生成时（ready）：空状态卡「结论待生成」+ 覆盖率（已分析 x/y + coverageIncomplete 提示）+ [生成结论]。不展示初筛参考——verdict 只在结论生成后出现在结论页。
汇总中（concluding）：ConcludingProgress（阶段进度 + 取消，复用 `client.conclusion.js:369`）。

历史轮次：RoundMeta + 历史结论版本（只读，沿用 versionsOf / VersionSelector）+ PublishedBlock；无动作区（`overviewFooter` 现有 null 逻辑不变）。该轮的处置记录（Feedback / Delta）在总览页的历史视图。

### 6.4 PhaseBar（新组件）

- 位置：review 详情区顶部，三页共用一行。
- 内容：`第 {round} 轮 · {phase 文案}{progress}`；只读，无按钮。
- reviewing 全屏态（723-725 行）保留；PhaseBar 在该态与 error 态下不渲染。

## 7. 交互规则

1. **结论生成完成后自动切换**：phase 从 concluding 迁移到 concluded / concluded-stale / published 时，仅当 `mode === 'overview'` 且选中当前轮 → `setMode('conclusion')`。用户在明细页时不打断，仅徽标更新。取消汇总（concluding → ready）不切换。
2. 新提交开启新一轮：mode 不强制变化；处于结论页而该轮结论未生成时显示空状态卡。
3. 历史轮次：三页均只读；动作区不挂载。
4. narrow / sidebarPane 布局：sticky 结论入口同样生效（aside 内固定尾区）。

## 8. 渲染与文件改动清单

- `client.core.js`：+`derivePhase`（导出）；`applyRoundSelection` 落点改 `'conclusion'`；CSS 增补（PhaseBar、sticky 尾区、FindingList 行与展开、徽标）。
- `client.views.js`：FilesPane（结论入口 + 双徽标）；OverviewPanel 拆为 OverviewPage + ConclusionPage；+FindingList（可展开发现清单）；+完备性行；+PhaseBar；删除 650-700 行聚合区与 RiskList / UnverifiedBlock 展示。
- `client.conclusion.js`：PublishedBlock 紧凑化；`overviewFooter` 增加 `page` 参数按页挂载动作与提示；ConclusionBlock / conclusionMetaLine / ConcludingProgress 复用；结论条目加「纳入发布」开关与评论预览折叠区。
- `client.preview.js`：发布弹窗退化为最终确认（markdown 全文 + 冲突提示），移除勾选区；勾选迁移至结论页条目（复用 `selectionIncludeIds` / `buildPublishBody` 通道）。
- `client.workspace.js`：mode 扩展与装配、PhaseBar 挂载、自动切换 effect；`reviewAskContext` 与输入框 scope（`client.workspace.js:113`、222 行）把 `'conclusion'` 视为 PR 级（同 overview）。
- `client.hooks.js`：无结构性改动（派生 memo 放 workspace 层）。
- `client.i18n.js`：新增 key（§9）。
- `index.js` / `llm.js`：零改动。

## 9. i18n 新增 key（中英两套）

`conclusionNav`（结论）、`digestTitle`（改动概述）、`findingList`（审查发现）、`findingListEmpty`（未发现问题）、`findingOpenContext`（在明细页查看上下文）、`completenessTitle`（审查完备性）、`completenessClean`（其中 {clean} 个文件核查后未发现问题）、`conclusionPendingCard`（结论待生成）、`publishInclude`（纳入发布）、`publishPreviewSection`（评论预览）、`historyNoReport`（历史轮次不含改动概述）、`badgeReviewing`（审查中…）、`badgeAnalyzing`（分析 {done}/{total}）、`badgeAnalyzingFailed`（+{failed} 失败）、`badgeConcluding`（汇总中…）、`badgeConclusionNone`（未生成）、`badgeConclusionDraft`（v{n} 草稿）、`badgeConclusionStale`（v{n} 已过期）、`badgePublished`（v{n} 已发布）、`badgePublishedStale`（v{n} 已发布 · 有更新）、`badgeError`（审查失败）。

## 10. 测试策略（`tests/client.test.js`）

- `derivePhase`：全枚举、优先级（concluding > analyzing）、stale 叠加（concluded-stale / published-stale）、字段缺失回退。
- `applyRoundSelection`：历史轮落结论页。
- FindingList：行渲染（severity tag、file:line、单行截断）、展开（完整 point + 「在明细页查看上下文」链接）、排序、空态「未发现问题」。
- 总览页不渲染：RiskList、UnverifiedBlock、`report.verdict` pill、discarded 计数行。
- 完备性行：覆盖率与 clean 计数正确（clean = 分析完成且 issues 为空的文件数）。
- 总览页处置记录：round ≥ 2 渲染 FeedbackBlock + DeltaBlock（顺序：回复在前、对照在后）；round 1 不渲染。
- FilesPane：结论入口存在且位于 sticky 尾区容器；徽标文案随 phase 变化。
- ConclusionPage：ready 空状态（覆盖率 + 生成按钮，无初筛参考行）；concluding 进度；**不渲染** DeltaBlock / FeedbackBlock（条目状态 pill 除外）；历史轮只读无动作（RoundMeta + 历史结论 + Published）；PublishedBlock 紧凑渲染（不含条目全文）。
- 发布装配：条目「纳入发布」开关更新 selection；评论预览按勾选 lazy 刷新；发布请求携带页面当前勾选；弹窗不含勾选区、保留 markdown 全文与冲突提示。
- 自动切换：concluding → concluded 且 mode=overview 触发；mode=file 不触发；取消不触发。
- `overviewFooter`：publish 仅结论页；conclude 在总览页（仅 ready）与结论页；stale / coverage 提示归结论页。
- 现有测试保持通过（`pnpm stamp:check` + `node --test`）。

## 11. 风险

- **自动切换打断阅读**：仅在总览页触发，明细页不打断。
- **sticky 尾区在窄栏 / 极小高度**：CSS 设最小高度；极端时保徽标、省文字。
- **review 快照字段演进**：`derivePhase` 只读现有字段并对缺失回退，纯函数用单测锁定。
- **回归面**：`review_update_overview` 等对话工具更新后的刷新依赖现有 state 流；本设计只移动渲染位置，不改数据契约。
- **评论预览刷新时机**：勾选变化防抖；concluding / publishing / preview 刷新中禁用重取，避免过期 markdown 被当作最新装配。
- **行号锚点**：FindingList 依赖 `issue.line > 0`；为 0 时只显示文件路径（与现状一致）。

## 12. 与后续工作的衔接

- **明细与初筛归一**（#26 实机验证后确立的后续方向）：总体初筛与逐文件两条链路目前仅在 `buildConcludePrompt` 合流；归一目标是产出一份核实过的**正典清单**（每条含问题 / 位置 / 影响 / 修法 / 证据五元组），candidates 全部进取证，产出只有两个去向——进清单或丢弃。取证失败的高影响疑点转为结论的**行动项**（「需人工确认 X，缺 Y 证据」），绝不以「存疑列表」形式展示；低影响直接丢弃。归一后本页「审查发现」直接消费正典条目，结论页条目引用同一批 id，三处重复彻底消失；clean-report 同期结构化（高风险路径的核查记录，如「支付回调幂等路径：核查了 X、Y，未发现问题」），替换完备性行的文件计数。
- **判定口径**（decision 枚举、覆盖率门禁、blocker 准入、questions）：落在本次拆好的结论页；结论卡与条目区即其宿主，届时只需替换数据来源与判定函数，不再动布局。

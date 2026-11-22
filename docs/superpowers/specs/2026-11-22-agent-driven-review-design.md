# Agent 驱动的审查架构设计

日期：2026-11-22
状态：设计草案，待评审
关联：取代 `2026-11-21-review-investigation-chain-design.md`（直连 LLM 的 JSON 调查链）

## 1. 背景与问题

当前实现的根本问题不是提示词不够好，而是**把 LLM 当成无状态的 JSON-RPC 端点**：

- 报告、逐文件分析、复审都通过 `ctx.llm.stream` 一次性调用完成，输出靠提示词里的 JSON 契约约束。
- 为了弥补模型不遵守契约，又加入 confidence 打分、verifier、refuter、收口重试和大量 `normalize*`。这些机制在模型换一种输出形状时仍然会失败。
- PR #35 的真实失败（`调查未能闭合：final 必须是对象`）就是这一类：模型把终稿写在顶层而不是 `final` 字段里，整轮直接 error。
- 宿主的 Agent 循环、工具、上下文、压缩和判断力完全没有参与审查；插件只是把模型当作文本分类器。

宿主已经提供了需要的 Agent 能力（DSH 0.2.2-rc.1 及以上，最终以阶段 0 原型验证为准）：

```ts
interface AgentHandle { agent: Agent; dispose(): Promise<void> }

interface Agent {
  readonly id: SessionId
  readonly session: Session
  readonly status: 'idle' | 'running'
  cancel(cause: AgentCancelCause, options?: CancelOptions): void
  whenIdle(): Promise<void>
  followup(message: UserMessage): void
  steer(message: UserMessage): void
  inject(message: UserMessage): void
}

ctx.agents.create(options: CreateAgentOptions): Promise<AgentHandle>
// CreateAgentOptions: meta（cwd、agentPreset、…）、agentOptions（provider/model/reasoningEffort/maxTokens）、signal、setup
```

因此审查应当由一个**独立 Agent 会话**完成，而不是插件自己发一轮轮 JSON 请求。

## 2. 目标

1. 审查由插件创建的独立 Agent 会话执行；Agent 使用宿主的文件读取、搜索、压缩等能力，不再由插件 `ctx.llm.stream` 直接审查。
2. 输出格式由**工具参数 schema** 承担：逐文件 `review_update_analysis`，总体 `review_update_report`，结论 `review_update_conclusion`。不再有「请输出 JSON」的提示词契约。
3. 逐文件明细就是 Agent 的写入记录；插件只负责归一化、持久化和面板组装。没有第二次「总体分析」调用、没有 confidence、没有 verifier/refuter 打分。
4. 自动触发保留：轮询到新提交时自动创建 Agent 审查；新 head 取消/替换旧 Agent。
5. 失败与覆盖率是显式的：Agent 失败 → 本轮 error；文件未分析 → 本轮 incomplete 并列出缺口；不静默通过，不产生「未验证项」。

## 3. 非目标

- 不重新设计平台 provider、PR 数据模型、评论发布、结论历史、面板导航。
- 不引入第二个模型调用链；不保留直连 LLM 的审查 fallback。
- 不做跨 PR 的共享 Agent 或长期记忆；一轮一个隔离会话。
- 不把 Agent 的内部推理或工具 transcript 持久化到审查缓存；只保留工具写入的结果与运行状态。

## 4. 总体架构

```
轮询新 head / 用户点“审查”
  → ReviewRunner.start(record)
      → ctx.agents.create({ meta: { cwd, agentPreset: 'pr-review-readonly' },
                            agentOptions: { provider, model, reasoningEffort } })
      → agent.followup(审查任务消息)
      → await agent.whenIdle()
      → 覆盖率检查（review_list_files vs review_update_analysis 写入）
      → 缺口 ≤ N 次 follow-up 补齐；仍缺 → incomplete + 缺口清单
      → handle.dispose()
  ← 面板订阅 record 变化，实时渲染
```

### 4.1 组件

- **ReviewRunner**（`index.js` 内或独立 `review-runner.js`）
  - 拥有 Agent 句柄、轮次、取消和覆盖率逻辑。
  - 不调用 `ctx.llm.stream`；只调用 `ctx.agents` 和 Agent 方法。
  - 每个 PR 同一时间最多一个 run；跨 PR 沿用现有并发上限（默认 2）。
- **Agent 预设** `pr-review-readonly`
  - 由插件的 `cordis.patch.yml` 插入一条 `@deepseek-ai/dsh-agent-preset` 声明；用户可在预设编辑器中覆盖/复制。
  - 只暴露读文件与搜索，不允许写入、编辑、patch、bash、终端。
- **任务提示**（`prompts/review-task.md` 或代码内模板）
  - 一次性用户消息，描述审查流程与写回工具；不要求 JSON 输出。
- **现有 `review_*` 工具**
  - 读取：`review_get`、`review_list_files`、`review_get_file`、`review_get_diff`、`review_get_analysis`。
  - 写入：`review_update_analysis`、`review_update_report`、`review_update_conclusion`。
  - 禁止：`review_publish`、`review_conclude`（直连 LLM 的旧入口）由 runner 拒绝；发布仍只能由用户在主对话触发。

### 4.2 Agent 创建

```js
const handle = await ctx.agents.create({
  meta: { cwd: workspaceCwd, agentPreset: settings.reviewAgentPreset },
  agentOptions: {
    provider: selection.provider,
    model: selection.model,
    reasoningEffort: settings.reasoningEffort,
    maxTokens: settings.reviewAgentMaxTokens,
  },
  ...(signal === undefined ? {} : { signal }),
});
const { agent } = handle;
agent.followup({
  id: randomUUID(),
  role: 'user',
  source: { kind: 'user' },
  content: [{ type: 'text', text: taskPrompt }],
});
await agent.whenIdle();
```

- `meta.cwd` 必须是工作区根目录，文件读/搜索才指向被审查仓库。
- `agentPreset` 由配置 `reviewAgentPreset` 指定，默认 `pr-review-readonly`；预设缺失时明确报错并给出安装指引，不静默退回默认预设。
- 模型选择沿用 `provider`/`model`/`reasoningEffort`；未配置时取宿主默认模型。
- 取消：外部取消 → `agent.cancel`；轮次被替换 → `handle.dispose()`；等待用 `whenIdle()`。

### 4.3 只读预设

```yaml
- insert:
    - id: preset-pr-review-readonly
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: pr-review-readonly
        order: 50
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: |
                你是资深代码审查员，只读地审查当前 PR。只通过 review_* 工具写回结论；不修改工作区、不发布评论。
          - id: tool-fs
            name: '@deepseek-ai/dsh-tool-fs'
            config:
              write: false
              edit: false
              applyPatch: false
              readImage: false
          - id: tool-fs-search
            name: '@deepseek-ai/dsh-tool-fs-search'
          - id: compaction
            name: cordis:group
            group: true
            isolate:
              compaction: true
              toolResultPruner: true
            config:
              - id: compaction-basic
                name: '@deepseek-ai/dsh-compaction-basic'
              - id: tool-result-pruner
                name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
                config:
                  thresholdChars: 8192
                  headChars: 4096
                  tailChars: 1024
          - id: tool-todo
            name: '@deepseek-ai/dsh-tool-todo'
```

- 不含 `tool-bash`/`tool-pwsh`、`write`/`edit`/`apply_patch`，从工具面消除“审查 Agent 改代码”的能力。
- `persona` 固定在预设里，任务消息只描述本轮 PR 与流程。
- `review_*` 是 Host 全局工具；阶段 0 必须验证它们在自定义预设的 Agent 中可见。如果不可见，改为在预设内注册一组只读的 review 写回工具（不让预设直接暴露发布工具）。
- 预设不提供安全沙箱；`tool-fs` 的读权限继承 `ctx.fs` 后端/工作区沙箱。阶段 0 验证读边界，避免读到工作区外的敏感文件。

## 5. 任务与输出契约

### 5.1 任务消息

一条用户消息，包含：

- 平台/仓库/PR 编号、本轮 head SHA、工作目录。
- 审查流程：`review_get` → `review_list_files` → 对每个文件 `review_get_file`/`review_get_diff` + 读相关调用方/测试 → `review_update_analysis`。
- 写回要求：每条 issue 只写一个核心问题、带 severity 与行号；没有问题就写空 issues 并说明。
- 汇总：全部文件完成后 `review_update_report`；最后 `review_update_conclusion`。
- 只读约束：不修改代码、不发布评论、不询问用户（无人值守）；无法读取的文件写进 summary，不猜测。
- 覆盖率要求：`review_list_files` 的每个文件都必须出现在 `review_update_analysis`；未完成时明确列出。

**不要求最终 JSON 回复**。Agent 的自然语言回复不进入持久化；结果只认工具调用。

### 5.2 写回工具

沿用现有工具：

| 工具 | 用途 |
|---|---|
| `review_update_analysis` | 单文件 verdict/summary/logic/walkthrough/changes/issues |
| `review_update_report` | 总体 verdict/summary/risks/order/focus |
| `review_update_conclusion` | 最终结论（blockers/suggestions/nextSteps） |

新增/调整：

- `review_update_conclusion` 允许 Agent 写入初始结论，标记 `source: 'agent'`；人工编辑仍走原路径。
- `review_publish` 与 `review_conclude`（旧直连 LLM 入口）在 runner 的 Agent 会话中被拒绝：工具检查调用方 session id 是否为当前 review run 的 Agent，若是则返回明确错误。
- 删除 `refuted` 审计字段与相关 normalizer；直连 LLM 链路的 `unverified`/`raised`/`discarded` 一并移除。

### 5.3 面板组装

- 明细页：直接渲染 `record.explanations`（工具写入）。
- 总览页：渲染 `record.report`；若 Agent 未写 report，则由插件从逐文件结果确定性地组装一份摘要（verdict 取最严重项、risks 取各文件 block 项、summary 拼接文件摘要），并标记「自动汇总」。不再调用模型补写。
- 结论页：渲染 Agent 写入的 conclusion；缺失时显示 incomplete，不自动生成。
- 所有写回仍走现有 `revision` 冲突保护，runner 不需要绕过。

## 6. 完成、覆盖率与失败

### 6.1 覆盖率

- `review_list_files` 的变更文件集合为全集。
- `review_update_analysis` 成功写入的文件为已分析集合。
- `whenIdle` 后计算缺口；缺口非空时发送一次 compact follow-up（列出文件与“继续分析”），最多 `reviewCoverageRetries` 次（默认 2）。
- 仍缺 → 本轮 `status: 'incomplete'`，记录 `missingFiles`，面板显示明确清单；不发布、不生成结论。用户可重试（新 Agent）或手动补分析。

### 6.2 失败

- Agent 创建失败、运行失败、`whenIdle` 失败 → 本轮 `error`，保存可读错误；重试创建新 Agent。
- 工具写入冲突（revision 过期）→ 当前文件写完失败；runner 在 follow-up 中要求重新 `review_get` 后继续；不静默丢结果。
- 取消/新 head：`cancel`/`dispose` 旧 Agent，清空本轮状态，按新 head 创建新 run。

### 6.3 自动触发

- 轮询到新 head → 自动 `start`；已有 run → 取消并替换。
- `autoReview` 控制是否自动开始整轮；`autoAnalyze` 控制初始任务是否包含逐文件分析（关闭时只写 report，逐文件分析由用户点开文件触发 follow-up 或新的单文件 run）。
- 跨 PR 并发沿用现有上限；同一 PR 永不并行两个 run。

## 7. 安全与权限

- 只读预设从工具面禁止写入/编辑/patch/bash；安全边界不依赖提示词。
- `review_publish` 在 runner 会话中拒绝；发布仍由用户在主对话明确触发。
- Agent 读取的是工作区文件；`ctx.fs` 沙箱/权限根沿用宿主配置。阶段 0 验证无法读到工作区外路径。
- PR 代码是不可信输入：persona + 任务消息要求把代码当数据；工具面禁止写操作，降低提示注入的破坏面。
- 不把 Agent transcript、工具输入或文件内容写入审查缓存；只保存工具写回的结构化结果。

## 8. 数据模型

- 保留：`record.files`、`record.explanations`、`record.report`、`record.conclusion`、轮次历史、发布记录。
- 删除：`unverified`、`raised`、`discarded`、`refuted`（均为直连 LLM 链路的产物）。
- 新增：`record.run = { agentSessionId, startedAt, finishedAt, status: 'running'|'incomplete'|'error', missingFiles: [] }`，用于面板状态与恢复；不持久化模型输出。
- 旧缓存：恢复时归一化；未知旧字段忽略，不报错。

## 9. 测试策略

- **单元**：`ReviewRunner` 用 fake `ctx.agents`/`AgentHandle`：
  - 创建参数（cwd、preset、model）正确；
  - follow-up 文本包含 PR、head、流程与覆盖要求；
  - `whenIdle` 后缺口补齐；超过重试 → incomplete；
  - Agent 失败 → error；取消/新 head → dispose 旧句柄；
  - 已全覆盖 → done，不额外 follow-up。
- **预设**：解析 `cordis.patch.yml`，断言 `pr-review-readonly` 存在、`tool-fs` 的 write/edit/applyPatch 为 false、无 bash。
- **工具**：现有 `review_*` 工具测试保留；新增 runner 会话拒绝 `review_publish`/`review_conclude` 的测试。
- **组装**：无 report 时确定性摘要；缺 conclusion → incomplete。
- **无真实模型调用**：测试不经过 `ctx.llm.stream`。
- 回归：现有 provider/工具/UI 测试；删除直连 LLM 链路的测试。

## 10. 迁移与删除

实现分支从 `origin/main`（`c293083`，investigation-chain 之前）新建，不携带被替代的直连 LLM 调查链。该链上与本设计无关的 UI/工具修复如需保留，按提交逐个 cherry-pick，不以整条链为基础重写。PR #35 关闭并标注为被本设计取代。

1. **阶段 0（原型，不合并）**：创建 Agent + 只读预设 + 单文件 `review_update_analysis` 写回；验证工具可见、读边界、自动触发可创建 Agent。记录宿主版本与 API 实际形状。
2. **阶段 1**：ReviewRunner + 预设 + 任务提示 + 覆盖率；手动「开始审查」接入；保留旧链路但不再默认使用。
3. **阶段 2**：自动轮询/新 head 替换/并发/取消；UI 状态（running/incomplete/error）；面板实时刷新。
4. **阶段 3**：删除 `runInvestigation`/`refuteFindings`/`evidence.js`/investigation prompts/confidence/verifier/refuter/相关 normalizer；删除 `refuted/unverified` 数据；配置改为 `reviewAgentPreset`/`reviewCoverageRetries`/`reviewAgentMaxTokens`；版本 0.5.0。
5. **阶段 4**：全量测试、README/设计文档、PR。

## 11. 风险与待验证

- **宿主版本/API**：文档来自 DSH master；当前宿主版本是否暴露 `ctx.agents.create`、`whenIdle`、`agentPreset` 需要阶段 0 实测。若不可用，退回 `ctx.subagents.startActivation` 或用户驱动，而非继续直连 LLM。
- **工具可见性**：全局 `review_*` 在自定义预设的 Agent 中是否可见；不可见时在预设内提供一组只读写回工具。
- **上下文成本**：33 个文件的会话可能触发压缩；预设必须挂 compaction，任务消息要求逐文件处理、及时写回。
- **模型遵循度**：Agent 可能提前 idle 或漏文件；覆盖率检查与有限 follow-up 是兜底，但不保证完美。宁可显式 incomplete，不静默通过。
- **读边界/密钥**：只读预设仍能读取工作区文件；需要验证 `ctx.fs` 沙箱，必要时用 fs 观察策略或受限根。
- **自动触发与用户打扰**：独立 Agent 会话不打断主对话，但会消耗模型配额；保留并发上限与可关闭的 autoReview。

## 12. 验收标准

1. 审查链路中不再有 `ctx.llm.stream` 调用（grep 为零；chat/feedback 等非审查路径除外）。
2. 一轮审查由独立 Agent 会话完成；逐文件、report、conclusion 均通过 `review_*` 工具写回。
3. 自动轮询能创建 Agent；新 head 取消/替换旧 Agent；同一 PR 不并行两个 run。
4. 只读预设禁止 write/edit/patch/bash；runner 会话无法调用 `review_publish`。
5. 覆盖率缺口显式进入 incomplete 并列出文件；Agent 失败进入 error；没有未验证项、没有静默通过。
6. 面板实时显示工具写入；不存在 JSON 输出解析、confidence、verifier/refuter。
7. 旧缓存可加载；`unverified/raised/discarded/refuted` 不再出现在运行时数据中。
8. `npm test` 全绿；README/设计与版本同步。

# Agent 驱动的审查 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用独立 Agent 会话（`ctx.agents.create`）替代插件内直连 LLM 的 JSON 审查流水线；审查结果通过 `review_*` 工具写回，插件只负责触发、覆盖率、持久化与展示。

**Architecture:** 每个 PR 一次审查 run：插件创建只读预设的 Agent，`followup` 一条任务消息，`whenIdle` 后按变更文件清单检查覆盖率，缺口用有限 follow-up 补齐；仍有缺口则本轮 incomplete。没有 `ctx.llm.stream` 审查调用、没有 JSON 契约、没有 confidence/verifier/refuter。

**Tech Stack:** DSH Agent 服务（`ctx.agents`）、declarative agent preset、现有 `review_*` 工具与持久化、Node `node:test`。

**Spec:** `docs/superpowers/specs/2026-11-22-agent-driven-review-design.md`

---

## 阶段 0：宿主能力原型（gate，不合并）

**目的**：验证宿主版本真的提供 `ctx.agents.create`、`whenIdle`、`agentPreset`，以及只读预设能看到 `review_*` 与读/搜索工具。任何一项不成立，停下来改 spec，不要继续写生产代码。

### Task 0.1：从 origin/main 建分支并加探针

**Files:**
- Create: `review-probe.js`
- Modify: `index.js`（临时探针路由，验证后删除）

- [ ] **Step 1: 建分支**

```bash
git fetch origin
git checkout -b feat/agent-review origin/main
```

- [ ] **Step 2: 写探针模块**

`review-probe.js`：

```js
/**
 * Temporary feasibility probe: create a read-only review agent and let it write one file.
 * Delete this module and its route after the spike.
 */
import { randomUUID } from 'node:crypto';

export function userMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  };
}

export async function probeAgent(ctx, { cwd, preset, provider, model, prompt }) {
  const handle = await ctx.agents.create({
    sessionId: randomUUID(),
    meta: { cwd, agentPreset: preset },
    agentOptions: { provider, model, reasoningEffort: 'off', maxTokens: 8000 },
  });
  try {
    const { agent } = handle;
    agent.followup(userMessage(prompt));
    await agent.whenIdle();
    return { agentId: agent.id, status: agent.status };
  } finally {
    await handle.dispose();
  }
}
```

- [ ] **Step 3: 加临时路由**

在 `index.js` 的 `apply` 里加 `inject` 项 `'agents'`，并加一个仅开发用的路由：

```js
route(`${PREFIX}/probe-agent`, {
  POST: async (req, res) => {
    const body = parseBody(await readBoundedBody(req));
    const selection = resolveSelection(ctx, settings);
    const result = await probeAgent(ctx, {
      cwd: state.workspaceCwd || process.cwd(),
      preset: String(body?.preset ?? 'pr-review-readonly'),
      provider: selection.provider,
      model: selection.model,
      prompt: String(body?.prompt ?? '请读取 README.md，总结它的用途；不要修改任何文件。'),
    });
    sendJson(res, 200, { ok: true, ...result });
  },
});
```

- [ ] **Step 4: 手工验证（在 DSH 中）**

1. 在 preset 编辑器确认 `pr-review-readonly` 可用（先按 spec §4.3 手工建一个临时预设）。
2. 启动应用，调用 `POST /pr-review-api/probe-agent`。
3. 观察 Agent 是否成功执行、`status` 是否回到 `idle`、是否能读到 README。
4. 检查 Agent 的工具目录：`read`/`glob`/`grep` 存在；`write`/`edit`/`apply_patch`/`bash` 不存在；`review_get`/`review_update_analysis` 存在。
5. 让 Agent 调用 `review_update_analysis` 写一条测试分析，确认面板实时刷新。
6. 记录：宿主版本、实际 create options 形状、UserMessage source 是否接受 `{kind:'user'}`、全局 review 工具是否可见、读边界。

- [ ] **Step 5: 删除探针**

验证通过后删除 `review-probe.js`、临时路由与 `agents` inject 之外的临时改动（保留 `agents` inject 供后续使用）。把验证结论写进 spec 的「风险与待验证」。

**Gate：** 若 `ctx.agents.create` 不可用、或 `review_*` 在只读预设不可见、或只读工具无法限制写操作 → 停止，回到设计评审。

---

## 阶段 1：ReviewRunner 与只读预设

### Task 1.1：只读预设

**Files:**
- Modify: `cordis.patch.yml`
- Test: `tests/prompts.test.js` 或新增 `tests/preset.test.js`

- [ ] **Step 1: 在 `cordis.patch.yml` 插入预设声明**

在现有 `insert` 列表中追加：

```yaml
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

- [ ] **Step 2: 测试预设内容**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the bundle ships a read-only review preset', () => {
  const text = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  assert.match(text, /id: pr-review-readonly/);
  assert.match(text, /name: '@deepseek-ai\/dsh-tool-fs'/);
  assert.match(text, /write: false/);
  assert.match(text, /edit: false/);
  assert.match(text, /applyPatch: false/);
  assert.doesNotMatch(text, /dsh-tool-bash/);
});
```

- [ ] **Step 3: 运行并提交**

Run: `node --test tests/preset.test.js`
Expected: PASS。

```bash
git add cordis.patch.yml tests/preset.test.js
git commit -m "feat(review): ship a read-only review preset"
```

### Task 1.2：任务提示

**Files:**
- Create: `prompts/review-task.md`
- Create: `prompts/review-continue.md`
- Modify: `prompts.js`
- Test: `tests/llm.test.js`（或 `tests/prompts.test.js`）

- [ ] **Step 1: 任务提示**

`prompts/review-task.md`：

```markdown
你在审查 PR #{{pullNumber}}（{{repo}}），本轮 head {{headSha}}。工作目录：{{cwd}}。

你是审查者，不是实现者。只读相关代码，不修改文件，不发布评论，不询问用户。

流程：

1. 调用 `review_get` 读取本轮审查数据与 revision。
2. 调用 `review_list_files` 获取全部变更文件。
3. {{fileAnalysisStep}}
   - path 必须是变更文件清单中的路径，revision 用最近一次 `review_get` 返回的值。
   - issues 每条只写一个核心问题，写清影响与修法；severity 只有 block / suggest。
   - 没有发现问题时 issues 写空数组，并在 summary 里说明依据。
4. 全部文件完成后，调用 `review_update_report` 写总体 verdict / summary / risks / order / focus。
5. 最后调用 `review_update_conclusion` 写本轮结论（blockers / suggestions / nextSteps）。

覆盖率要求：`review_list_files` 返回的每个文件都必须有 `review_update_analysis`。无法读取的文件写进 summary；不要猜测。

只通过上述工具写回结果；最终自然语言回复不需要包含 JSON。
```

`prompts/review-continue.md`：

```markdown
继续本轮审查。以下文件还没有 `review_update_analysis`：

{{missingFiles}}

请逐个读取并写回；完成后再次调用 `review_update_report` / `review_update_conclusion` 更新总体结果。不要修改代码、不要发布评论。
```

- [ ] **Step 2: 注册提示**

`prompts.js` 的 `PROMPT_NAMES` 加入 `'review-task'`, `'review-continue'`。

- [ ] **Step 3: 测试渲染**

```js
test('the review task prompt states the read-only workflow', () => {
  const text = renderPrompt('review-task', {
    pullNumber: 35, repo: 'acme/demo', headSha: 'abc', cwd: '/repo',
    fileAnalysisStep: '对每个文件：review_get_file / review_get_diff；分析后 review_update_analysis。',
  });
  assert.match(text, /review_list_files/);
  assert.match(text, /review_update_analysis/);
  assert.match(text, /必须.*review_update_analysis/);
  assert.doesNotMatch(text, /输出 JSON/);
});
```

- [ ] **Step 4: 提交**

```bash
git add prompts/review-task.md prompts/review-continue.md prompts.js tests/llm.test.js
git commit -m "feat(review): add the agent review task prompts"
```

### Task 1.3：ReviewRunner

**Files:**
- Create: `review-runner.js`
- Modify: `index.js`（inject `'agents'`、配置、手动入口）
- Test: `tests/review-runner.test.js`

- [ ] **Step 1: 写失败测试（fake agents）**

`tests/review-runner.test.js`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { createReviewRunner, userMessage } from '../review-runner.js';

function fakeRecord(files) {
  return {
    number: 1,
    headSha: 'abc',
    pull: { number: 1, repo: 'acme/demo', platform: 'github', title: 't' },
    files: files.map((path) => ({ path })),
    explanations: new Map(),
    run: null,
  };
}

function fakeCtx(onFollowup) {
  const created = [];
  const disposed = [];
  return {
    created,
    disposed,
    agents: {
      async create(options) {
        created.push(options);
        const agent = {
          id: options.sessionId,
          status: 'idle',
          followup(message) {
            onFollowup(message, agent, options);
          },
          async whenIdle() {},
        };
        return { agent, async dispose() { disposed.push(options.sessionId); } };
      },
    },
  };
}

test('the runner creates a read-only review agent and sends the task prompt', async () => {
  const record = fakeRecord(['src/a.js']);
  const prompts = [];
  const ctx = fakeCtx((message, agent) => {
    prompts.push(message.content[0].text);
    record.explanations.set('src/a.js', { status: 'done', explanation: { issues: [] } });
  });
  const runner = createReviewRunner({
    ctx,
    settings: { reviewAgentPreset: 'pr-review-readonly', reviewCoverageRetries: 2 },
    record,
    selection: { provider: 'p', model: 'm' },
    cwd: '/repo',
  });
  await runner.start();
  assert.equal(ctx.created.length, 1);
  assert.equal(ctx.created[0].meta.agentPreset, 'pr-review-readonly');
  assert.equal(ctx.created[0].meta.cwd, '/repo');
  assert.match(prompts[0], /review_list_files/);
  assert.equal(record.run.status, 'done');
  assert.deepEqual(record.run.missingFiles, []);
  assert.equal(ctx.disposed.length, 1);
});

test('missing files trigger bounded follow-ups, then incomplete', async () => {
  const record = fakeRecord(['src/a.js', 'src/b.js']);
  const prompts = [];
  const ctx = fakeCtx((message) => { prompts.push(message.content[0].text); });
  const runner = createReviewRunner({
    ctx,
    settings: { reviewAgentPreset: 'pr-review-readonly', reviewCoverageRetries: 1 },
    record,
    selection: { provider: 'p', model: 'm' },
    cwd: '/repo',
  });
  await runner.start();
  assert.equal(prompts.length, 2, 'task + one coverage follow-up');
  assert.match(prompts[1], /src\/a\.js/);
  assert.equal(record.run.status, 'incomplete');
  assert.deepEqual(record.run.missingFiles, ['src/a.js', 'src/b.js']);
  assert.equal(ctx.disposed.length, 1);
});

test('agent errors mark the run error and still dispose', async () => {
  const record = fakeRecord(['src/a.js']);
  const ctx = fakeCtx(() => { throw new Error('agent failed'); });
  const runner = createReviewRunner({
    ctx,
    settings: { reviewAgentPreset: 'pr-review-readonly', reviewCoverageRetries: 2 },
    record,
    selection: { provider: 'p', model: 'm' },
    cwd: '/repo',
  });
  await runner.start();
  assert.equal(record.run.status, 'error');
  assert.match(record.run.error, /agent failed/);
  assert.equal(ctx.disposed.length, 1);
});

test('userMessage uses the user source and a unique id', () => {
  const a = userMessage('x');
  const b = userMessage('x');
  assert.equal(a.role, 'user');
  assert.deepEqual(a.source, { kind: 'user' });
  assert.notEqual(a.id, b.id);
});
```

- [ ] **Step 2: 实现 `review-runner.js`**

```js
/**
 * One agent-driven review run: create a read-only agent, send the task, wait for idle,
 * and close coverage gaps with bounded follow-ups. No direct LLM calls.
 */
import { randomUUID } from 'node:crypto';

import { renderPrompt } from './prompts.js';

export function userMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  };
}

function taskPrompt(record, cwd, analyzeFiles = true) {
  return renderPrompt('review-task', {
    pullNumber: record.pull?.number ?? record.number,
    repo: record.pull?.repo ?? '',
    headSha: record.headSha ?? '',
    cwd,
    fileAnalysisStep: analyzeFiles
      ? '对每个文件：`review_get_file` / `review_get_diff` 获取 PR head 内容；按需读取调用方、定义、测试；分析后调用 `review_update_analysis` 写回。'
      : '本轮只写总体报告，不逐文件分析；用户点开文件时再分析。',
  });
}

function continuePrompt(missing) {
  return renderPrompt('review-continue', { missingFiles: missing.map((path) => `- ${path}`).join('\n') });
}

function missingFilesOf(record) {
  return (Array.isArray(record.files) ? record.files : [])
    .map((file) => file.path)
    .filter((path) => {
      const entry = record.explanations?.get(path);
      return entry === undefined || entry.status !== 'done' || entry.explanation === null || entry.explanation === undefined;
    });
}

export function createReviewRunner({ ctx, settings, record, selection, cwd, onChange }) {
  let handle = null;
  let cancelled = false;

  const changed = () => {
    if (typeof onChange === 'function') onChange(record);
  };

  const dispose = async () => {
    const current = handle;
    handle = null;
    if (current !== null) await current.dispose();
  };

  const start = async () => {
    cancelled = false;
    record.run = { agentSessionId: null, startedAt: Date.now(), finishedAt: 0, status: 'running', missingFiles: [], error: null };
    changed();
    try {
      handle = await ctx.agents.create({
        sessionId: randomUUID(),
        meta: { cwd, agentPreset: settings.reviewAgentPreset ?? 'pr-review-readonly' },
        agentOptions: {
          provider: selection.provider,
          model: selection.model,
          reasoningEffort: settings.reasoningEffort,
          maxTokens: settings.reviewAgentMaxTokens ?? 8000,
        },
      });
      const { agent } = handle;
      record.run.agentSessionId = agent.id;
      changed();
      agent.followup(userMessage(taskPrompt(record, cwd, settings.autoAnalyze !== false)));
      await agent.whenIdle();
      if (cancelled) return;
      let missing = missingFilesOf(record);
      const retries = Number.isInteger(settings.reviewCoverageRetries) ? settings.reviewCoverageRetries : 2;
      for (let attempt = 0; attempt < retries && missing.length > 0; attempt += 1) {
        record.run.missingFiles = missing;
        agent.followup(userMessage(continuePrompt(missing)));
        await agent.whenIdle();
        if (cancelled) return;
        missing = missingFilesOf(record);
      }
      record.run.missingFiles = missing;
      record.run.status = missing.length > 0 ? 'incomplete' : 'done';
      if (missing.length > 0) record.run.error = `审查未完成：${missing.length} 个文件未分析`;
      changed();
    } catch (error) {
      record.run.status = 'error';
      record.run.error = error instanceof Error ? error.message : String(error);
      changed();
    } finally {
      record.run.finishedAt = Date.now();
      changed();
      await dispose();
    }
  };

  const cancel = async () => {
    cancelled = true;
    await dispose();
  };

  return { start, cancel, dispose };
}
```

- [ ] **Step 3: 配置与入口**

`index.js`：
- `inject` 增加 `'agents'`。
- `DEFAULTS` 增加 `reviewAgentPreset: 'pr-review-readonly'`, `reviewCoverageRetries: 2`, `reviewAgentMaxTokens: 8000`。
- 在报告/逐文件入口调用 `createReviewRunner(...).start()`；先只接手动「开始审查」，自动轮询在阶段 2 接。
- `serializeReview` 输出 `record.run`（不含模型内容）。

- [ ] **Step 4: 运行测试**

Run: `node --test tests/review-runner.test.js`
Expected: PASS（4 tests）。

- [ ] **Step 5: 提交**

```bash
git add review-runner.js index.js tests/review-runner.test.js
git commit -m "feat(review): run reviews through a dedicated agent session"
```

---

## 阶段 2：自动触发、生命周期与 UI

### Task 2.1：自动轮询接入

**Files:** Modify `index.js`; Test `tests/index.test.js`（fake `ctx.agents`）

- [ ] **Step 1: 维护每个 PR 的 runner**

```js
const runners = new Map(); // number → runner

async function startAgentReview(record) {
  const existing = runners.get(record.number);
  if (existing !== undefined) await existing.cancel();
  const selection = resolveSelection(ctx, settings);
  const runner = createReviewRunner({
    ctx,
    settings,
    record,
    selection,
    cwd: evidenceWorkspace() || state.workspaceCwd || process.cwd(),
    onChange: () => scheduleSave(),
  });
  runners.set(record.number, runner);
  try {
    await runner.start();
  } finally {
    if (runners.get(record.number) === runner) runners.delete(record.number);
  }
}
```

- [ ] **Step 2: 替换触发点**

`startReview`/轮询发现新 head 时调用 `startAgentReview(record)`；`autoReview` 关闭时不自动调用。新 head 先 `cancel()` 旧 runner。`autoAnalyze: false` 由 `taskPrompt(..., false)` 体现（只写报告）。

- [ ] **Step 3: 并发**

跨 PR 并发沿用现有上限（默认 2）；同一 PR 的 `runners` 保证不并行。新增测试：同一 PR 连续两次触发只保留一个 Agent；`cancel` 会 `dispose` 旧句柄。

- [ ] **Step 4: 运行并提交**

Run: `node --test tests/index.test.js --test-name-pattern="agent review"`（新增测试）。
Expected: PASS。

```bash
git add index.js tests/index.test.js
git commit -m "feat(review): trigger agent reviews on new heads"
```

### Task 2.2：UI 状态

**Files:** Modify `index.js`（`serializeReview`）、`client.views.js`、`client.i18n.js`、`client.hooks.js`；Test `tests/client.test.js`

- [ ] **Step 1: 序列化 run 状态**

在 `serializeReview` 的 review 对象中加入：

```js
run: record.run === null || record.run === undefined ? null : { ...record.run },
```

`run` 只包含 `agentSessionId`、`startedAt`、`finishedAt`、`status`、`missingFiles`、`error`；不含模型输出或 transcript。

- [ ] **Step 2: 面板状态**

- running：显示「Agent 审查中」与已分析文件数（从 `explanations` 计算）。
- incomplete：显示「审查未完成」+ `missingFiles` 列表；提供「重试」按钮，触发新的 run。
- error：显示 `run.error`；提供「重试」。
- done：现有总览/结论页不变。

i18n 新增中英两套：`reviewRunning`、`reviewIncomplete`、`reviewMissingFiles`、`reviewRunError`、`reviewRetry`。

- [ ] **Step 3: 测试**

`tests/client.test.js`：构造带 `run.status` 的 review，断言三种状态渲染与重试回调；`run.status: 'running'` 时不渲染结论页的空结论。

- [ ] **Step 4: 提交**

```bash
git add index.js client.views.js client.i18n.js client.hooks.js tests/client.test.js
git commit -m "feat(client): show agent review progress and gaps"
```

### Task 2.3：安全边界

**Files:** Modify `index.js`（`review_publish` / `review_conclude` 的 execute）；Test `tests/index.test.js`

- [ ] **Step 1: 拒绝 runner 会话的发布/结论重生成**

```js
function isReviewRunnerAgent(record, agent) {
  return record?.run?.agentSessionId !== null
    && record?.run?.agentSessionId !== undefined
    && agent?.id === record.run.agentSessionId;
}
```

在 `review_publish` 与 `review_conclude` 的 `execute` 开头：

```js
if (isReviewRunnerAgent(record, exec.agent)) {
  throw toolError(TOOL_ERROR.conflict, '审查 Agent 只负责写回审查结果，不能发布评论或重新生成结论。');
}
```

- [ ] **Step 2: 测试**

模拟 `exec.agent.id === record.run.agentSessionId` 时两个工具都抛 `CONFLICT`；主对话（不同 id）保持原行为。

- [ ] **Step 3: 提交**

```bash
git add index.js tests/index.test.js
git commit -m "fix(review): keep the review agent read-only at the tool boundary"
```

---

## 阶段 3：删除直连 LLM 审查链路

### Task 3.1：代码清理

- [ ] 删除 `runInvestigation` / `refuteFindings` / `evidence.js` / `investigation.js` 中仅服务于直连链路的校验（保留 `finalOf` 等？不保留，全部删除）。
- [ ] 删除 investigation prompts：`investigate-step.md`、`investigation-protocol.md`、`refute.md`、`refuter.md`、`verify.md`、`verifier.md` 及 verify-language fragments。
- [ ] 删除 confidence/verifier/refuter/normalize 相关代码与测试。
- [ ] 删除 `unverified`/`raised`/`discarded`/`refuted` 数据字段与序列化逻辑。
- [ ] 删除 `autoAnalyze` 的旧后台批处理实现，改为 runner 的 scope 选项。
- [ ] 保留 chat/feedback/conclude 中与审查结果编辑相关的非直连 LLM 路径；如果 `review_conclude` 依赖直连 LLM，改为 agent 写结论（阶段 1 已新增写回）。

### Task 3.2：配置与文档

- [ ] Config/DEFAULTS：`reviewAgentPreset`、`reviewCoverageRetries`、`reviewAgentMaxTokens`；删除 `investigation*`/`refute*`。
- [ ] 版本 0.5.0；README 中英、cordis bundle、发布白名单。
- [ ] 设计文档与 plan 的关联。

### Task 3.3：测试与验收

- [ ] `npm test` 全绿。
- [ ] grep：审查链路无 `ctx.llm.stream`；无 `unverified/refuted/investigation` 运行时残留。
- [ ] 真实应用：自动轮询启动 Agent、逐文件写回、覆盖率补齐、incomplete/error、发布拒绝。
- [ ] PR。

---

## 验收清单

- [ ] 一轮审查由一个独立 Agent 会话完成，插件不直接调用审查模型。
- [ ] 只读预设禁止写入/编辑/patch/bash；runner 会话不能发布。
- [ ] 逐文件、report、conclusion 均通过 `review_*` 工具写回。
- [ ] 覆盖率缺口 → incomplete 并列出文件；Agent 失败 → error；没有未验证项。
- [ ] 自动触发保留，新 head 取消旧 run。
- [ ] 旧 JSON 流水线、confidence、verifier/refuter 全部删除。
- [ ] `npm test` 全绿，README/版本同步。

# 提示词外置为 Markdown 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `llm.js` 与 `index.js` 里的静态提示文本全部外置为 `prompts/*.md`，用统一加载器组装；动态数据通过 `{{key}}` 注入，缺值即抛错。

**Architecture:** 新增 `prompts.js` 提供 `loadPrompt` / `fragment` / `renderPrompt`。每个任务/系统提示词是一份 Markdown 文件；共享段落放在 `prompts/fragments/`。builder 只准备动态值并调用 `renderPrompt`，解析函数（`normalize*` / `partition*`）完全不动。

**Tech Stack:** Node.js ESM、`node:fs`、`node:test`、pnpm。

**Spec:** `docs/superpowers/specs/2026-11-21-prompt-markdown-externalization-design.md`

---

## 文件结构

**新建**

- `prompts.js` — 加载、渲染、占位符校验
- `prompts/*.md` — 10 份任务/系统提示词
- `prompts/fragments/*.md` — 10 份共享片段
- `tests/prompts.test.js` — 加载器与文件完整性测试

**修改**

- `llm.js` — 3 个 system prompt 函数 + 6 个 builder
- `index.js` — `review-data` 注入段改为加载 Markdown
- `tests/index.test.js` — 记录并断言注入段
- `package.json` — `files` 增加 `prompts.js` 与 `prompts/**/*.md`

**不改**

- 所有 `normalize*` / `partition*` / `calibrateVerdict` / `mergeConclusion` 等解析逻辑
- `callModel` 的取消、超时、重试语义
- 运行时快照 `reviewSnapshotText()` 与 `systemPrompt.context`

---

## Task 1: 提示词加载器

**Files:**
- Create: `prompts.js`
- Create: `tests/prompts.test.js`
- Modify: `package.json`（`files`）

- [ ] **Step 1: 写失败测试**

创建 `tests/prompts.test.js`：

```js
/**
 * Prompt loader contract: files ship with the package, every placeholder is strict, and
 * dynamic values may contain `{{` without tripping the template check.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { sep } from 'node:path';

import {
  FRAGMENT_NAMES,
  PROMPT_NAMES,
  fragment,
  loadPrompt,
  renderPrompt,
  renderTemplate,
} from '../prompts.js';

test('prompts: every prompt and fragment file loads and is non-empty', () => {
  for (const name of PROMPT_NAMES) assert.notEqual(loadPrompt(name).trim(), '', name);
  for (const name of FRAGMENT_NAMES) assert.notEqual(fragment(name).trim(), '', name);
});

test('prompts: renderPrompt fills placeholders and rejects missing values', () => {
  const text = renderPrompt('reviewer', { reviewFramework: 'FRAME', languageRule: 'LANG' });
  assert.match(text, /FRAME/);
  assert.match(text, /LANG/);
  assert.throws(
    () => renderPrompt('reviewer', { reviewFramework: 'FRAME' }),
    /Missing prompt value: reviewer#languageRule/,
  );
});

test('prompts: dynamic values containing braces do not trip the template check', () => {
  const text = renderPrompt('reviewer', { reviewFramework: '{{not-a-placeholder}}', languageRule: '' });
  assert.match(text, /\{\{not-a-placeholder\}\}/);
  assert.doesNotMatch(text, /\{\{languageRule\}\}/);
});

test('prompts: renderTemplate rejects malformed placeholders and nullish values', () => {
  assert.throws(
    () => renderTemplate('a {{ bad }} b', 'x', {}),
    /Malformed placeholder: x/,
  );
  assert.throws(
    () => renderTemplate('{{a}}', 'x', { a: undefined }),
    /Missing prompt value: x#a/,
  );
  assert.throws(
    () => renderTemplate('{{a}}', 'x', { a: null }),
    /Missing prompt value: x#a/,
  );
  assert.equal(renderTemplate('pre{{a}}post', 'x', { a: '' }), 'prepost');
});

test('prompts: every Markdown file on disk is covered by the test lists', () => {
  const root = new URL('../prompts/', import.meta.url);
  const files = readdirSync(root, { recursive: true })
    .map((file) => file.split(sep).join('/'))
    .filter((file) => file.endsWith('.md'));
  const top = files
    .filter((file) => !file.includes('/'))
    .map((file) => file.slice(0, -3))
    .sort();
  const fragments = files
    .filter((file) => file.startsWith('fragments/'))
    .map((file) => file.slice('fragments/'.length, -3))
    .sort();
  const stray = files
    .filter((file) => file.includes('/') && !file.startsWith('fragments/'))
    .sort();
  assert.deepEqual(top, [...PROMPT_NAMES].sort());
  assert.deepEqual(fragments, [...FRAGMENT_NAMES].sort());
  assert.deepEqual(stray, []);
});

test('prompts: package files ship prompts.js and the Markdown tree', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.files.includes('prompts.js'));
  assert.ok(pkg.files.includes('prompts/**/*.md'));
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test tests/prompts.test.js`

Expected: FAIL，`Cannot find module '../prompts.js'`。

- [ ] **Step 3: 实现加载器**

创建 `prompts.js`：

```js
/**
 * Prompt loading and rendering.
 *
 * Every static prompt text lives in `prompts/*.md`. Builders pass the dynamic values and
 * this module substitutes them. A missing value — absent, `null`, or `undefined` — is an
 * error, not an empty string: a prompt that silently loses its diff or its candidates is
 * worse than a failed review. An explicit empty string is valid.
 *
 * All prompt and fragment files are read once at import time, so a missing file fails fast
 * instead of surfacing on the first request.
 */

import { readFileSync } from 'node:fs';

const cache = new Map();

function read(relativePath) {
  if (!cache.has(relativePath)) {
    cache.set(relativePath, readFileSync(new URL(relativePath, import.meta.url), 'utf8').trimEnd());
  }
  return cache.get(relativePath);
}

/** Prompt file stems; `reviewer` loads `prompts/reviewer.md`. */
export const PROMPT_NAMES = [
  'reviewer', 'reviewer-compact', 'verifier',
  'report', 'explain', 'verify', 'chat', 'conclude', 'feedback',
  'review-data',
];

/** Shared fragment file stems; `language-zh` loads `prompts/fragments/language-zh.md`. */
export const FRAGMENT_NAMES = [
  'review-framework', 'previous-verdicts',
  'language-zh', 'language-en', 'language-compact-zh', 'language-compact-en',
  'verify-language-zh', 'verify-language-en',
  'chat-file-contract', 'chat-overview-contract',
];

/** Load one task/system prompt by file stem (`report` → `prompts/report.md`). */
export function loadPrompt(name) {
  return read(`./prompts/${name}.md`);
}

/** Load one shared fragment by file stem (`language-zh` → `prompts/fragments/language-zh.md`). */
export function fragment(name) {
  return read(`./prompts/fragments/${name}.md`);
}

// Read every shipped file now so a missing one fails at import time.
for (const name of PROMPT_NAMES) loadPrompt(name);
for (const name of FRAGMENT_NAMES) fragment(name);

const PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g;

/**
 * Fill `{{key}}` placeholders in `template`; a missing or nullish key throws, and a
 * leftover `{{` that is not a valid placeholder throws as malformed.
 */
export function renderTemplate(template, name, values) {
  const given = values !== null && typeof values === 'object' ? values : {};
  // Check the template, not the result: dynamic values may legitimately contain `{{`.
  if (template.replace(PLACEHOLDER, '').includes('{{')) {
    throw new Error(`Malformed placeholder: ${name}`);
  }
  return template.replace(PLACEHOLDER, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(given, key)) {
      throw new Error(`Missing prompt value: ${name}#${key}`);
    }
    const value = given[key];
    if (value === null || value === undefined) {
      throw new Error(`Missing prompt value: ${name}#${key}`);
    }
    return String(value);
  }).trimEnd();
}

/** Fill `{{key}}` placeholders in a named prompt; a missing value throws. */
export function renderPrompt(name, values) {
  return renderTemplate(loadPrompt(name), name, values);
}
```

- [ ] **Step 4: 创建临时占位文件以运行测试**

Task 2 起会把它们逐个替换成正式内容。现在创建最小占位文件：

```bash
mkdir -p prompts/fragments
printf 'PLACEHOLDER {{reviewFramework}} {{languageRule}}\n' > prompts/reviewer.md
for name in reviewer-compact verifier report explain verify chat conclude feedback review-data; do
  printf 'PLACEHOLDER\n' > "prompts/$name.md"
done
for name in review-framework previous-verdicts language-zh language-en language-compact-zh language-compact-en verify-language-zh verify-language-en chat-file-contract chat-overview-contract; do
  printf 'PLACEHOLDER\n' > "prompts/fragments/$name.md"
done
```

`prompts/reviewer.md` 必须同时包含 `{{reviewFramework}}` 与 `{{languageRule}}`，否则 Step 1 的渲染断言会失败。

- [ ] **Step 5: 把提示词文件加入打包清单**

在 `package.json` 的 `files` 数组中 `"llm.js",` 之后加入：

```json
    "prompts.js",
    "prompts/**/*.md",
```

- [ ] **Step 6: 运行测试确认通过**

Run: `node --test tests/prompts.test.js`

Expected: 6 个测试全部 PASS。

- [ ] **Step 7: 提交**

```bash
git add prompts.js prompts/ package.json tests/prompts.test.js
git commit -m "feat(prompts): add the Markdown prompt loader"
```

---

## Task 2: 共享片段与三个 system prompt

**Files:**
- Create: `prompts/fragments/review-framework.md`
- Create: `prompts/fragments/language-zh.md`
- Create: `prompts/fragments/language-en.md`
- Create: `prompts/fragments/language-compact-zh.md`
- Create: `prompts/fragments/language-compact-en.md`
- Create: `prompts/reviewer.md`
- Create: `prompts/reviewer-compact.md`
- Create: `prompts/verifier.md`
- Modify: `llm.js:158-204`（`REVIEW_FRAMEWORK`、`languageRule` 与三个 system 函数）
- Modify: `prompts.js`（`FRAGMENT_NAMES` 增加两个 compact 片段）
- Modify: `tests/llm.test.js`（compact 测试增加一条 `quoted text verbatim` 断言）

- [ ] **Step 1: 建立测试基线**

Run: `node --test tests/llm.test.js`

Expected: 全部 PASS。后续每步只允许在此基线上保持全绿。

- [ ] **Step 2: 写 `prompts/fragments/review-framework.md`**

```markdown
## 严重度

严重度只有两档：

- block（阻塞）：必须修复才能合并，例如安全漏洞、数据丢失、功能损坏、明确的逻辑错误。
- suggest（建议）：可以不修，例如缺失测试、抽象不当、错误处理薄弱、命名或风格问题。

## 审查维度

从六个维度看代码（按 PR 的文件清单与 diff 推断技术栈，不要预设框架）：

1. 正确性：是否匹配 PR 描述与需求；空值与边界、错误路径、状态流转是否完整（多个布尔位拼一个逻辑状态时应改为显式状态机）；用户数据/配置格式变更是否走迁移。
2. 可读性：命名与控制流是否直接；嵌套是否过深；注释解释 WHY 而不是复述 WHAT。
3. 架构与一致性：是否遵循仓库既有模式；跨层契约（类型、协议、注册表、配置）是否同步；是否有单次使用的包装层或过早抽象。
4. 安全：外部输入是否校验；是否引入注入/XSS 面；密钥与令牌是否硬编码；权限与沙箱边界是否被绕过。
5. 性能：循环内同步 IO 或逐条查询；N+1；列表是否缺分页或无界加载。
6. 跨平台：路径分隔符与大小写、换行符与编码、平台分支是否三态齐全且有兜底。

常见缺陷专项：静默吞错（空 catch 或丢掉错误）必须指出；多布尔位状态堆积；格式变更未迁移；无分页/无界加载。

## 证据要求

报阻塞前先自问是否已有证据（调用方、基类或 wrapper、常量、schema 与数据库约束、测试）；只依据给出的 diff 与上下文，不臆测未提供的文件。无法验证的怀疑不得写进 issues/risks：候选问题放进 concerns，并在 evidenceNeeds 里写明还需要哪份证据；复审时按证据给出 confidence，证据不足的写进 unverified。

## 调用链

判断改动影响前，先列举「谁调用它、它调用了谁、哪些状态被读写」；列不出的写进 evidenceNeeds，不得据此报 block。

## 误报排除

命中任一条就不要输出：本次改动之前就存在的问题；看起来像 bug 实际不是；资深工程师不会在评审里提的挑剔；linter、类型检查或编译器能直接抓到的（缺 import、类型错误、格式）；泛泛的质量问题（缺测试、缺文档、泛泛的安全担忧），除非仓库规范明确要求；被 lint-ignore 之类注释显式压制的问题；明显是本次有意为之的行为变更；落在本次未修改行上的真实问题。

## 输出要求

每条问题写清「问题 + 影响 + 修法」，一条只写一个核心问题；不要凑数，也不要只写「建议检查 X」。

## 化简审查

先做一轮化简审查：重复分支、兼容回退、单次使用的包装层、过早抽象是否可删；规模超标时提出拆分（软阈值：单函数 > 80 行、组件 > 300 行、文件 > 500 行、嵌套 > 3 层）。不理解旧代码为何存在前不要建议删除。
```

- [ ] **Step 3: 写语言片段**

`prompts/fragments/language-zh.md`：

```markdown
所有输出（代码标识符、路径与原文引用除外）使用简体中文。
```

`prompts/fragments/language-en.md`：

```markdown
Write every human-readable field in English; keep code identifiers, paths and quoted code verbatim.
```

`prompts/fragments/language-compact-zh.md`（compact 专用，保留原来的「原文引用」措辞）：

```markdown
所有输出（代码标识符与原文引用除外）使用简体中文。
```

`prompts/fragments/language-compact-en.md`（compact 专用，保留 `quoted text`）：

```markdown
Write every human-readable field in English; keep code identifiers and quoted text verbatim.
```

- [ ] **Step 4: 写三个系统提示词正文**

`prompts/reviewer.md`：

```markdown
你是一名资深代码审查员与代码分析者，负责审查拉取请求；技术栈以 PR 的实际文件与 diff 为准。

{{reviewFramework}}

分析代码逻辑时要说清来龙去脉：这段代码原来做什么、现在改成怎样、被谁调用、影响哪些数据与状态。

不要讨论与本次改动无关的既有问题，除非这次改动会触发或放大它。

输出格式：任务要求 JSON 时，只输出一个 JSON 对象，不要 markdown 标题、代码块或任何解释。

{{languageRule}}
```

`prompts/reviewer-compact.md`：

```markdown
你是一名资深代码审查员，只做结构化判定，不重新审查代码。

严重度只有两档：block（必须修复才能合并）与 suggest（可以不修）。

只依据给出的审查意见与评论回复判断，不臆测未提供的信息；不确定时选最保守的状态并写明依据。

{{languageRule}}
```

`prompts/verifier.md`：

```markdown
你是一名代码审查裁判：只根据给出的候选问题与证据判断，不重新审查代码，不臆测证据之外的内容。

证据不足时给低置信度并写明缺什么，不要为了凑数给出高分。

{{languageRule}}
```

- [ ] **Step 5: 改 `llm.js` 的导入与三个 system 函数**

在文件顶部 `import { heuristicOrder, diffExcerpts } from './diff.js';` 之后加：

```js
import { fragment, renderPrompt } from './prompts.js';
```

删除 `REVIEW_FRAMEWORK` 常量（`llm.js:153-175`）。在 `languageOf` 之后加入语言选择 helper，并把三个函数替换为：

```js
/** Output-language rule; the compact prompt keeps its narrower "quoted text" wording. */
function languageRule(language, compact = false) {
  const suffix = language === 'en' ? 'en' : 'zh';
  return fragment(compact ? `language-compact-${suffix}` : `language-${suffix}`);
}

/** The shared system prompt, with the output language the comment language asks for. */
function reviewerSystem(language) {
  return renderPrompt('reviewer', {
    reviewFramework: fragment('review-framework'),
    languageRule: languageRule(language),
  });
}

/**
 * The subset a short structured task needs. The feedback pass only maps replies onto four
 * states; the six axes and the simplification pass would add tokens without changing the answer.
 */
function compactSystem(language) {
  return renderPrompt('reviewer-compact', {
    languageRule: languageRule(language, true),
  });
}

/**
 * The verifier's system prompt: it is a judge, not a second reviewer. Scoring is the only job,
 * and the evidence block is its only source of truth.
 */
function verifierSystem(language) {
  return renderPrompt('verifier', {
    languageRule: languageRule(language),
  });
}
```

`verifierSystem` 当前位于 `llm.js:367-379`；`compactSystem` 当前位于 `llm.js:191-204`。删除旧实现，保留函数名与调用点。

- [ ] **Step 6: 运行测试**

Run: `node --test tests/llm.test.js`

Expected: 全部 PASS，尤其是：

- `prompts: one stack-agnostic review framework...`
- `the feedback prompt uses the compact system...`
- `the verifier prompt carries candidates and evidence...`

- [ ] **Step 7: 提交**

```bash
git add llm.js prompts/
git commit -m "refactor(prompts): load the shared framework and system prompts from Markdown"
```

---

## Task 3: 总体初筛 prompt

**Files:**
- Create: `prompts/report.md`
- Modify: `llm.js` 的 `buildReportPrompt`（当前 `llm.js:224-270`）
- Test: `tests/llm.test.js`

- [ ] **Step 1: 写 `prompts/report.md`**

```markdown
平台：{{platform}}；仓库：{{repo}}

PR #{{pullNumber}}：{{title}}

作者：{{author}}；分支：{{headRef}} → {{baseRef}}

规模：{{changedFiles}} 个文件，+{{additions}} / -{{deletions}}

{{bodySection}}

## 变更文件清单

{{fileLines}}

## 启发式入口排序（可修正）

{{order}}

## 变更内容（每文件截断，用于判断入口与总体风险）

{{excerpts}}

请输出严格 JSON（不要输出 JSON 以外的解释）：

```json
{
  "verdict": "block | suggest | pass",
  "summary": "2-4 句总体评价：这个 PR 做了什么、实现是否匹配 PR 描述、风险在哪、能否合并；没有阻塞项时明确写「未发现阻塞项」",
  "concerns": [{ "severity": "block | suggest", "file": "路径", "point": "问题 + 影响 + 修法（一条只写一个核心问题）", "line": 0 }],
  "evidenceNeeds": [{ "concern": 1, "kind": "callers | definition | callee | schema | test | file", "path": "文件路径", "symbol": "符号名", "reason": "为什么需要它" }],
  "order": [{ "file": "路径", "reason": "为什么先看它（它是什么入口、被谁调用、为什么值得先读）" }],
  "focus": [{ "file": "路径", "point": "审查这个文件时重点看什么" }]
}
```

concerns 是候选问题，不是最终结论：每条都会经过取证复审；没有问题就输出空数组。

evidenceNeeds 必须覆盖每个 concern（concern 是 1-based 序号）：kind=file 指向改动文件本身也算取证；仍然无法核实的，复审会把它放进未验证项。

先核对改动是否匹配 PR 描述与验收标准；描述与实现不一致时写进 concerns。

order 必须覆盖大部分变更文件，按「入口/协议层 → 核心逻辑 → 数据与存储 → UI → 测试 → 文档」排列；文件路径必须与清单完全一致。
```

- [ ] **Step 2: 替换 `buildReportPrompt`**

```js
/** Report prompt: one call over the whole pull request, with per-file truncation. */
export function buildReportPrompt(pull, files, diffFiles, config) {
  // The report prompt is the only one that receives the settings object, so the language
  // arrives as `commentLanguage` rather than through the builder options.
  const language = normalizeLanguage(config?.commentLanguage);
  const maxChars = config?.maxDiffCharsPerFile ?? 14000;
  const reportChars = Math.min(maxChars, 2200);
  const order = heuristicOrder(diffFiles, files);
  const fileLines = files
    .slice(0, FILE_LIST_LIMIT)
    .map((file) => `- ${file.path} | ${file.status} | +${file.additions} / -${file.deletions}`)
    .join('\n');
  const excerpts = diffExcerpts(diffFiles, order, reportChars, 120_000);
  const user = renderPrompt('report', {
    platform: platformLabel(pull.platform),
    repo: pull.repo,
    pullNumber: pull.number,
    title: pull.title,
    author: pull.author,
    headRef: pull.headRef,
    baseRef: pull.baseRef,
    changedFiles: pull.changedFiles,
    additions: pull.additions,
    deletions: pull.deletions,
    bodySection: pull.body.trim() === '' ? '' : `PR 描述：\n${pull.body.slice(0, 6000)}`,
    fileLines,
    order: order.join('\n'),
    excerpts,
  });
  return { system: reviewerSystem(language), messages: [{ role: 'user', content: [{ type: 'text', text: user }] }], maxTokens: 16000, timeoutMs: 600_000 };
}
```

- [ ] **Step 3: 运行测试**

Run: `node --test tests/llm.test.js`

Expected: 全部 PASS，尤其是 `prompts: name the real platform...`、`the report prompt keeps the output contract...`、`the review framework states the exclusion list...`。

- [ ] **Step 4: 提交**

```bash
git add llm.js prompts/report.md
git commit -m "refactor(prompts): load the report prompt from Markdown"
```

---

## Task 4: 逐文件分析 prompt

**Files:**
- Create: `prompts/explain.md`
- Create: `prompts/fragments/previous-verdicts.md`
- Modify: `llm.js` 的 `buildExplainPrompt`（当前 `llm.js:282-365`）
- Test: `tests/llm.test.js`

- [ ] **Step 1: 写 `prompts/fragments/previous-verdicts.md`**

```markdown
  "previousVerdicts": [{ "index": 1, "status": "fixed | still-open", "point": "still-open 时：当前代码的表述（可省略沿用原文）", "line": 0, "severity": "block | suggest", "suggestion": "可省略沿用原建议" }],
```

- [ ] **Step 2: 写 `prompts/explain.md`**

```markdown
平台：{{platform}}；仓库：{{repo}}

PR #{{pullNumber}}：{{title}}（{{headRef}} → {{baseRef}}）

正在审查文件：{{filePath}}（{{fileStatus}}，+{{additions}} / -{{deletions}}）{{focus}}

{{reportLine}}

## 该文件的 diff

{{diff}}

{{fileContentSection}}

{{baselineSection}}

分析要求：结合完整文件说明相关函数/类的职责、被谁调用、与周边代码的关系；不要只描述 diff 片段。

请输出严格 JSON。分析要详细、可读、面向要理解这次改动的人：

```json
{
  "summary": "一句话概括这个文件的改动",
  "logic": "整体逻辑分析（只写全局）：这个文件原来做什么 → 现在整体变成怎样 → 函数/模块的上下游调用关系 → 数据与状态怎么流动 → 关键边界条件与错误路径。不要复述 walkthrough 中各段落的具体改动细节。篇幅随改动规模自适应：大改动 400-800 字，小改动 200-400 字即可，不要为凑字数填充。",
  "walkthrough": [{ "title": "段落/函数名 + 一句话作用（如「cleanupInterruptedMacInstall：启动时清理中断残留」），不要写 hunk 编号", "detail": "用人话讲清：这段做了什么、为什么需要它、影响谁、有什么风险；2-5 句；不要复述 logic 的整体链路，不要把审查意见写进来", "hunk": 1, "context": { "label": "所属函数/类名", "startLine": 230, "endLine": 275 } }],
  "changes": "逐类说明具体变化：新增了什么、删除了什么、重命名/移动了什么",
{{previousVerdictsField}}
  "concerns": [{ "severity": "block | suggest", "point": "问题 + 影响（一条只写一个核心问题）", "suggestion": "具体修法（可选；没有明确修法就省略，不要把修法写进 point）", "line": 0 }],
  "evidenceNeeds": [{ "concern": 1, "kind": "callers | definition | callee | schema | test | file", "path": "文件路径", "symbol": "符号名", "reason": "为什么需要它" }],
  "verdict": "block | suggest | pass"
}
```

logic 只写全局、walkthrough 只写局部，两者不得互相复述；walkthrough 按 diff 规模 1-3 条（改动很小时 1 条即可）、按 diff 的 hunk 顺序覆盖主要改动；hunk 是该条分析对应的 diff hunk 序号（从 1 开始，按 @@ 出现顺序计数），不确定写 0；title 禁止出现「hunk」「第 N 段」这类编号；detail 面向第一次读这段代码的人，术语首次出现要顺带解释，问题与建议写到 concerns，不要写进 walkthrough；

context 用于在 diff 里展开这段改动所属的完整函数/类：label 写函数/类名，startLine/endLine 是它在上面「完整内容」里的起止行号（用给出的行号，1-based，跨语言通用）；该段改动不在任何函数/类内（如 Markdown、配置文件）或你不确定时，context 写 null。

同时看测试：这次改动需要补充或更新哪些测试；如果只给了实现、没有相关测试，在 summary 里点明这个测试空白。

如果这次改动引入重复分支、兼容回退或单次使用的包装层，在 concerns 里用 suggest 指出可化简之处；纯改进点（补测试、抽公共 helper 等没有具体缺陷的）也必须作为 severity 为 suggest 的 concern 输出，修法写进 suggestion。

纯改进点（不阻碍合并）的 point 以「可选：」或「nit：」开头，与真正的非阻塞缺陷区分开。

verdict 语义：block=存在应先修复的缺陷，不可合并；suggest=可合并但有保留意见或非阻塞问题；pass=可按原样合并（concerns 均为可选改进时用 pass）。

concerns 为空数组表示没有发现问题；point 只写问题与影响，不要把修法混进 point；line 用 diff 中的新文件行号，不确定写 0。

evidenceNeeds 必须覆盖每个 concern（concern 是 1-based 序号）：kind=file 指向本文件也算取证；无法核实的由复审放进未验证项，不要写进 point。
```

- [ ] **Step 3: 替换 `buildExplainPrompt`**

保留 `baseline`、`baselineByFile`、`baselineShown`、`baselineTruncated` 的逻辑不变；把 `baselineSection` 从数组改为字符串，并替换最后的 `user` 组装：

```js
  const baselineSection = baselineShown.length === 0 ? '' : [
    '## 基准轮审查意见（本轮必须逐条判定修复状态）',
    ...baselineShown.map((item) => {
      const where = item.line > 0 ? `（行 ${item.line}）` : '';
      const advice = typeof item.suggestion === 'string' && item.suggestion !== '' ? ` —— 建议：${item.suggestion}` : '';
      return `${item.index}. [${item.severity}] ${item.file === '' ? '' : `${item.file} `}${item.point}${where}${advice}`;
    }),
    ...(baselineTruncated > 0
      ? [`（上一轮意见已截断：另有 ${baselineTruncated} 条未列出，未列出的条目不需要判定。）`]
      : []),
    '对上面每一条意见，结合当前代码逐条判定：该问题在本次改动后是否仍存在。',
    '- 仍存在 → 在 previousVerdicts 输出 "status": "still-open"，并把该问题作为一条审查意见写入 issues（severity/point/line 按当前代码重写），同时带 "roundItem": <上面的序号>；',
    '- 已修复 / 不再存在 → 在 previousVerdicts 输出 "status": "fixed"，不要把它写入 issues；',
    `- previousVerdicts 必须恰好包含 ${baselineShown.length} 条判定，一条都不能少。`,
    '- 本轮新发现的问题照常写入 issues（不带 roundItem）——不要重复报告：已在 previousVerdicts 中判定 still-open 的问题只写一次，不要同时作为新发现再写一条。',
  ].join('\n');
```

`user` 的构造替换为：

```js
  const fileContentSection = typeof fileContent === 'string' && fileContent.trim() !== ''
    ? `## 该文件的完整内容（PR head，行号格式为「行号<TAB>代码」，可能被截断）\n${numberLines(fileContent, 3000)}`
    : '## 该文件的完整内容不可用（只有 diff；分析时不要臆测未出现的代码）';
  const user = renderPrompt('explain', {
    platform: platformLabel(pull.platform),
    repo: pull.repo,
    pullNumber: pull.number,
    title: pull.title,
    headRef: pull.headRef,
    baseRef: pull.baseRef,
    filePath: file.path,
    fileStatus: file.status,
    additions: file.additions,
    deletions: file.deletions,
    focus,
    reportLine,
    diff: diffText === '' ? '(该文件没有文本 diff)' : diffText,
    fileContentSection,
    baselineSection,
    previousVerdictsField: baseline.length > 0 ? fragment('previous-verdicts') : '',
  });
```

`focus` 与 `reportLine` 保持现有定义：

```js
  const focus = typeof focusPoint === 'string' && focusPoint !== '' ? `\n审查提示：${focusPoint}` : '';
  const reportLine = report === null || report === undefined
    ? ''
    : `PR 总体结论：${report.verdict ?? ''}；${report.summary ?? ''}`;
```

删除原来的 `const user = [...].join('\n');` 整块。

- [ ] **Step 4: 运行测试**

Run: `node --test tests/llm.test.js`

Expected: 全部 PASS，尤其是 `explain prompt: test gaps...`、`explain prompt carries the baseline findings...`、`explain prompt truncates the baseline per file...`。

- [ ] **Step 5: 提交**

```bash
git add llm.js prompts/explain.md prompts/fragments/previous-verdicts.md
git commit -m "refactor(prompts): load the per-file explanation prompt from Markdown"
```

---

## Task 5: 取证裁判 prompt

**Files:**
- Create: `prompts/verify.md`
- Create: `prompts/fragments/verify-language-zh.md`
- Create: `prompts/fragments/verify-language-en.md`
- Modify: `llm.js` 的 `verifyPromptBody`（当前 `llm.js:381-433`）
- Test: `tests/llm.test.js`

- [ ] **Step 1: 写两个语言片段**

`prompts/fragments/verify-language-zh.md`：

```markdown
如果 point 里出现「无法确认 / 无法核实 / 证据不足 / 证据被截断」这类措辞，confidence 必须低于 80，否则该条会被降级为未验证项。
```

`prompts/fragments/verify-language-en.md`：

```markdown
If the point says "could not confirm / cannot verify / insufficient evidence", confidence must stay below 80 or the item becomes an unverified note.

Write the human-readable fields in English.
```

- [ ] **Step 2: 写 `prompts/verify.md`**

```markdown
{{header}}

## 候选问题（index 从 1 开始）

{{candidates}}

## 宿主取回的证据

{{evidence}}

## 无法读取的证据

{{missing}}

{{diffSection}}

## 判定规则

对每条候选问题给出 confidence（0-100）：

- 80-100：证据确认问题存在，或高置信度会在实践中命中；写入 results，并给出最终的 severity、point、line。
- 25-79：只能部分验证；写入 results 并在 missing 里说明还缺哪份证据。
- 0-24：经不起推敲、属于既有问题或误报；写入 results 并给低分，不要写成高分。

每条候选都必须返回一条 result，index 用上面列表的编号（从 1 开始）；index 越界或缺失的结果会被丢弃。

证据块可能只显示文件的一部分（标题里标注了行范围）。只看到片段时，不要断言文件里不存在某段内容；需要完整文件才能判断的，按未验证处理。

{{verifyLanguageRule}}

只看候选与证据，不要引用第一轮的推理，也不要重新审查整个文件。

如果证据里发现了新的、可确认的问题，写进 extraIssues，带上 confidence 并确保能引用证据中的代码；否则不要输出。

规范类问题必须引用规范原文（如「CLAUDE.md 要求……」），没有原文就按未验证处理。

候选（含纯 suggest 改进点）已经由本次 diff 或现有代码实现、或只是复述现状的，confidence 打 24 以下直接丢弃；不要因为「有价值」而保留已实现的条目。

请输出严格 JSON（不要输出 JSON 以外的解释）：

```json
{
  "results": [{ "index": 1, "confidence": 85, "severity": "block | suggest", "point": "问题 + 影响", "suggestion": "具体修法（可选；沿用候选的修法或按证据修正）", "line": 0, "missing": "" }],
  "extraIssues": [{ "confidence": 90, "severity": "block | suggest", "point": "问题 + 影响", "suggestion": "具体修法（可选）", "line": 0 }]
}
```
```

- [ ] **Step 3: 替换 `verifyPromptBody`**

```js
/** Shared body for both verifier prompts: candidates, collected evidence, unreadable items. */
function verifyPromptBody(header, concerns, evidence, missing, language, extra = {}) {
  const list = Array.isArray(concerns) ? concerns : [];
  const missingList = Array.isArray(missing) ? missing : [];
  const diffText = typeof extra.diffText === 'string' ? extra.diffText.trim() : '';
  const candidateLines = list.length === 0
    ? ['（无候选问题）']
    : list.map((item, index) => {
        const where = item.file === '' ? '' : ` [${item.file}${item.line > 0 ? `:${item.line}` : ''}]`;
        const advice = typeof item.suggestion === 'string' && item.suggestion !== ''
          ? `\n   —— ${language === 'en' ? 'Suggestion: ' : '建议：'}${item.suggestion}`
          : '';
        return `${index + 1}. [${item.severity}]${where} ${item.point}${advice}`;
      });
  const missingLines = missingList.length === 0 ? ['（无）'] : missingList.map((item) => `- ${item}`);
  return renderPrompt('verify', {
    header,
    candidates: candidateLines.join('\n'),
    evidence: String(evidence ?? '').trim() === '' ? '（没有取到任何证据）' : String(evidence).trim(),
    missing: missingLines.join('\n'),
    diffSection: diffText === '' ? '' : `## 该文件的 diff（用来判断候选是否已经实现）\n\n${diffText}`,
    verifyLanguageRule: fragment(language === 'en' ? 'verify-language-en' : 'verify-language-zh'),
  });
}
```

- [ ] **Step 4: 运行测试**

Run: `node --test tests/llm.test.js`

Expected: 全部 PASS，尤其是 `the verifier prompt carries candidates and evidence...`、`the verifier prompt keeps the diff...`、`verifier prompt tells the model to score already-implemented candidates low`。

- [ ] **Step 5: 提交**

```bash
git add llm.js prompts/verify.md prompts/fragments/verify-language-zh.md prompts/fragments/verify-language-en.md
git commit -m "refactor(prompts): load the verifier prompt from Markdown"
```

---

## Task 6: 对话 prompt

**Files:**
- Create: `prompts/chat.md`
- Create: `prompts/fragments/chat-file-contract.md`
- Create: `prompts/fragments/chat-overview-contract.md`
- Modify: `llm.js` 的 `buildChatPrompt`（当前 `llm.js:482-576`）
- Test: `tests/llm.test.js`

- [ ] **Step 1: 写两个输出契约片段**

`prompts/fragments/chat-file-contract.md`：

````markdown
## 输出契约

严格输出 JSON（不要 JSON 之外的文字）：

```json
{
  "answer": "给你的回答正文",
  "findingOps": [
    { "op": "remove", "index": 1 },
    { "op": "update", "index": 2, "point": "改写后的问题与影响", "suggestion": "改写后的具体修法（可选）", "severity": "block | suggest", "line": 12 },
    { "op": "add", "point": "新意见的问题与影响", "suggestion": "可选：具体修法", "severity": "suggest", "line": 0 }
  ]
}
```

findingOps 只用于按这次讨论修改「该文件当前的审查意见」：某条不成立就 remove 对应编号；要改写就 update（只给要改的字段：point 写问题与影响，suggestion 写具体做法，severity/line 可一并改）；讨论出新意见就 add。没有要改的就输出空数组。不要通过 answer 代替操作。
````

`prompts/fragments/chat-overview-contract.md`：

````markdown
## 输出契约

严格输出 JSON（不要 JSON 之外的文字）：

```json
{
  "answer": "给你的回答正文",
  "suggestionOps": [
    { "op": "remove", "target": "risk", "index": 1 },
    { "op": "update", "target": "risk", "index": 1, "text": "改写后的风险描述" },
    { "op": "add", "target": "risk", "text": "新增风险", "file": "路径或空串", "severity": "block | suggest" },
    { "op": "remove", "target": "suggestion", "index": 2 },
    { "op": "update", "target": "blocker", "index": 1, "text": "改写后的阻塞项" },
    { "op": "add", "target": "nextStep", "text": "新增的下一步" }
  ]
}
```

suggestionOps 直接修改总览里已存在的内容：target 取 risk（总体初筛风险）、blocker（最终结论的阻塞项）、suggestion（最终结论的修改建议）、nextStep（下一步）。用户说某条不成立就 remove 对应编号；说要改写就 update；讨论出新内容就 add（add risk/suggestion 时用 file 标注涉及文件，未涉及写空串；add blocker/nextStep 不需要 file）。没有要改的就输出空数组。不要通过 answer 代替操作。
````

- [ ] **Step 2: 写 `prompts/chat.md`**

```markdown
平台：{{platform}}；仓库：{{repo}}

PR #{{pullNumber}}：{{title}}

{{scopeLabel}}

{{reportLine}}

{{explanation}}

{{scopeSection}}

{{transcriptSection}}

## 新问题

{{question}}

不要重复整个报告；需要时引用文件、函数与行号。

{{outputContract}}
```

- [ ] **Step 3: 替换 `buildChatPrompt` 的尾部组装**

保留 `contextLines` 的成员计算、`transcript`、`isFileScope`、`currentFindings`、`numbered`、`overviewLines`、`scopeSection` 不变。把 `outputLines` 常量删除，替换最后的 `user` 与返回值：

```js
  const user = renderPrompt('chat', {
    platform: platformLabel(pull.platform),
    repo: pull.repo,
    pullNumber: pull.number,
    title: pull.title,
    scopeLabel: file === null ? '讨论范围：整个 PR（总览）' : `讨论文件：${file.path}`,
    reportLine: report === null || report === undefined ? '' : `PR 总体结论：${report.verdict ?? ''}；${report.summary ?? ''}`,
    explanation: explanation === null || explanation === undefined
      ? ''
      : `已有文件分析：\n${JSON.stringify(explanation).slice(0, 8000)}`,
    scopeSection,
    transcriptSection: transcript === '' ? '' : `## 已有对话\n${transcript}`,
    question,
    outputContract: fragment(isFileScope ? 'chat-file-contract' : 'chat-overview-contract'),
  });
  return {
    system: reviewerSystem(languageOf(options)),
    messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
    maxTokens: 4000,
    timeoutMs: 300_000,
    temperature: 0.3,
  };
```

同时删除不再使用的 `contextLines` 数组（如果没有其他引用）。

- [ ] **Step 4: 运行测试**

Run: `node --test tests/llm.test.js`

Expected: 全部 PASS，尤其是 `buildChatPrompt file scope lists findings and asks for findingOps`。

- [ ] **Step 5: 提交**

```bash
git add llm.js prompts/chat.md prompts/fragments/chat-file-contract.md prompts/fragments/chat-overview-contract.md
git commit -m "refactor(prompts): load the discussion prompt from Markdown"
```

---

## Task 7: 最终结论 prompt

**Files:**
- Create: `prompts/conclude.md`
- Modify: `llm.js` 的 `buildConcludePrompt`（当前 `llm.js:592-676`）
- Test: `tests/llm.test.js`

- [ ] **Step 1: 写 `prompts/conclude.md`**

```markdown
平台：{{platform}}；仓库：{{repo}}

PR #{{pullNumber}}：{{title}}（{{headRef}} → {{baseRef}}）

规模：{{changedFiles}} 个文件，+{{additions}} / -{{deletions}}

{{reportLine}}

已逐文件分析（{{entryCount}} 个）：{{entries}}

{{coverageSection}}

{{previousItemsSection}}

{{humanItemIdsSection}}

{{feedbackSection}}

{{chatSection}}

{{currentConclusionSection}}

输出要求：沿用上一轮条目的 id（未变化的条目必须复用原 id）；人工锁定 id 必须原样保留；新增条目不要编造 id；只有本次逐文件分析或 diff 明确表明问题已消失时，才可以不输出旧条目——无法确认是否修复时必须保留。

line 为 PR head 新文件行号，可选：填整数（未知填 0）；文件路径必须与变更文件清单一致。

请输出严格 JSON，作为合并前的最终审查结论：

```json
{
  "verdict": "block | suggest | pass",
  "summary": "3-5 句最终结论：改动的价值、实现是否匹配 PR 描述、遗留风险与测试空白、是否可合并；没有阻塞项时明确写「未发现阻塞项」",
  "blockers": [{ "id": "可选：沿用上一轮条目的 id", "file": "路径", "line": 0, "point": "问题 + 影响 + 修法（一条只写一个核心问题）" }],
  "suggestions": [{ "id": "可选：沿用上一轮条目的 id", "file": "路径", "line": 0, "point": "问题 + 影响 + 修法（一条只写一个核心问题）" }],
  "nextSteps": ["合并前要做的事，按顺序；只写要执行的动作与要补的测试，不要写未验证项"]
}
```
```

- [ ] **Step 2: 替换 `buildConcludePrompt` 的组装**

保留开头所有数据准备（`entries`、`coverage`、`previousItems`、`humanItemIds`、`feedback`、`pullChat`）不变，把 `lines` 数组的构造改成字符串变量：

```js
  const reportLine = report === null || report === undefined ? '' : `总体报告：${truncateWithMarker(JSON.stringify(report), 5000)}`;

  const coverageSection = coverage === null ? '' : (() => {
    const analyzed = Number.isFinite(coverage.analyzed) ? coverage.analyzed : 0;
    const total = Number.isFinite(coverage.total) ? coverage.total : 0;
    const unanalyzed = Array.isArray(coverage.unanalyzed) ? coverage.unanalyzed.filter((item) => typeof item === 'string' && item !== '') : [];
    const lines = ['## 覆盖率', `已分析 ${analyzed}/${total} 个变更文件；未分析 ${unanalyzed.length} 个。`];
    if (unanalyzed.length > 0) {
      const shown = unanalyzed.slice(0, 20);
      lines.push(
        `未分析文件（最多列 20 个，这些文件没有逐文件分析，结论里不要臆测它们的内容）：${shown.join('、')}${unanalyzed.length > shown.length ? ` 等 ${unanalyzed.length} 个` : ''}`,
      );
    }
    return lines.join('\n');
  })();

  const previousItemsSection = previousItems.length === 0 ? '' : (() => {
    const lines = ['## 上一轮结论条目（尽量沿用下面的 id；未变化的条目必须复用原 id，不要重新编号）'];
    previousItems.forEach((item, index) => {
      const kindLabel = item.kind === 'blocker' ? '阻塞' : '建议';
      const line = Number.isInteger(item.line) && item.line > 0 ? `:${item.line}` : '';
      const file = typeof item.file === 'string' && item.file !== '' ? `${item.file}${line} — ` : '';
      lines.push(`${index + 1}. [${item.id ?? ''}] [${kindLabel}] ${file}${item.point ?? ''}`);
    });
    return lines.join('\n');
  })();

  const humanItemIdsSection = humanItemIds.length === 0
    ? ''
    : `人工锁定 id（这些条目由人工确认，必须原样保留，不得删除或改写其 point）：${humanItemIds.join(', ')}`;

  const feedbackSection = (() => {
    if (feedback === null || typeof feedback !== 'object') return '';
    const states = feedback.states !== null && typeof feedback.states === 'object' ? feedback.states : {};
    const stateLines = Object.entries(states).map(([key, state]) => {
      const label = FEEDBACK_STATUS_LABELS[state?.status] ?? '状态不明';
      const reason = typeof state?.reason === 'string' && state.reason !== '' ? `：${state.reason.slice(0, 300)}` : '';
      return `- [${key}] ${label}${reason}`;
    });
    const notes = Array.isArray(feedback.notes) ? feedback.notes.filter((note) => typeof note === 'string' && note !== '') : [];
    if (stateLines.length === 0 && notes.length === 0) return '';
    const lines = ['## 实现者反馈（来自 PR 评论区的回复，用于判断条目是否仍然成立）', ...stateLines];
    for (const note of notes.slice(0, 10)) lines.push(`- 备注：${note.slice(0, 300)}`);
    return lines.join('\n');
  })();

  const chat = pullChat
    .slice(-12)
    .map((turn) => `${turn?.role === 'assistant' ? '助手' : '用户'}：${String(turn?.text ?? '').slice(0, 400)}`);
  const chatSection = chat.length === 0 ? '' : ['## 人机讨论（最近 12 条，每条截断 400 字）', ...chat].join('\n');

  const currentConclusionSection = currentConclusion === null || currentConclusion === undefined
    ? ''
    : `## 当前结论（可能经过人工在对话中修订；请在此基础上更新，人工确认的内容优先保留）\n${truncateWithMarker(JSON.stringify(currentConclusion), 8000)}`;

  const user = renderPrompt('conclude', {
    platform: platformLabel(pull.platform),
    repo: pull.repo,
    pullNumber: pull.number,
    title: pull.title,
    headRef: pull.headRef,
    baseRef: pull.baseRef,
    changedFiles: pull.changedFiles,
    additions: pull.additions,
    deletions: pull.deletions,
    reportLine,
    entryCount: entries.length,
    entries: truncateWithMarker(JSON.stringify(entries), 16000),
    coverageSection,
    previousItemsSection,
    humanItemIdsSection,
    feedbackSection,
    chatSection,
    currentConclusionSection,
  });
  return { system: reviewerSystem(languageOf(options)), messages: [{ role: 'user', content: [{ type: 'text', text: user }] }], maxTokens: 8000, timeoutMs: 300_000 };
```

删除原来的 `lines` 数组与 `lines.filter(...).join('\n')`。

- [ ] **Step 3: 运行测试**

Run: `node --test tests/llm.test.js`

Expected: 全部 PASS，尤其是两条 `buildConcludePrompt: ...` 与 `conclude prompt: names residual risks...`。

- [ ] **Step 4: 提交**

```bash
git add llm.js prompts/conclude.md
git commit -m "refactor(prompts): load the conclusion prompt from Markdown"
```

---

## Task 8: 反馈解析 prompt

**Files:**
- Create: `prompts/feedback.md`
- Modify: `llm.js` 的 `buildFeedbackPrompt`（当前 `llm.js:1074-1099`）
- Test: `tests/llm.test.js`

- [ ] **Step 1: 写 `prompts/feedback.md`**

```markdown
PR #{{pullNumber}}：{{title}}

## 我们已发布的审查意见（编号）

{{itemLines}}

## PR 实现者/其他人在评论区的回复（按时间）

{{commentLines}}

请判断每条审查意见在回复中的处置情况，严格输出 JSON：

```json
{
  "items": [{ "index": 1, "status": "fixed-claimed | disputed | accepted | question", "reason": "引用回复原话，简要说明" }],
  "notes": ["无法对应到具体编号的其他重要反馈"]
}
```

status 含义：fixed-claimed=作者表示已修复或已改；disputed=作者认为不成立/误报；accepted=作者认可但尚未修复；question=作者在询问澄清。只输出回复中确实提到的条目；没有提到的条目不要出现在 items 里。
```

- [ ] **Step 2: 替换 `buildFeedbackPrompt`**

```js
/** Prompt for parsing the developers' replies to our published review comment. */
export function buildFeedbackPrompt(pull, items, comments, options = {}) {
  const itemLines = (Array.isArray(items) ? items : [])
    .map((item) => `${item.index}. [${item.kind === 'blocker' ? '阻塞' : '建议'}] ${item.file === '' ? '' : `${item.file} — `}${item.point}`)
    .join('\n');
  const commentLines = (Array.isArray(comments) ? comments : [])
    .map((comment) => `--- ${comment.author} @ ${comment.createdAt}\n${String(comment.body ?? '').slice(0, 4000)}`)
    .join('\n\n');
  const user = renderPrompt('feedback', {
    pullNumber: pull?.number ?? '',
    title: pull?.title ?? '',
    itemLines: itemLines === '' ? '（无）' : itemLines,
    commentLines: commentLines === '' ? '（无）' : commentLines,
  });
  return { system: compactSystem(languageOf(options)), messages: [{ role: 'user', content: [{ type: 'text', text: user }] }], maxTokens: 3000, timeoutMs: 300_000, temperature: 0.1 };
}
```

- [ ] **Step 3: 运行测试**

Run: `node --test tests/llm.test.js`

Expected: 全部 PASS，尤其是 `the feedback prompt uses the compact system...`。

- [ ] **Step 4: 提交**

```bash
git add llm.js prompts/feedback.md
git commit -m "refactor(prompts): load the feedback prompt from Markdown"
```

---

## Task 9: index.js 注入段与打包清单

**Files:**
- Create: `prompts/review-data.md`
- Modify: `index.js:3810-3814`
- Modify: `package.json` 的 `files`
- Modify: `tests/index.test.js`（setup 记录 section，新增断言）

- [ ] **Step 1: 写 `prompts/review-data.md`**

```markdown
PR 审查插件：审查数据（总体报告、逐文件分析、当前轮结论）保存在本地，代码平台上的审查评论只是这份数据的渲染结果。

- 要调整下一次发布的审查意见，用 `review_update_overview` 一次改总览（结论 + 总体评价/风险/顺序，可选 `clearFindings` 清理逐文件审查意见）；只有单文件/单轮细节才用 `review_update_conclusion` / `review_update_analysis` / `review_update_report`（先 `review_get` 取 revision）。
- 不要直接编辑平台上已发布的评论。
- 用户要求「重新生成结论 / 发布 / 查看评论 / 在代码平台打开」时，分别用 `review_conclude` / `review_publish` / `review_get_links` 触发；发布是真实写操作，只在用户明确要求时调用。
- 对话里出现 `<review-context>` 时，用户说「这个文件/这条/这里」默认指快照的「当前查看」范围：直接按它操作（例如标记该文件通过就 `review_update_analysis` + verdict），不要反问是哪个文件；只有没有快照时才问。
- 需要确认时主动用 `ask_user_question` 问、不要猜：发布范围不唯一（哪些条目）、同一轮同一版本已发布过是否追加、要改哪一轮/哪个文件但快照缺失、或用户一句话里出现多个候选对象。
```

- [ ] **Step 2: 改 `index.js`**

在文件顶部导入区加入：

```js
import { loadPrompt } from './prompts.js';
```

把 `systemPrompt.section({ ... text: 'PR 审查插件：…' })` 的 `text` 改为：

```js
        text: loadPrompt('review-data'),
```

- [ ] **Step 3: 改 `tests/index.test.js` 的 setup**

在 `setup()` 里 `const promptContexts = [];` 旁边加：

```js
  const promptSections = [];
```

把 `systemPrompt.section` 改为记录定义：

```js
    systemPrompt: {
      section(definition) {
        promptSections.push(definition);
        return () => {};
      },
      context(definition) {
        if (options.promptContextThrows === true) throw new Error('prompt context rejected');
        promptContexts.push(definition);
        return () => {};
      },
    },
```

在 setup 的返回值里加入：

```js
    promptSections,
```

- [ ] **Step 4: 新增断言**

在 `tests/index.test.js` 顶部导入：

```js
import { loadPrompt } from '../prompts.js';
```

在文件中新增：

```js
test('the review-data system prompt section comes from prompts/review-data.md', async () => {
  const plugin = await setup();
  try {
    const section = plugin.promptSections.find((entry) => entry.name === 'pr-review: review-data');
    assert.ok(section !== undefined, 'review-data section is registered');
    assert.equal(section.text, loadPrompt('review-data'));
  } finally {
    await plugin.dispose();
  }
});
```

- [ ] **Step 5: 改 `package.json`**

在 `files` 数组中 `"llm.js",` 之后加入：

```json
    "prompts.js",
    "prompts/**/*.md",
```

- [ ] **Step 6: 运行测试**

Run: `node --test tests/index.test.js tests/prompts.test.js`

Expected: 全部 PASS。

- [ ] **Step 7: 提交**

```bash
git add index.js prompts/review-data.md package.json tests/index.test.js
git commit -m "refactor(prompts): inject the review-data section from Markdown"
```

---

## Task 10: 全量验证

**Files:**
- 无新增；只验证。

- [ ] **Step 1: 跑完整测试套件**

Run: `pnpm test`

Expected:

```
stamp check passed
# pass N
# fail 0
```

- [ ] **Step 2: 确认 llm.js 不再有内联提示词**

Run:

```bash
grep -n "你是一名\|请输出严格 JSON\|## 判定规则\|误报排除\|block | suggest" llm.js
```

Expected: 无输出。`llm.js` 只保留解析逻辑与数据准备。

- [ ] **Step 3: 确认占位符严格性**

Run:

```bash
node -e "import('./prompts.js').then(({renderPrompt}) => { try { renderPrompt('report', {}) } catch (error) { console.log(error.message) } })"
```

Expected: `Missing prompt value: report#platform`。

- [ ] **Step 4: 确认没有残留占位符**

Run:

```bash
grep -rn "{{" prompts/ | grep -v "{{[A-Za-z][A-Za-z0-9_]*}}" || true
```

Expected: 无输出（所有 `{{` 都是合法占位符）。

- [ ] **Step 5: 最终提交（如有必要）**

```bash
git status --short
```

Expected: 无输出；工作区干净。

---

## 自查记录

- **Spec 覆盖**：加载器（Task 1）、共享片段与 system（Task 2）、6 个任务 prompt（Task 3-8）、index 注入与打包（Task 9）、全量验证（Task 10）均有一一对应。
- **占位符一致性**：`prompts.js` 的严格渲染贯穿所有 builder；每个 builder 传入的键与对应 Markdown 文件中的 `{{key}}` 一一对应。
- **不改解析逻辑**：本计划没有触碰任何 `normalize*` / `partition*` 函数。
- **测试**：既有 `tests/llm.test.js` 的 283 个断言作为行为基线；新增 `tests/prompts.test.js` 覆盖加载器与文件完整性；`tests/index.test.js` 增加注入段来源断言。

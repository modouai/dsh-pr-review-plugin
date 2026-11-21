/**
 * Model calls and prompts for the PR review plugin.
 *
 * The plugin calls the Host `llm` service directly (no Agent session) and asks
 * for strict JSON so the browser half can render a typed shape. Explanations
 * are deep by design: the model walks the changed logic hunk by hunk instead of
 * only summarizing the diff.
 */

import { heuristicOrder, diffExcerpts } from './diff.js';
import { fragment, renderPrompt } from './prompts.js';

/**
 * Human-readable platform names for prompts. Keep the keys in sync with the
 * `platform` values produced by providers.js (`gitea` is an alias of `forgejo`).
 */
export const PLATFORM_LABELS = Object.freeze({
  github: 'GitHub',
  gitlab: 'GitLab',
  gitea: 'Gitea/Forgejo',
  forgejo: 'Gitea/Forgejo',
  gitee: 'Gitee',
  gitcode: 'GitCode',
  atomgit: 'AtomGit',
  codeup: 'Codeup',
});

export function platformLabel(platform) {
  const raw = typeof platform === 'string' ? platform.trim() : '';
  if (raw === '') return '未知平台';
  // Keep an unexpected value short and free of control characters before it reaches a prompt.
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 40);
  if (clean === '') return '未知平台';
  return PLATFORM_LABELS[clean.toLowerCase()] ?? `未知平台（${clean}）`;
}

/** Extract the first JSON object from a model answer that may carry prose or fences. */
export function extractJson(text) {
  const trimmed = text.trim();
  const attempt = (candidate) => {
    try {
      return JSON.parse(candidate);
    } catch {
      return null;
    }
  };
  const direct = attempt(trimmed);
  if (direct !== null) return direct;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced !== null) {
    const parsed = attempt(fenced[1].trim());
    if (parsed !== null) return parsed;
  }
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) {
    const parsed = attempt(trimmed.slice(first, last + 1));
    if (parsed !== null) return parsed;
  }
  return null;
}

/** Explicit config wins over the user's default model. */
export function resolveSelection(ctx, config) {
  const hasProvider = typeof config.provider === 'string' && config.provider !== '';
  const hasModel = typeof config.model === 'string' && config.model !== '';
  if (hasProvider && hasModel) return { provider: config.provider, model: config.model };
  const service = ctx.get('agentDefaultModel');
  if (service !== undefined && typeof service.currentSelection === 'function') {
    const selection = service.currentSelection();
    if (selection !== null && selection !== undefined && selection.provider && selection.model) {
      return {
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
      };
    }
  }
  throw new Error('没有可用模型：请在插件配置里设置 provider 与 model，或先在会话里选择默认模型。');
}

/** Stream one model call and return its assembled text. `request.signal` cancels the call. */
export async function callModel(ctx, config, request) {
  const selection = resolveSelection(ctx, config);
  const configuredEffort = typeof config.reasoningEffort === 'string' && config.reasoningEffort !== ''
    ? config.reasoningEffort
    : selection.reasoningEffort;
  const externalSignal = request.signal === null || request.signal === undefined ? null : request.signal;
  const cancelledByCaller = () => externalSignal !== null && externalSignal.aborted === true;
  const runStream = async (effort) => {
    const controller = new AbortController();
    const onExternalAbort = () => controller.abort();
    if (externalSignal !== null) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 300_000);
    let text = '';
    let finishKind = 'stop';
    try {
      const options = {
        provider: selection.provider,
        model: selection.model,
        messages: request.messages,
        signal: controller.signal,
        temperature: request.temperature ?? 0.2,
        maxTokens: request.maxTokens ?? 4000,
        ...(request.system === undefined ? {} : { system: request.system }),
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
      };
      for await (const chunk of ctx.llm.stream(options)) {
        if (chunk === null || chunk === undefined) continue;
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
        else if (chunk.type === 'finish') {
          const kind = chunk.reason?.kind;
          if (kind === 'error' || kind === 'aborted') {
            const failure = chunk.reason?.failure;
            throw new Error(`模型请求失败（${kind}）：${failure?.message ?? failure?.code ?? '未知原因'}`);
          }
          if (kind === 'max-tokens') finishKind = 'max-tokens';
        }
      }
      if (cancelledByCaller()) throw new Error('模型请求已取消。');
    } catch (error) {
      if (cancelledByCaller()) throw new Error('模型请求已取消。');
      throw error;
    } finally {
      clearTimeout(timer);
      if (externalSignal !== null) externalSignal.removeEventListener('abort', onExternalAbort);
    }
    if (text.trim() === '') {
      throw new Error(
        finishKind === 'max-tokens'
          ? '模型把 max-tokens 预算全部用在了推理上，没有产出正文；请提高 maxTokens 或降低 reasoning effort。'
          : '模型返回空内容。',
      );
    }
    return text;
  };
  try {
    return await runStream(configuredEffort);
  } catch (error) {
    // A cancelled call must report cancellation, never a retry or a model error.
    const message = error instanceof Error ? error.message : String(error);
    if (cancelledByCaller() || message.includes('已取消')) {
      throw new Error(message.includes('已取消') ? message : '模型请求已取消。');
    }
    // A model without the configured effort must not fail the whole review.
    if (configuredEffort === undefined || !/UNSUPPORTED_REASONING_EFFORT|reasoning effort|reasoningEffort/i.test(message)) throw error;
    return await runStream(undefined);
  }
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
 * `zh`/`en` from any case or region form ('EN', 'en-US', 'en_us'); anything else — including a
 * missing or malformed value — reads as the Chinese default. One normalizer for the prompt
 * builders and the published comment, so the two can never disagree about the language.
 */
function normalizeLanguage(value) {
  const tag = typeof value === 'string' ? value.trim().toLowerCase().split(/[-_]/)[0] : '';
  return tag === 'en' ? 'en' : 'zh';
}

/** Builder options carry the comment language; anything else keeps the Chinese default. */
function languageOf(options) {
  return normalizeLanguage(options !== null && typeof options === 'object' ? options.language : undefined);
}

/** Output-language rule; the compact prompt keeps its narrower "quoted text" wording. */
function languageRule(language, compact = false) {
  const suffix = language === 'en' ? 'en' : 'zh';
  return fragment(compact ? `language-compact-${suffix}` : `language-${suffix}`);
}


const FILE_LIST_LIMIT = 80;

/** Report prompt: one call over the whole pull request, with per-file truncation. */
export function buildReportPrompt(pull, files, diffFiles, config) {
  // The report prompt is the only one that receives the settings object, so the language
  // arrives as `commentLanguage` rather than through the builder options.
  const language = normalizeLanguage(config?.commentLanguage);
  const maxChars = config.maxDiffCharsPerFile ?? 14000;
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


/** Full-file text with 1-based line numbers, capped so the prompt stays bounded. */
function numberLines(content, maxLines) {
  return String(content)
    .split('\n')
    .slice(0, maxLines)
    .map((line, index) => `${index + 1}\t${line}`)
    .join('\n');
}

/** Deep one-file explanation: the point is the logic walkthrough, not only findings. */
export function buildExplainPrompt(pull, file, diffText, report, focusPoint, fileContent, options = {}) {
  const language = languageOf(options);
  const focus = typeof focusPoint === 'string' && focusPoint !== '' ? `\n审查提示：${focusPoint}` : '';
  const reportLine = report === null || report === undefined
    ? ''
    : `\nPR 总体结论：${report.verdict ?? ''}；${report.summary ?? ''}`;
  // Baseline findings (review-delta spec v7): the previous concluded round's findings are
  // re-judged one by one — "fixed" leaves the issue list, "still-open" re-enters it with
  // a roundItem reference. The full globally-numbered snapshot goes in so the model can
  // carry a finding across a renamed file.
  const baseline = Array.isArray(options.baselineFindings) ? options.baselineFindings : [];
  // 快照全量冻结，但下发按文件截断到 10 条（block 优先、行号升序）：截断部分不下发、
  // 不要求判定，并显式声明——这些条目在对比里落「未判定」，绝不静默消失。
  const baselineByFile = new Map();
  for (const item of baseline) {
    if (!baselineByFile.has(item.file)) baselineByFile.set(item.file, []);
    baselineByFile.get(item.file).push(item);
  }
  const baselineShown = [];
  let baselineTruncated = 0;
  for (const group of baselineByFile.values()) {
    const sorted = [...group].sort((left, right) => (
      (left.severity === right.severity ? 0 : left.severity === 'block' ? -1 : 1) || left.line - right.line
    ));
    baselineShown.push(...sorted.slice(0, 10));
    baselineTruncated += Math.max(0, sorted.length - 10);
  }
  baselineShown.sort((left, right) => left.index - right.index);
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
  const fileContentSection = typeof fileContent === 'string' && fileContent.trim() !== ''
    ? `## 该文件的完整内容（PR head，行号格式为「行号<TAB>代码」，可能被截断）\n${numberLines(fileContent, 3000)}`
    : '## 该文件的完整内容不可用（只有 diff；分析时不要臆测未出现的代码）';
  const user = renderPrompt('explain', {
    platform: platformLabel(pull.platform),
    repo: pull.repo,
    pullNumber: pull.number,
    title: pull.title,
    headRef: pull.headRef ?? '',
    baseRef: pull.baseRef ?? '',
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
  return { system: reviewerSystem(language), messages: [{ role: 'user', content: [{ type: 'text', text: user }] }], maxTokens: 12000, timeoutMs: 600_000 };
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

/** Verifier for the whole-PR report: turns report concerns into risks or unverified notes. */
export function buildReportVerifyPrompt(pull, concerns, evidence, missing, options = {}) {
  const language = languageOf(options);
  return {
    system: verifierSystem(language),
    messages: [{
      role: 'user',
      content: [{
        type: 'text',
        text: verifyPromptBody(
          `平台：${platformLabel(pull?.platform)}；仓库：${pull?.repo ?? ''}\nPR #${pull?.number ?? 0}：${pull?.title ?? ''}`,
          concerns,
          evidence,
          missing,
          language,
        ),
      }],
    }],
    maxTokens: 8000,
    timeoutMs: 300_000,
  };
}

/** Verifier for one file: turns file concerns into findings or unverified notes. */
export function buildExplainVerifyPrompt(pull, file, concerns, evidence, missing, options = {}) {
  const language = languageOf(options);
  return {
    system: verifierSystem(language),
    messages: [{
      role: 'user',
      content: [{
        type: 'text',
        text: verifyPromptBody(
          `平台：${platformLabel(pull?.platform)}；仓库：${pull?.repo ?? ''}\nPR #${pull?.number ?? 0}：${pull?.title ?? ''}\n正在复审文件：${file?.path ?? ''}（${file?.status ?? ''}，+${file?.additions ?? 0} / -${file?.deletions ?? 0}）`,
          concerns,
          evidence,
          missing,
          language,
          { diffText: options.diffText },
        ),
      }],
    }],
    maxTokens: 8000,
    timeoutMs: 300_000,
  };
}

/** Follow-up conversation about one file (or the whole PR when file is null). */
export function buildChatPrompt(pull, file, explanation, report, history, question, conclusion, options = {}) {
  const transcript = history
    .slice(-8)
    .map((turn) => `${turn.role === 'assistant' ? '助手' : '用户'}：${String(turn.text).slice(0, 3000)}`)
    .join('\n');
  const isFileScope = file !== null && file !== undefined;
  const currentFindings = findingsOf(explanation);

  const numbered = (items, mapper) => (items.length === 0 ? '（无）' : items.map(mapper).join('\n'));
  const overviewLines = () => {
    const lines = ['## 当前总览内容（对话可直接按编号增删改对应区块）'];
    const risks = Array.isArray(report?.risks) ? report.risks : [];
    lines.push('### 总体初筛风险（target=risk）');
    lines.push(numbered(risks, (item, i) => `${i + 1}. [${item.severity}] ${item.file === '' ? '' : `[${item.file}] `}${item.point}`));
    if (conclusion !== null && conclusion !== undefined) {
      const blockers = Array.isArray(conclusion.blockers) ? conclusion.blockers : [];
      const suggestions = Array.isArray(conclusion.suggestions) ? conclusion.suggestions : [];
      const nextSteps = Array.isArray(conclusion.nextSteps) ? conclusion.nextSteps : [];
      lines.push('### 最终结论（已生成）');
      lines.push(`总体评价：${conclusion.summary ?? ''}`);
      lines.push('#### 阻塞项（target=blocker）');
      lines.push(numbered(blockers, (item, i) => `${i + 1}. ${item.file === '' ? '' : `[${item.file}] `}${item.point}`));
      lines.push('#### 修改建议（target=suggestion）');
      lines.push(numbered(suggestions, (item, i) => `${i + 1}. ${item.file === '' ? '' : `[${item.file}] `}${item.point}`));
      lines.push('#### 下一步（target=nextStep）');
      lines.push(numbered(nextSteps, (item, i) => `${i + 1}. ${item}`));
    } else {
      lines.push('### 最终结论：尚未生成（此时只能修改总体初筛风险；结论区块不参与）');
    }
    return lines.join('\n');
  };

  const scopeSection = isFileScope
    ? `## 该文件当前的审查意见（编号从 1 开始，用于这次讨论的增删改）\n${numbered(currentFindings, (item, i) => `${i + 1}. [${item.severity}] ${item.point}${item.line > 0 ? `（行 ${item.line}）` : ''}${item.suggestion === '' ? '' : `\n   —— 建议：${item.suggestion}`}`)}`
    : overviewLines();

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
}

const FEEDBACK_STATUS_LABELS = {
  'fixed-claimed': '作者表示已修复或已改',
  disputed: '作者认为不成立/误报',
  accepted: '作者认可但尚未修复',
  question: '作者在询问澄清',
};

/** Cut a prompt section and say so explicitly instead of silently dropping the tail. */
function truncateWithMarker(text, limit) {
  const value = String(text ?? '');
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n……（内容过长，已截断，剩余 ${value.length - limit} 字符未提供）`;
}

/** Final conclusion over everything reviewed so far (including human edits from the overview chat). */
export function buildConcludePrompt(pull, report, explanations, currentConclusion, options = {}) {
  const entries = [...explanations.entries()].map(([filePath, explanation]) => ({
    file: filePath,
    verdict: explanation.verdict ?? '',
    summary: explanation.summary ?? '',
    issues: explanation.issues ?? [],
  }));
  const coverage = options.coverage === null || options.coverage === undefined ? null : options.coverage;
  const previousItems = Array.isArray(options.previousItems) ? options.previousItems : [];
  const humanItemIds = (Array.isArray(options.humanItemIds) ? options.humanItemIds : []).filter((id) => typeof id === 'string' && id !== '');
  const feedback = options.feedback === null || options.feedback === undefined ? null : options.feedback;
  const pullChat = Array.isArray(options.pullChat) ? options.pullChat : [];
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
}

/**
 * Normalize the per-item verdicts the model produces for the baseline findings
 * (review-delta spec v7): one valid verdict per baseline index, duplicates keep
 * the first, everything malformed is dropped — a dropped verdict falls back to
 * the conservative "still-open" at the call site, never to "fixed".
 */
export function normalizePreviousVerdicts(raw, baselineCount) {
  if (!Array.isArray(raw) || !Number.isInteger(baselineCount) || baselineCount <= 0) return [];
  const seen = new Set();
  const verdicts = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (item === null || typeof item !== 'object') continue;
    const index = Number.isInteger(item.index) && item.index >= 1 && item.index <= baselineCount ? item.index : 0;
    if (index === 0 || seen.has(index)) continue;
    if (item.status !== 'fixed' && item.status !== 'still-open') continue;
    seen.add(index);
    if (item.status === 'fixed') {
      verdicts.push({ index, status: 'fixed' });
      continue;
    }
    verdicts.push({
      index,
      status: 'still-open',
      ...(typeof item.point === 'string' && item.point.trim() !== '' ? { point: item.point.trim() } : {}),
      ...(Number.isInteger(item.line) && item.line > 0 ? { line: Math.floor(item.line) } : {}),
      ...(item.severity === 'block' || item.severity === 'suggest' ? { severity: item.severity } : {}),
      ...(typeof item.suggestion === 'string' && item.suggestion.trim() !== '' ? { suggestion: item.suggestion.trim() } : {}),
    });
  }
  return verdicts;
}

/** Candidate problems from the triage pass; none of them is a finding until the verifier scores it. */
export function normalizeConcerns(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((item) => item !== null && typeof item === 'object')
    .map((item) => ({
      severity: item.severity === 'block' ? 'block' : 'suggest',
      file: typeof item.file === 'string' ? item.file : '',
      point: typeof item.point === 'string' ? item.point.trim() : '',
      suggestion: typeof item.suggestion === 'string' ? item.suggestion.trim() : '',
      // Same hardening as findingsOf: only positive finite line numbers survive.
      line: typeof item.line === 'number' && Number.isFinite(item.line) && item.line > 0 ? Math.floor(item.line) : 0,
    }))
    .filter((item) => item.point !== '');
}

/** Evidence the triage pass wants before a concern can become a finding. */
export function normalizeEvidenceNeeds(raw) {
  const kinds = new Set(['callers', 'definition', 'callee', 'schema', 'test', 'file']);
  return (Array.isArray(raw) ? raw : [])
    .filter((item) => item !== null && typeof item === 'object')
    .map((item) => ({
      concern: Number.isInteger(item.concern) && item.concern > 0 ? item.concern : 0,
      kind: kinds.has(item.kind) ? item.kind : 'file',
      path: typeof item.path === 'string' ? item.path.trim() : '',
      symbol: typeof item.symbol === 'string' ? item.symbol.trim() : '',
      reason: typeof item.reason === 'string' ? item.reason.trim() : '',
    }))
    .filter((item) => item.path !== '' || item.symbol !== '');
}

/** Points the verifier could not confirm; shown broken out, never as a finding. */
export function normalizeUnverified(raw) {
  return (Array.isArray(raw) ? raw : [])
    .filter((item) => item !== null && typeof item === 'object')
    .map((item) => ({
      point: typeof item.point === 'string' ? item.point.trim() : '',
      missing: typeof item.missing === 'string' ? item.missing.trim() : '',
    }))
    .filter((item) => item.point !== '');
}

/** Confidence thresholds shared by the candidate and extra-issue paths. */
export const CONFIDENCE_FINDING = 80;
export const CONFIDENCE_UNVERIFIED = 25;

/** Wording that means the model itself did not verify the claim, whatever score it gave. */
const DOUBT_PATTERNS = [
  /无法确认/, /无法核实/, /无法判断/, /未能确认/, /证据不足/, /证据被截断/, /不足以确认/, /不确定/,
  /could not (?:confirm|verify)/i,
  /cannot (?:confirm|verify)/i,
  /unable to (?:confirm|verify)/i,
  /insufficient evidence/i,
  /not (?:been )?verified/i,
  /\buncertain\b/i,
];

function selfReportedDoubt(point) {
  return DOUBT_PATTERNS.some((pattern) => pattern.test(point));
}

/**
 * Turn the verifier's confidence scores into publishable findings and unverified notes.
 * 80+ is a finding, 25-79 is kept as an unverified note, below 25 is a false positive.
 */
export function partitionVerdicts(raw, concerns) {
  const candidates = Array.isArray(concerns) ? concerns : [];
  const issues = [];
  const unverified = [];
  const seen = new Set();
  let dropped = 0;
  const severityOf = (item, fallback) => {
    if (item !== null && item !== undefined) {
      if (item.severity === 'block') return 'block';
      if (item.severity === 'suggest') return 'suggest';
    }
    return fallback?.severity === 'block' ? 'block' : 'suggest';
  };
  const addIssue = (item, fallback) => {
    const point = typeof item?.point === 'string' && item.point.trim() !== ''
      ? item.point.trim()
      : (fallback?.point ?? '');
    if (point === '' || seen.has(point)) return;
    seen.add(point);
    // One suggestion per finding: the verifier's rewrite wins, else the candidate's own.
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
  const results = (Array.isArray(raw?.results) ? raw.results : []).filter((item) => item !== null && typeof item === 'object');
  // The contract numbers candidates from 1; a reply numbered from 0 is a common slip and
  // is shifted as a whole rather than mis-attributed one slot down.
  const zeroBased = results.some((item) => item.index === 0) && !results.some((item) => item.index === 1);
  const answered = new Set();
  for (const item of results) {
    const rawIndex = Number.isInteger(item.index) ? item.index : -1;
    const index = zeroBased ? rawIndex + 1 : rawIndex;
    // An out-of-range result cannot be attached to a candidate. The prompt promises such
    // results are dropped; publishing an unanchored finding would break that promise.
    if (index < 1 || index > candidates.length) {
      dropped += 1;
      continue;
    }
    answered.add(index);
    const concern = candidates[index - 1] ?? null;
    const point = typeof item.point === 'string' && item.point.trim() !== ''
      ? item.point.trim()
      : (concern?.point ?? '');
    if (point === '') {
      dropped += 1;
      continue;
    }
    const confidence = typeof item.confidence === 'number' && Number.isFinite(item.confidence)
      ? Math.max(0, Math.min(100, item.confidence))
      : 0;
    // A high score cannot override the model's own wording: "I could not confirm" is an
    // unverified note even if it also said 90.
    const doubt = selfReportedDoubt(point);
    if (confidence >= CONFIDENCE_FINDING && !doubt) {
      addIssue({ ...item, point }, concern);
    } else if (confidence >= CONFIDENCE_UNVERIFIED || doubt) {
      unverified.push({
        point,
        missing: typeof item.missing === 'string' && item.missing.trim() !== ''
          ? item.missing.trim()
          : (doubt ? '模型自述证据不足' : '证据不足以确认'),
      });
    } else {
      dropped += 1;
    }
  }
  // A candidate the verifier never answered must not vanish: an empty or partial reply
  // would otherwise look like "raised 3, filtered 0, nothing found".
  candidates.forEach((concern, offset) => {
    if (answered.has(offset + 1)) return;
    const point = typeof concern?.point === 'string' ? concern.point.trim() : '';
    if (point === '') return;
    unverified.push({ point, missing: '复审未返回该候选的判定' });
  });
  for (const item of Array.isArray(raw?.extraIssues) ? raw.extraIssues : []) {
    if (item === null || typeof item !== 'object') continue;
    // Evidence-triggered findings skip the candidate index but not the confidence bar;
    // a model that omits the score still gets the benefit of the doubt.
    const confidence = typeof item.confidence === 'number' && Number.isFinite(item.confidence)
      ? Math.max(0, Math.min(100, item.confidence))
      : CONFIDENCE_FINDING;
    const point = typeof item.point === 'string' ? item.point.trim() : '';
    if (point === '') {
      dropped += 1;
      continue;
    }
    const doubt = selfReportedDoubt(point);
    if (confidence >= CONFIDENCE_FINDING && !doubt) {
      addIssue(item, null);
    } else if (confidence >= CONFIDENCE_UNVERIFIED || doubt) {
      unverified.push({ point, missing: doubt ? '模型自述证据不足' : '证据不足以确认' });
    } else {
      dropped += 1;
    }
  }
  return { issues, unverified, dropped };
}

/** The triage pass output: display fields plus candidate problems, before any verification. */
export function normalizeReportDraft(raw, fallbackOrder) {
  const verdict = ['block', 'suggest', 'pass'].includes(raw?.verdict) ? raw.verdict : 'suggest';
  const seen = new Set();
  const order = [];
  if (Array.isArray(raw?.order)) {
    for (const item of raw.order) {
      if (item === null || typeof item !== 'object' || typeof item.file !== 'string') continue;
      if (seen.has(item.file)) continue;
      seen.add(item.file);
      order.push({ file: item.file, reason: typeof item.reason === 'string' ? item.reason : '' });
    }
  }
  for (const filePath of fallbackOrder) {
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    order.push({ file: filePath, reason: '' });
  }
  const focus = new Map();
  if (Array.isArray(raw?.focus)) {
    for (const item of raw.focus) {
      if (item === null || typeof item !== 'object' || typeof item.file !== 'string') continue;
      focus.set(item.file, typeof item.point === 'string' ? item.point : '');
    }
  }
  return {
    verdict,
    summary: typeof raw?.summary === 'string' ? raw.summary : '',
    order,
    focus: Object.fromEntries(focus.entries()),
    concerns: normalizeConcerns(raw?.concerns),
  };
}

/**
 * Normalize a final report for the browser half. `risks` is read from the input because the
 * two-pass flow passes the verifier's confirmed risks in; the raw `risks` field is also what
 * older cached records carry, so this stays the single restore path.
 */
export function normalizeReport(raw, fallbackOrder) {
  const draft = normalizeReportDraft(raw, fallbackOrder);
  const countOf = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0);
  const risks = Array.isArray(raw?.risks)
    ? raw.risks.filter((risk) => risk !== null && typeof risk === 'object').map((risk) => ({
        severity: risk.severity === 'block' ? 'block' : 'suggest',
        file: typeof risk.file === 'string' ? risk.file : '',
        point: typeof risk.point === 'string' ? risk.point : '',
      })).filter((risk) => risk.point !== '')
    : [];
  return {
    verdict: draft.verdict,
    summary: draft.summary,
    risks,
    unverified: normalizeUnverified(raw?.unverified),
    // Triage volume and how many candidates the verifier threw away: the panel uses these
    // to tell "nothing was raised" from "everything raised was judged a false positive".
    raised: countOf(raw?.raised),
    discarded: countOf(raw?.discarded),
    order: draft.order,
    focus: draft.focus,
  };
}

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
      // Re-review lineage (spec v7): roundItem references the baseline snapshot entry this
      // finding carries over; unjudged marks entries the model never explicitly judged
      // (they fall back to still-open instead of "fixed"). Absent on fresh findings.
      ...(Number.isInteger(item.roundItem) && item.roundItem > 0 ? { roundItem: Math.floor(item.roundItem) } : {}),
      ...(item.unjudged === true ? { unjudged: true } : {}),
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

/** One comparable key for a published conclusion item (kind + file + normalized text). */
export function findingKey(item) {
  return `${item?.kind ?? ''}|${item?.file ?? ''}|${String(item?.point ?? '').replace(/\s+/g, ' ').trim().toLowerCase()}`;
}

/** The numbered items a published conclusion comment contains (stable id + legacy key). */
export function commentItems(conclusion) {
  if (conclusion === null || conclusion === undefined) return [];
  const items = [];
  for (const item of Array.isArray(conclusion.blockers) ? conclusion.blockers : []) {
    const file = typeof item?.file === 'string' ? item.file : '';
    const point = typeof item?.point === 'string' ? item.point : '';
    const id = typeof item?.id === 'string' && item.id !== '' ? item.id : itemId('blocker', file, point);
    items.push({ kind: 'blocker', id, file, point, line: normalizeItemLine(item?.line) });
  }
  for (const item of Array.isArray(conclusion.suggestions) ? conclusion.suggestions : []) {
    const file = typeof item?.file === 'string' ? item.file : '';
    const point = typeof item?.point === 'string' ? item.point : '';
    const id = typeof item?.id === 'string' && item.id !== '' ? item.id : itemId('suggestion', file, point);
    items.push({ kind: 'suggestion', id, file, point, line: normalizeItemLine(item?.line) });
  }
  return items.map((item, index) => ({ ...item, index: index + 1, key: findingKey(item) }));
}

/**
 * Compare the previous round's published items with the current round's items.
 * Ids win; otherwise a kind+file+point pair with >= 0.62 similarity still counts as
 * open, so a reworded finding is not reported as "resolved".
 */
export function compareComments(previousItems, currentItems) {
  const previous = Array.isArray(previousItems) ? previousItems : [];
  const current = Array.isArray(currentItems) ? currentItems : [];
  const idOf = (item) => (
    typeof item?.id === 'string' && item.id !== ''
      ? item.id
      : itemId(item?.kind, item?.file, item?.point)
  );
  const usedCurrent = new Set();
  const resolved = [];
  const stillOpen = [];
  for (const item of previous) {
    const previousId = idOf(item);
    let matchIndex = current.findIndex((candidate, index) => !usedCurrent.has(index) && idOf(candidate) === previousId);
    if (matchIndex === -1) {
      matchIndex = current.findIndex((candidate, index) => (
        !usedCurrent.has(index)
        && String(candidate?.kind ?? '') === String(item?.kind ?? '')
        && comparable(candidate?.file) === comparable(item?.file)
        && textSimilarity(candidate?.point, item?.point) >= 0.62
      ));
    }
    if (matchIndex === -1) {
      resolved.push(item);
      continue;
    }
    usedCurrent.add(matchIndex);
    stillOpen.push(item);
  }
  return { resolved, stillOpen };
}

/** Prompt for parsing the developers' replies to our published review comment. */
export function buildFeedbackPrompt(pull, items, comments, options = {}) {
  const itemLines = (Array.isArray(items) ? items : [])
    .map((item) => `${item.index}. [${item.kind === 'blocker' ? '阻塞' : '建议'}] ${item.file === '' ? '' : `${item.file} — `}${item.point}`)
    .join('\n');
  const commentLines = (Array.isArray(comments) ? comments : [])
    .map((comment) => `--- ${comment.author} @ ${comment.createdAt}\n${String(comment.body ?? '').slice(0, 4000)}`)
    .join('\n\n');
  const user = [
    `PR #${pull?.number ?? ''}：${pull?.title ?? ''}`,
    '',
    '## 我们已发布的审查意见（编号）',
    itemLines === '' ? '（无）' : itemLines,
    '',
    '## PR 实现者/其他人在评论区的回复（按时间）',
    commentLines === '' ? '（无）' : commentLines,
    '',
    '请判断每条审查意见在回复中的处置情况，严格输出 JSON：',
    '{',
    '  "items": [{ "index": 1, "status": "fixed-claimed | disputed | accepted | question", "reason": "引用回复原话，简要说明" }],',
    '  "notes": ["无法对应到具体编号的其他重要反馈"]',
    '}',
    'status 含义：fixed-claimed=作者表示已修复或已改；disputed=作者认为不成立/误报；accepted=作者认可但尚未修复；question=作者在询问澄清。只输出回复中确实提到的条目；没有提到的条目不要出现在 items 里。',
  ].join('\n');
  return { system: compactSystem(languageOf(options)), messages: [{ role: 'user', content: [{ type: 'text', text: user }] }], maxTokens: 3000, timeoutMs: 300_000, temperature: 0.1 };
}

/** Parse the feedback model reply into per-item states. */
export function parseFeedbackReply(raw) {
  const fallback = String(raw ?? '').trim();
  const parsed = extractJson(raw);
  if (parsed === null || !Array.isArray(parsed.items)) {
    return { states: [], notes: [], raw: fallback };
  }
  const allowed = new Set(['fixed-claimed', 'disputed', 'accepted', 'question']);
  const states = [];
  for (const item of parsed.items) {
    if (item === null || typeof item !== 'object') continue;
    const index = typeof item.index === 'number' ? Math.floor(item.index) : 0;
    if (index < 1) continue;
    states.push({
      index,
      status: allowed.has(item.status) ? item.status : 'question',
      reason: typeof item.reason === 'string' ? item.reason.trim() : '',
    });
  }
  return {
    states,
    notes: Array.isArray(parsed.notes) ? parsed.notes.filter((note) => typeof note === 'string') : [],
    raw: fallback,
  };
}

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

/** Split one chat reply into its answer text and the mutations it asks for. */
export function parseChatReply(raw) {
  const fallback = String(raw ?? '').trim();
  const parsed = extractJson(raw);
  if (parsed === null || typeof parsed.answer !== 'string') {
    return { answer: fallback, ops: [] };
  }
  return { answer: parsed.answer.trim(), ops: normalizeFindingOps(parsed.findingOps ?? parsed.suggestionOps) };
}

// ---------- stable item ids, similarity, structured merge, comment rendering ----------

/** Comparable text: whitespace-collapsed, lower-cased, capped so similarity stays cheap. */
function comparable(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 600);
}

/** Plain Levenshtein distance over two short strings (two rolling rows). */
function editDistance(left, right) {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  let previous = new Array(right.length + 1);
  let current = new Array(right.length + 1);
  for (let column = 0; column <= right.length; column += 1) previous[column] = column;
  for (let row = 1; row <= left.length; row += 1) {
    current[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left.charCodeAt(row - 1) === right.charCodeAt(column - 1) ? 0 : 1;
      current[column] = Math.min(previous[column] + 1, current[column - 1] + 1, previous[column - 1] + cost);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[right.length];
}

/** 0..1 similarity between two points; identical normalized text scores 1. */
export function textSimilarity(left, right) {
  const a = comparable(left);
  const b = comparable(right);
  if (a === '' || b === '') return a === b ? 1 : 0;
  if (a === b) return 1;
  return 1 - editDistance(a, b) / Math.max(a.length, b.length);
}

const KIND_PREFIX = { blocker: 'b', suggestion: 's' };

function kindPrefix(kind) {
  return KIND_PREFIX[kind] ?? (String(kind).startsWith('b') ? 'b' : 's');
}

/** Stable short id for one conclusion item: same kind + file + point → same id. */
export function itemId(kind, file, point) {
  const seed = `${kind ?? ''}|${comparable(file)}|${comparable(point)}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${kindPrefix(kind)}-${hash.toString(16).padStart(8, '0').slice(0, 6)}`;
}

/** A model-provided id is kept only when it is safe to embed and reuse. */
function validItemId(value) {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{2,31}$/.test(value.trim());
}

/** PR head new-file line number: only finite positive integers, everything else is 0. */
function normalizeItemLine(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

/** Give legacy conclusion items a stable id and a `line` field (mutates in place; old caches only). */
export function ensureConclusionIds(conclusion) {
  if (conclusion === null || typeof conclusion !== 'object') return conclusion;
  for (const kind of ['blocker', 'suggestion']) {
    const list = kind === 'blocker' ? conclusion.blockers : conclusion.suggestions;
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (item === null || typeof item !== 'object') continue;
      if (!validItemId(item.id)) item.id = itemId(kind, item.file, item.point);
      if (!(typeof item.line === 'number' && Number.isInteger(item.line) && item.line > 0)) item.line = 0;
    }
  }
  return conclusion;
}

const VERDICTS = new Set(['block', 'suggest', 'pass']);

/** Clamp one verdict to the known set; unknown values fall back (never trust a model enum). */
export function normalizeVerdict(value, fallback = 'suggest') {
  return VERDICTS.has(value) ? value : fallback;
}

/**
 * Normalize the final conclusion: stable ids, no empty items, no duplicate items,
 * and no phantom files (a file outside the review is marked in the point instead).
 * options.files (string[] or [{path}]) is the review's changed-file list.
 */
export function normalizeConclusion(raw, options = {}) {
  const filePaths = Array.isArray(options.files)
    ? new Set(options.files
        .map((file) => (typeof file === 'string' ? file : file?.path))
        .filter((file) => typeof file === 'string' && file !== ''))
    : null;
  const build = (kind, value) => {
    const items = [];
    const seenKeys = new Set();
    const seenIds = new Set();
    for (const item of Array.isArray(value) ? value : []) {
      if (item === null || typeof item !== 'object') continue;
      let point = typeof item.point === 'string' ? item.point.trim() : '';
      if (point === '') continue;
      const originalFile = typeof item.file === 'string' ? item.file.trim() : '';
      let file = originalFile;
      if (file !== '' && filePaths !== null && !filePaths.has(file)) {
        point = `（未定位：${originalFile}）${point}`;
        file = '';
      }
      const line = normalizeItemLine(item.line);
      const key = `${kind}|${comparable(file)}|${comparable(point)}`;
      if (seenKeys.has(key)) continue;
      const provided = validItemId(item.id) ? item.id.trim() : '';
      const id = provided !== '' && !seenIds.has(provided) ? provided : itemId(kind, file, point);
      if (seenIds.has(id)) continue;
      seenKeys.add(key);
      seenIds.add(id);
      items.push({ id, file, point, line });
    }
    return items;
  };
  return {
    verdict: normalizeVerdict(raw?.verdict),
    summary: typeof raw?.summary === 'string' ? raw.summary.trim() : '',
    blockers: build('blocker', raw?.blockers),
    suggestions: build('suggestion', raw?.suggestions),
    nextSteps: Array.isArray(raw?.nextSteps)
      ? raw.nextSteps.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
      : [],
  };
}

/**
 * Deterministic verdict calibration (P0).
 * A human-edited conclusion is returned untouched; otherwise blockers or an explicit
 * block severity win, and a "pass" that still carries suggestions becomes "suggest".
 * The conclusion model holds the final say on blockers: its prompt carries every
 * per-file analysis, so a per-file block it explicitly dismissed ("复核均不成立") must
 * not be re-imposed here. `fileSeverities` used to force a "block" verdict regardless
 * of that review — it produced a「阻塞」结论 with an empty blocker list (PR #32 round 7),
 * so it no longer participates.
 */
export function calibrateVerdict(conclusion, options = {}) {
  if (conclusion === null || conclusion === undefined) return conclusion;
  if (options.humanEdited === true) return conclusion;
  const verdict = normalizeVerdict(conclusion.verdict);
  const blockers = Array.isArray(conclusion.blockers) ? conclusion.blockers : [];
  const suggestions = Array.isArray(conclusion.suggestions) ? conclusion.suggestions : [];
  const blocked = blockers.length > 0
    || blockers.some((item) => item?.severity === 'block')
    || suggestions.some((item) => item?.severity === 'block');
  if (blocked) return { ...conclusion, verdict: 'block' };
  if (verdict === 'pass' && suggestions.length > 0) return { ...conclusion, verdict: 'suggest' };
  return conclusion.verdict === verdict ? conclusion : { ...conclusion, verdict };
}

/**
 * How much of the changed-file list has a finished per-file explanation.
 * `explanations` accepts the record's Map (path → entry or explanation), an array
 * of {file}, or a plain object keyed by path.
 */
export function conclusionCoverage(explanations, files) {
  const fileList = (Array.isArray(files) ? files : [])
    .map((file) => (typeof file === 'string' ? file : file?.path))
    .filter((file) => typeof file === 'string' && file !== '');
  const analyzedPaths = new Set();
  const accept = (filePath, value) => {
    if (typeof filePath !== 'string' || filePath === '') return;
    if (value === null || value === undefined) return;
    if (typeof value === 'object' && typeof value.status === 'string' && value.status !== 'done') return;
    analyzedPaths.add(filePath);
  };
  if (explanations instanceof Map) {
    for (const [filePath, value] of explanations) accept(filePath, value);
  } else if (Array.isArray(explanations)) {
    for (const value of explanations) {
      if (value !== null && typeof value === 'object') accept(value.file, value);
    }
  } else if (explanations !== null && typeof explanations === 'object') {
    for (const filePath of Object.keys(explanations)) accept(filePath, explanations[filePath]);
  }
  const unanalyzed = fileList.filter((filePath) => !analyzedPaths.has(filePath));
  return { analyzed: fileList.length - unanalyzed.length, total: fileList.length, unanalyzed };
}

/** Items of one kind from a previous conclusion, with a guaranteed stable id. */
function previousItemsOf(conclusion, kind) {
  const list = Array.isArray(conclusion?.[kind === 'blocker' ? 'blockers' : 'suggestions'])
    ? conclusion[kind === 'blocker' ? 'blockers' : 'suggestions']
    : [];
  return list
    .filter((item) => item !== null && typeof item === 'object')
    .map((item) => ({
      id: validItemId(item.id) ? item.id.trim() : itemId(kind, item.file, item.point),
      file: typeof item.file === 'string' ? item.file : '',
      point: typeof item.point === 'string' ? item.point : '',
      line: normalizeItemLine(item.line),
    }))
    .filter((item) => item.point.trim() !== '');
}

/**
 * Merge a freshly generated conclusion into the previous version:
 * generated items inherit the previous id when they match (same id, or same
 * kind+file with >= 0.6 point similarity); human-locked items the model dropped
 * are appended verbatim; the result is deduplicated by id.
 */
export function mergeConclusion(previous, generated, options = {}) {
  const generatedConclusion = normalizeConclusion(generated !== null && typeof generated === 'object' ? generated : {});
  const previousConclusion = previous !== null && typeof previous === 'object' ? previous : null;
  const locked = new Set((Array.isArray(options.lockedItemIds) ? options.lockedItemIds : [])
    .filter((id) => typeof id === 'string' && id !== ''));
  const merged = {
    verdict: generatedConclusion.verdict,
    summary: generatedConclusion.summary !== ''
      ? generatedConclusion.summary
      : (typeof previousConclusion?.summary === 'string' ? previousConclusion.summary : ''),
    blockers: [],
    suggestions: [],
    nextSteps: [...generatedConclusion.nextSteps],
  };
  for (const kind of ['blocker', 'suggestion']) {
    const field = kind === 'blocker' ? 'blockers' : 'suggestions';
    const generatedList = generatedConclusion[field];
    const previousList = previousItemsOf(previousConclusion, kind);
    const usedPrevious = new Set();
    const usedIds = new Set();
    for (const item of generatedList) {
      let matched = previousList.find((old) => !usedPrevious.has(old.id) && old.id === item.id);
      if (matched === undefined) {
        matched = previousList.find((old) => (
          !usedPrevious.has(old.id)
          && comparable(old.file) === comparable(item.file)
          && textSimilarity(old.point, item.point) >= 0.6
        ));
      }
      const id = matched === undefined ? item.id : matched.id;
      if (matched !== undefined) usedPrevious.add(matched.id);
      if (usedIds.has(id)) continue;
      usedIds.add(id);
      // A reworded match keeps the old line until the model supplies a new one.
      const line = item.line === 0 && matched !== undefined ? matched.line : item.line;
      merged[field].push({ ...item, id, line });
    }
    // Human-locked items stay, even when the model forgot them this time.
    for (const old of previousList) {
      if (!locked.has(old.id)) continue;
      if (usedPrevious.has(old.id) || usedIds.has(old.id)) continue;
      usedIds.add(old.id);
      merged[field].push({ id: old.id, file: old.file, point: old.point, line: old.line });
    }
  }
  return merged;
}

const COMMENT_VERDICT_LABELS = {
  zh: {
    block: '阻塞（必须修复后才能合并）',
    suggest: '建议（可不修，择机处理）',
    pass: '通过（无阻塞项）',
  },
  en: {
    block: 'Block (must fix before merge)',
    suggest: 'Suggest (optional)',
    pass: 'Pass (no blockers)',
  },
};

/**
 * Severity tags used inside the comment appendix. `suggest` reads as "提示" so it never shares
 * the word "建议" with the real suggestion sub-lines (`  - 建议：…`): an issue/risk at suggestion
 * severity is a note, not a change request.
 */
const COMMENT_SEVERITY_LABELS = {
  zh: { block: '阻塞', suggest: '提示' },
  en: { block: 'Block', suggest: 'Note' },
};

const COMMENT_FOOTER = {
  zh: '由 DeepSeek harness PR 审查插件生成',
  en: 'Generated by DeepSeek harness PR review plugin',
};

const COMMENT_APPENDIX = {
  zh: {
    summary: '审查附录：总体初筛风险 / 逐文件审查发现 / 审查顺序',
    risks: '总体初筛风险',
    files: '逐文件审查发现',
    order: '审查顺序',
    unanalyzed: '未分析文件',
    suggestion: '建议',
    line: '行',
    more: '…另有 {count} 条',
    omitted: '> 附录过长已省略，完整内容见审查面板。',
    truncated: '> 评论过长已截断，完整内容见审查面板。',
  },
  en: {
    summary: 'Review appendix: initial risks / per-file findings / reading order',
    risks: 'Initial risks',
    files: 'Per-file findings',
    order: 'Reading order',
    unanalyzed: 'Files not analyzed',
    suggestion: 'Suggestion',
    line: 'line',
    more: '…and {count} more',
    omitted: '> Appendix omitted for length; see the review panel.',
    truncated: '> Comment truncated for length; see the review panel.',
  },
};

/** Comment bodies are capped well below the Gitea/Forgejo/GitHub 65536-char limit. */
const MAX_COMMENT_CHARS = 60000;

/** Fill `{count}` in the appendix labels. */
function appendixCount(template, count) {
  return String(template).replaceAll('{count}', String(count));
}

/** One `[severity] file:line — point` bullet for the appendix. */
function appendixBullet(item, zh) {
  const severityLabels = zh ? COMMENT_SEVERITY_LABELS.zh : COMMENT_SEVERITY_LABELS.en;
  const severity = severityLabels[item.severity] ?? '';
  const file = typeof item.file === 'string' ? item.file : '';
  const hasLine = Number.isFinite(item.line) && item.line > 0;
  const prefix = severity === '' ? '' : `[${severity}] `;
  const labels = zh ? COMMENT_APPENDIX.zh : COMMENT_APPENDIX.en;
  if (file === '') {
    // Per-file findings sit under their file heading; keep the line number visible.
    const lineNote = hasLine ? `（${labels.line} ${Math.floor(item.line)}）` : '';
    return `- ${prefix}${item.point}${lineNote}`;
  }
  return `- ${prefix}\`${file}${hasLine ? `:${Math.floor(item.line)}` : ''}\` — ${item.point}`;
}

/**
 * Markdown appendix for the PR comment: the review content that is too long for the main
 * body (initial risks, per-file findings, reading order, unanalyzed
 * files). Compact mode keeps only the first few entries per section.
 */
export function buildCommentAppendix(appendix, language = 'zh', compact = false) {
  if (appendix === null || appendix === undefined) return '';
  const zh = language !== 'en';
  const labels = zh ? COMMENT_APPENDIX.zh : COMMENT_APPENDIX.en;
  const caps = compact
    ? { risks: 8, files: 6, perFile: 2, order: 8, unanalyzed: 8 }
    : { risks: 40, files: 40, perFile: 5, order: 40, unanalyzed: 100 };
  const sections = [];
  const more = (count) => (count > 0 ? appendixCount(labels.more, count) : '');
  const risks = Array.isArray(appendix.risks) ? appendix.risks : [];
  if (risks.length > 0) {
    const shown = risks.slice(0, caps.risks);
    const lines = [`#### ${labels.risks}`, ...shown.map((item) => appendixBullet(item, zh))];
    if (risks.length > shown.length) lines.push(more(risks.length - shown.length));
    sections.push(lines.join('\n'));
  }
  const files = Array.isArray(appendix.files) ? appendix.files : [];
  if (files.length > 0) {
    const blocks = [];
    for (const entry of files.slice(0, caps.files)) {
      const lines = [`**${entry.file}**`];
      // One merged findings list per file: each finding is a bullet, its inline suggestion
      // (if any) an indented sub-line so advice stays attached to the finding it fixes.
      for (const finding of (Array.isArray(entry.findings) ? entry.findings : []).slice(0, caps.perFile)) {
        lines.push(appendixBullet(finding, zh));
        const advice = typeof finding?.suggestion === 'string' ? finding.suggestion.trim() : '';
        if (advice !== '') {
          const suggestionLabel = zh ? `${labels.suggestion}：` : `${labels.suggestion}: `;
          lines.push(`  - ${suggestionLabel}${advice}`);
        }
      }
      blocks.push(lines.join('\n'));
    }
    if (files.length > caps.files) blocks.push(more(files.length - caps.files));
    sections.push([`#### ${labels.files}`, ...blocks].join('\n\n'));
  }
  const order = Array.isArray(appendix.order) ? appendix.order : [];
  if (order.length > 0) {
    const shown = order.slice(0, caps.order);
    const lines = shown.map((item, index) => (
      `${index + 1}. \`${item.file}\`${item.reason === '' ? '' : ` — ${item.reason}`}`
    ));
    if (order.length > shown.length) lines.push(more(order.length - shown.length));
    sections.push([`#### ${labels.order}`, ...lines].join('\n'));
  }
  const unanalyzed = Array.isArray(appendix.unanalyzed) ? appendix.unanalyzed : [];
  if (unanalyzed.length > 0) {
    const shown = unanalyzed.slice(0, caps.unanalyzed);
    const lines = shown.map((file) => `- \`${file}\``);
    if (unanalyzed.length > shown.length) lines.push(more(unanalyzed.length - shown.length));
    sections.push([`#### ${labels.unanalyzed}`, ...lines].join('\n'));
  }
  if (sections.length === 0) return '';
  return `<details>\n<summary>${labels.summary}</summary>\n\n${sections.join('\n\n')}\n\n</details>`;
}

/**
 * Compose the pull-request comment from the final conclusion.
 *
 * options.language / options.coverage keep their original meaning. The rest carries the
 * "full communication" payload: the reviewed commit + version header, the publish-selection
 * note (so a partial selection never reads as "no blockers"), the unanalyzed-file suffix on
 * the coverage line, the foldable appendix built by `buildCommentAppendix`, and a length
 * guard that shrinks the appendix before touching the conclusion.
 */
export function buildCommentMarkdown(conclusion, pull, round, options = {}) {
  const language = normalizeLanguage(options.language);
  const zh = language === 'zh';
  const labels = COMMENT_VERDICT_LABELS[language];
  const verdict = labels[conclusion?.verdict] ?? labels.suggest;
  const title = typeof pull?.title === 'string' ? pull.title.trim() : '';
  const number = typeof pull?.number === 'number' ? pull.number : 0;
  const roundNumber = typeof round === 'number' && round > 0 ? round : 1;
  const roundLabel = roundNumber > 1
    ? (zh ? `（第 ${roundNumber} 轮复审）` : ` (round ${roundNumber} re-review)`)
    : '';
  const appendix = options.appendix ?? null;
  // Files named in the appendix get a pointer to it; a bare count does not.
  const listedUnanalyzed = Array.isArray(appendix?.unanalyzed)
    ? appendix.unanalyzed.filter((file) => typeof file === 'string' && file !== '')
    : [];
  const lines = [];
  lines.push(zh
    ? `## PR 审查结论${roundLabel}：${verdict}`
    : `## PR review conclusion${roundLabel}: ${verdict}`);
  lines.push('');
  if (number > 0) {
    lines.push(`> #${number}${title === '' ? '' : ` ${title}`}`);
    lines.push('');
  }
  // Commit + round + conclusion version: the comment must be traceable to what was reviewed.
  const headSha = typeof options.headSha === 'string' ? options.headSha.trim() : '';
  const version = Number.isFinite(options.version) ? Number(options.version) : 0;
  if (headSha !== '' || version > 0) {
    const metaParts = [];
    if (headSha !== '') metaParts.push(`\`commit ${headSha.slice(0, 8)}\``);
    metaParts.push(zh ? `第 ${roundNumber} 轮` : `round ${roundNumber}`);
    if (version > 0) metaParts.push(zh ? `结论 v${version}` : `conclusion v${version}`);
    lines.push(metaParts.join(' · '));
    lines.push('');
  }
  const summary = typeof conclusion?.summary === 'string' ? conclusion.summary.trim() : '';
  if (summary !== '') {
    lines.push(summary);
    lines.push('');
  }
  const coverage = options.coverage === null || options.coverage === undefined
    ? (conclusion?.coverage ?? null)
    : options.coverage;
  if (coverage !== null && typeof coverage === 'object') {
    const analyzed = Number.isFinite(coverage.analyzed) ? coverage.analyzed : 0;
    const total = Number.isFinite(coverage.total) ? coverage.total : 0;
    const coverageList = Array.isArray(coverage.unanalyzed) ? coverage.unanalyzed.length : 0;
    const missing = listedUnanalyzed.length > 0
      ? listedUnanalyzed.length
      : Math.max(coverageList, Math.max(0, total - analyzed));
    const suffix = missing === 0
      ? ''
      : (listedUnanalyzed.length > 0
          ? (zh ? `（${missing} 个未分析，清单见附录）` : ` (${missing} unanalyzed, see appendix)`)
          : (zh ? `（${missing} 个未分析）` : ` (${missing} unanalyzed)`));
    lines.push(zh
      ? `覆盖：已分析 ${analyzed}/${total} 个变更文件${suffix}。`
      : `Coverage: analyzed ${analyzed}/${total} changed files${suffix}.`);
    lines.push('');
  }
  // A partial publish selection must never read as "no blockers": say what was left out.
  const selection = options.selection ?? null;
  if (selection !== null && selection.total > selection.included) {
    lines.push(zh
      ? `本次评论仅纳入 ${selection.included}/${selection.total} 条审查意见；未纳入的条目保留在审查面板，可在下一轮复审前处理。`
      : `This comment includes ${selection.included}/${selection.total} review items; the rest stay in the review panel until the next round.`);
    lines.push('');
  }
  const numbered = commentItems(conclusion);
  const section = (heading, empty, kind, omitted) => {
    lines.push(`### ${heading}`);
    const items = numbered.filter((item) => item.kind === kind);
    if (items.length === 0 && omitted <= 0) {
      lines.push(empty);
      lines.push('');
      return;
    }
    for (const item of items) {
      const location = item.file === '' ? '' : (item.line > 0 ? `${item.file}:${item.line}` : item.file);
      const file = location === '' ? '' : `\`${location}\` — `;
      lines.push(`${item.index}. ${file}${item.point}`);
    }
    // Partial or full omission is stated, so the list never reads as complete.
    if (omitted > 0) {
      lines.push(zh
        ? `本次评论未纳入 ${omitted} 条${heading}（见审查面板）。`
        : `${omitted} ${kind} item(s) were left out of this comment; see the review panel.`);
    }
    lines.push('');
  };
  section(
    zh ? '阻塞项' : 'Blockers',
    zh ? '无阻塞项。' : 'No blockers.',
    'blocker',
    selection === null ? 0 : (selection.omittedBlockers ?? 0),
  );
  section(
    zh ? '修改建议' : 'Suggestions',
    zh ? '暂无。' : 'None yet.',
    'suggestion',
    selection === null ? 0 : (selection.omittedSuggestions ?? 0),
  );
  lines.push(`### ${zh ? '下一步' : 'Next steps'}`);
  const nextSteps = Array.isArray(conclusion?.nextSteps) ? conclusion.nextSteps : [];
  if (nextSteps.length === 0) {
    lines.push(zh ? '暂无。' : 'None yet.');
  } else {
    for (const step of nextSteps) lines.push(`- [ ] ${step}`);
  }
  const body = lines.join('\n');
  const finished = new Date();
  const stamp = Number.isNaN(finished.getTime())
    ? ''
    : finished.toLocaleString(zh ? 'zh-CN' : 'en-US', { hour12: false });
  const footer = ['---', `<sub>${COMMENT_FOOTER[language]}${stamp === '' ? '' : ` · ${stamp}`}</sub>`].join('\n');
  // Keep the whole body under the platform limit: shrink, then drop the appendix, then
  // hard-truncate with a pointer to the review panel.
  const assemble = (appendixText, note) => {
    const parts = [body];
    if (note !== '') parts.push(note);
    if (appendixText !== '') parts.push(appendixText);
    parts.push(footer);
    return parts.join('\n\n');
  };
  const omittedNote = zh ? COMMENT_APPENDIX.zh.omitted : COMMENT_APPENDIX.en.omitted;
  const truncatedNote = zh ? COMMENT_APPENDIX.zh.truncated : COMMENT_APPENDIX.en.truncated;
  let text = assemble(buildCommentAppendix(appendix, language, false), '');
  if (text.length > MAX_COMMENT_CHARS) text = assemble(buildCommentAppendix(appendix, language, true), '');
  if (text.length > MAX_COMMENT_CHARS) text = assemble('', omittedNote);
  if (text.length > MAX_COMMENT_CHARS) {
    const limit = MAX_COMMENT_CHARS - 160;
    const cut = text.slice(0, limit);
    const lastBreak = cut.lastIndexOf('\n\n');
    const kept = lastBreak > limit / 2 ? cut.slice(0, lastBreak) : cut;
    text = `${kept}\n\n${truncatedNote}`;
  }
  return text;
}

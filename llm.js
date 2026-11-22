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
  const user = renderPrompt('feedback', {
    pullNumber: pull?.number ?? '',
    title: pull?.title ?? '',
    itemLines: itemLines === '' ? '（无）' : itemLines,
    commentLines: commentLines === '' ? '（无）' : commentLines,
  });
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

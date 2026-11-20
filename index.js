/**
 * Host half of the PR review plugin.
 *
 * Responsibilities:
 * - poll one code host (GitHub, or a Gitea-compatible host such as Gitea /
 *   Forgejo / Codeberg) for open pull requests and review
 *   new heads automatically when `autoReview` is on;
 * - answer the browser half over same-origin `/pr-review-api/*` routes behind
 *   the connection trust fence;
 * - stream model calls through the Host `llm` service for the report, the
 *   per-file logic walkthrough, follow-up chat, and the final conclusion.
 *
 * The browser half owns presentation only; every fact here comes from the API
 * or the model, and a failure carries its reason.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { HarnessError } from '@deepseek-ai/dsh-llm';
import Schema from '@deepseek-ai/schemastery';

import { createClient, MAX_PULL_FILES, missingTokenMessage, resolveProviderConfig, resolveToken } from './providers.js';
import { parseDiff } from './diff.js';
import {
  buildChatPrompt,
  buildCommentMarkdown,
  buildConcludePrompt,
  buildFeedbackPrompt,
  calibrateVerdict,
  commentItems,
  conclusionCoverage,
  ensureConclusionIds,
  parseChatReply,
  parseFeedbackReply,
  buildExplainPrompt,
  buildExplainVerifyPrompt,
  buildReportPrompt,
  buildReportVerifyPrompt,
  callModel,
  extractJson,
  findingsOf,
  itemId,
  mergeConclusion,
  normalizeConcerns,
  normalizeConclusion,
  normalizeEvidenceNeeds,
  normalizeExplanation,
  normalizePreviousVerdicts,
  normalizeReport,
  normalizeReportDraft,
  normalizeVerdict,
  partitionVerdicts,
} from './llm.js';

/** Cordis function-plugin name. */
export const name = 'pr-review';

/** The route carrier, the trust fence, and the model service. The default model is read optionally via ctx.get. */
export const inject = ['webServer', 'connection', 'llm'];

const PREFIX = '/pr-review-api';

/**
 * Order of the panel snapshot among the host's runtime-context contributions. Built-in
 * placements stop at 210 (harness source, Web surface); external context sorts after them.
 */
const CONTEXT_ORDER = 300;

const DEFAULTS = {
  platform: 'forgejo',
  // Empty by default: the panel follows the workspace git origin. When repo/baseUrl are set,
  // they are the polling target used before a workspace is recognized; with the defaults nothing
  // is polled. A non-git workspace activates no repository.
  baseUrl: '',
  repo: '',
  token: '',
  organizationId: '',
  projectId: '',
  pollSeconds: 60,
  autoReview: true,
  autoAnalyze: true,
  provider: '',
  model: '',
  reasoningEffort: 'off',
  maxDiffCharsPerFile: 14000,
  commentLanguage: 'zh',
  autoReconclude: false,
  // Two-pass review: triage proposes concerns, the host collects evidence, a verifier scores
  // them. On by default (quality first); turn it off to spend one call per file as before.
  evidenceVerify: true,
  evidenceMaxFiles: 6,
  evidenceMaxChars: 6000,
};

/** GUI launches can have a minimal PATH; try the common absolute locations too. */
const GIT_CANDIDATES = ['git', '/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git'];

const MAX_BODY_BYTES = 64 * 1024;
const MAX_FILE_DIFF_BYTES = 400 * 1024;
/** The poll list caps the number of open pull requests: it also bounds auto-review cost. */
const MAX_LISTED_PRS = 20;
/** Safety valve for the memory/disk footprint of the review cache. */
const MAX_REVIEWS = 50;

/**
 * Config schema (Schemastery, a Standard Schema): the loader validates user values
 * and fills missing keys from these defaults before `apply(ctx, config)` runs.
 * Field defaults live in DEFAULTS and are referenced here, so the values have one source.
 */
export const Config = Schema.object({
  platform: Schema.union(['github', 'gitea', 'forgejo', 'gitlab', 'gitee', 'gitcode', 'atomgit', 'codeup']).default(DEFAULTS.platform),
  baseUrl: Schema.string().default(DEFAULTS.baseUrl),
  repo: Schema.string().default(DEFAULTS.repo),
  token: Schema.string().default(DEFAULTS.token),
  organizationId: Schema.string().default(DEFAULTS.organizationId),
  projectId: Schema.string().default(DEFAULTS.projectId),
  pollSeconds: Schema.number().min(15).default(DEFAULTS.pollSeconds),
  autoReview: Schema.boolean().default(DEFAULTS.autoReview),
  autoAnalyze: Schema.boolean().default(DEFAULTS.autoAnalyze),
  provider: Schema.string().default(DEFAULTS.provider),
  model: Schema.string().default(DEFAULTS.model),
  reasoningEffort: Schema.union(['off', 'low', 'high', 'max']).default(DEFAULTS.reasoningEffort),
  maxDiffCharsPerFile: Schema.number().min(1000).default(DEFAULTS.maxDiffCharsPerFile),
  commentLanguage: Schema.union(['zh', 'en']).default(DEFAULTS.commentLanguage),
  autoReconclude: Schema.boolean().default(DEFAULTS.autoReconclude),
  evidenceVerify: Schema.boolean().default(DEFAULTS.evidenceVerify),
  evidenceMaxFiles: Schema.number().min(1).max(20).default(DEFAULTS.evidenceMaxFiles),
  evidenceMaxChars: Schema.number().min(500).default(DEFAULTS.evidenceMaxChars),
});

/** Stable tool failure codes: the tool registry keeps `error.code` for HarnessError only. */
const TOOL_ERROR = Object.freeze({
  invalidArgs: 'INVALID_ARGS',
  notFound: 'NOT_FOUND',
  conflict: 'CONFLICT',
  staleRevision: 'STALE_REVISION',
  limitExceeded: 'LIMIT_EXCEEDED',
});

/** A tool failure with a stable machine-routable code (route on the code, never the message). */
function toolError(code, message) {
  return new HarnessError(message, code);
}

/** JSON response helper (no-store: every answer is a live fact). */
function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

/** One structured failure for the browser half. */
function sendError(res, status, code, message) {
  sendJson(res, status, { ok: false, error: { code, message } });
}

/** Collect a bounded request body as UTF-8 text; null past the ceiling. */
async function readBoundedBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) {
      req.resume();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

/** Parse a JSON body; null when the text is not a JSON object. */
function parseBody(text) {
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/** Serialize one review record for the browser half (no diff text, no Maps, no abort handles). */
function serializeReview(record) {
  if (record === undefined) return null;
  return {
    number: record.number,
    status: record.status,
    headSha: record.headSha,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    error: record.error,
    pull: record.pull,
    files: record.files,
    filesTruncated: record.filesTruncated === true,
    analyzing: record.analyzing === null || record.analyzing === undefined
      ? null
      : {
          total: record.analyzing.total,
          done: record.analyzing.done,
          failed: record.analyzing.failed,
          current: record.analyzing.current,
        },
    report: record.report,
    explanations: [...record.explanations.entries()].map(([filePath, entry]) => ({
      file: filePath,
      status: entry.status,
      error: entry.error,
      explanation: entry.explanation,
      chat: entry.chat,
      updatedAt: entry.updatedAt ?? 0,
      baselineVerdicts: Array.isArray(entry.baselineVerdicts) ? entry.baselineVerdicts : null,
    })),
    pullChat: record.pullChat,
    reportUpdatedAt: record.reportUpdatedAt ?? 0,
    conclusionEditedAt: record.conclusionEditedAt ?? 0,
    round: record.round ?? 1,
    roundHistory: Array.isArray(record.roundHistory) ? record.roundHistory : [],
    humanItemIds: Array.isArray(record.humanItemIds) ? record.humanItemIds : [],
    coverage: record.coverage ?? null,
    concluding: record.concluding === null || record.concluding === undefined
      ? null
      : { stage: record.concluding.stage, startedAt: record.concluding.startedAt },
    concludeError: record.concludeError ?? null,
    publishing: record.publishing === true,
    published: record.published ?? [],
    publishedItems: record.publishedItems ?? [],
    feedback: record.feedback ?? null,
    delta: findingsDeltaOf(record),
    conclusionAt: record.conclusionAt ?? 0,
    conclusion: record.conclusion,
    comment: record.comment ?? null,
    revision: record.revision ?? 0,
    audit: Array.isArray(record.audit) ? record.audit : [],
  };
}

/**
 * Freeze the round's finished per-file findings as the next round's comparison baseline
 * (review-delta spec v7): flattened through findingsOf and globally numbered, frozen in
 * full — per-file ordering is block first, then line ascending, original order otherwise.
 * Truncation happens only when the prompt is built (10 per file, declared there), so a
 * frozen finding never silently disappears from the comparison.
 */
function findingsSnapshotOf(record) {
  const byFile = [];
  for (const [filePath, entry] of record.explanations) {
    if (entry.status !== 'done' || entry.explanation === null || entry.explanation === undefined) continue;
    const group = findingsOf(entry.explanation).map((finding) => ({ ...finding, file: filePath }));
    group.sort((left, right) => (left.severity === right.severity ? 0 : left.severity === 'block' ? -1 : 1) || left.line - right.line);
    // 全量冻结，不丢条目：prompt 下发时再按文件截断（并声明截断），未下发的条目在
    // 对比里落「未判定」，绝不静默消失。
    byFile.push(...group.map((finding) => ({
      index: 0,
      file: finding.file,
      severity: finding.severity,
      point: finding.point,
      line: finding.line,
      suggestion: finding.suggestion,
    })));
  }
  return byFile.map((finding, index) => ({ ...finding, index: index + 1 }));
}

/**
 * The baseline round for the re-review comparison: the newest earlier round that
 * produced a conclusion (published or not) and thus froze a findings snapshot.
 * Rounds without a conclusion are skipped — their analysis never completed the
 * step that makes its findings a trustworthy baseline.
 */
function baselineRoundOf(record) {
  const history = roundHistoryOf(record);
  const current = currentRoundEntry(record);
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry === current) continue;
    // 基准 = 最近一个「生成过结论」的轮次（无论快照是否为空）：空快照意味着上一轮干净，
    // findingsDeltaOf 会因无条目而返回 null——绝不再向前回溯到更早的轮次。
    if ((entry.conclusions?.length ?? 0) > 0) {
      return entry;
    }
  }
  return null;
}

/**
 * The re-review comparison over the audit workspace (review-delta spec v7): the baseline
 * round's frozen findings versus this round's re-judgement. Every baseline finding gets a
 * status from the *persisted* baselineVerdicts the analysis wrote: resolved only when the
 * model explicitly judged it fixed (the single source of「已修复」), still-open when it
 * carried it over, undetermined when the model never judged it (missed or truncated),
 * pending while its file has not been re-analyzed. Reading the persisted verdicts (not
 * the current issues) makes later issue rewrites — chat findingOps, review_update_analysis,
 * clearFindings — unable to manufacture a fake resolved state.
 * Derived on read, never persisted; it never touches the conclusion layer (H1).
 */
function findingsDeltaOf(record) {
  const baseline = baselineRoundOf(record);
  if (baseline === null || !Array.isArray(baseline.findings) || baseline.findings.length === 0) return null;
  const entries = record.explanations instanceof Map
    ? record.explanations
    : new Map((Array.isArray(record.explanations) ? record.explanations : []).map((entry) => [entry.file, entry]));
  const analyzed = (filePath) => {
    const entry = entries.get(filePath);
    return entry !== undefined && entry.status === 'done'
      && entry.explanation !== null && entry.explanation !== undefined;
  };
  // Claims: baseline index → this round's carry-over entry (for the「仍未解决」row body —
  // the model's updated wording plus its suggestion). Display only: the status itself
  // comes from the persisted verdicts below.
  const claimOf = new Map();
  for (const [filePath, entry] of entries) {
    if (entry.status !== 'done' || entry.explanation === null || entry.explanation === undefined) continue;
    for (const finding of findingsOf(entry.explanation)) {
      if (finding.roundItem === undefined) continue;
      const previous = claimOf.get(finding.roundItem);
      const updatedAt = entry.updatedAt ?? 0;
      if (previous === undefined || updatedAt >= previous.updatedAt) {
        claimOf.set(finding.roundItem, { finding: { ...finding, file: filePath }, fromFile: filePath, updatedAt });
      }
    }
  }
  const resolved = [];
  const stillOpen = [];
  const undetermined = [];
  const pending = [];
  for (const finding of baseline.findings) {
    const entry = entries.get(finding.file);
    const fileAnalyzed = analyzed(finding.file);
    const verdicts = entry !== undefined && Array.isArray(entry.baselineVerdicts) ? entry.baselineVerdicts : null;
    if (fileAnalyzed) {
      // 已完成分析：状态只认持久化的 baselineVerdicts——没有判定（旧缓存、工具新建
      // 的 entry、零判定折叠、漏判、截断）一律「未判定」，绝不因「无认领」判已修复。
      const verdict = verdicts === null ? undefined : verdicts.find((item) => item.index === finding.index);
      if (verdict === undefined) {
        undetermined.push(finding);
        continue;
      }
      if (verdict.status === 'fixed') {
        resolved.push(finding);
        continue;
      }
      stillOpen.push({ previous: finding, current: claimOf.get(finding.index)?.finding });
      continue;
    }
    // 归属文件本轮未分析：跨文件认领（重命名场景）算「仍未解决」；否则保持待分析。
    const claim = claimOf.get(finding.index);
    if (claim !== undefined && claim.fromFile !== finding.file) {
      stillOpen.push({ previous: finding, current: claim.finding });
    } else {
      pending.push(finding);
    }
  }
  return {
    baselineRound: baseline.round,
    resolved,
    stillOpen,
    undetermined,
    pending,
  };
}

/** A quick status row for the pull list; the final conclusion wins over the initial report. */
function reviewSummary(record) {
  if (record === undefined) return null;
  return {
    status: record.status,
    headSha: record.headSha,
    verdict: record.conclusion?.verdict ?? record.report?.verdict ?? null,
    updatedAt: record.finishedAt ?? record.startedAt ?? 0,
  };
}

/**
 * Apply the conversation's mutations directly to the overview's existing content:
 * the report's initial risks and the final conclusion's blockers/suggestions/nextSteps.
 * Same 1-based validation as the file list; unknown or missing targets are ignored.
 * Ops arrive pre-normalized (normalizeFindingOps already mapped legacy `text` to `point`).
 * A conclusion edit appends a `human` version, locks the touched item ids, and marks
 * the conclusion as edited; touching the report calls `onReportTouched`.
 */
function applyOverviewOps(record, ops, onReportTouched) {
  const report = record.report;
  if (report === null || report === undefined) return [];
  // Work on a copy so earlier history versions stay immutable.
  const working = record.conclusion === null || record.conclusion === undefined
    ? null
    : ensureConclusionIds(cloneJson(record.conclusion));
  const listFor = (target) => {
    if (target === 'risk') return Array.isArray(report.risks) ? report.risks : undefined;
    if (target === 'blocker') return Array.isArray(working?.blockers) ? working.blockers : undefined;
    if (target === 'suggestion') return Array.isArray(working?.suggestions) ? working.suggestions : undefined;
    if (target === 'nextStep') return Array.isArray(working?.nextSteps) ? working.nextSteps : undefined;
    return undefined;
  };
  const applied = [];
  let touchedRisk = false;
  let touchedConclusion = false;
  const touchedIds = new Set();
  for (const op of Array.isArray(ops) ? ops : []) {
    const target = typeof op.target === 'string' ? op.target : '';
    const list = listFor(target);
    if (list === undefined) continue;
    const index = typeof op.index === 'number' ? op.index - 1 : -1;
    const isStep = target === 'nextStep';
    const kind = target === 'blocker' ? 'blocker' : target === 'suggestion' ? 'suggestion' : '';
    if (op.op === 'remove') {
      if (index < 0 || index >= list.length) continue;
      const [removed] = list.splice(index, 1);
      applied.push({ op: 'remove', target, index: index + 1 });
      if (target === 'risk') touchedRisk = true;
      else touchedConclusion = true;
      if (kind !== '' && removed !== null && typeof removed === 'object' && typeof removed.id === 'string') {
        touchedIds.add(removed.id);
      }
    } else if (op.op === 'update') {
      if (index < 0 || index >= list.length) continue;
      if (isStep) {
        list[index] = op.point;
      } else if (target === 'risk') {
        const before = list[index];
        list[index] = {
          severity: op.severity ?? before.severity ?? 'suggest',
          file: op.file ?? before.file ?? '',
          point: op.point,
        };
      } else {
        const before = list[index];
        const file = op.file ?? before?.file ?? '';
        const id = typeof before?.id === 'string' && before.id !== ''
          ? before.id
          : itemId(kind, file, op.point);
        // Keep the line only when the edit stays on the same file; new items carry line 0.
        const line = file === (before?.file ?? '') && Number.isInteger(before?.line) && before.line > 0 ? before.line : 0;
        list[index] = { id, file, point: op.point, line };
        touchedIds.add(id);
      }
      applied.push({ op: 'update', target, index: index + 1 });
      if (target === 'risk') touchedRisk = true;
      else touchedConclusion = true;
    } else if (op.op === 'add') {
      if (isStep) {
        list.push(op.point);
      } else if (target === 'risk') {
        list.push({
          severity: op.severity === 'block' ? 'block' : 'suggest',
          file: typeof op.file === 'string' ? op.file : '',
          point: op.point,
        });
      } else {
        const file = typeof op.file === 'string' ? op.file : '';
        const id = itemId(kind, file, op.point);
        list.push({ id, file, point: op.point, line: 0 });
        touchedIds.add(id);
      }
      applied.push({ op: 'add', target });
      if (target === 'risk') touchedRisk = true;
      else touchedConclusion = true;
    }
  }
  if (applied.length > 0) {
    if (touchedRisk) record.reportUpdatedAt = Date.now();
    if (touchedConclusion && working !== null) {
      record.conclusion = working;
      pushConclusionVersion(record, 'human', working, record.coverage ?? null);
      record.conclusionEditedAt = Date.now();
      const ids = new Set(Array.isArray(record.humanItemIds) ? record.humanItemIds : []);
      for (const id of touchedIds) if (typeof id === 'string' && id !== '') ids.add(id);
      record.humanItemIds = [...ids];
    }
    if (touchedRisk && typeof onReportTouched === 'function') onReportTouched(record);
  }
  return applied;
}

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

/** Depth of the persisted cache directory. */
function cacheDir() {
  return path.join(homedir(), '.dsh', 'pr-review');
}

/** One cache file per platform + repository pair. */
function cacheFile(provider) {
  const slug = `${provider.platform}-${provider.repo.replace(/[^A-Za-z0-9._-]+/g, '__')}`;
  return path.join(cacheDir(), `${slug}.json`);
}

// `buildCommentMarkdown` now lives in llm.js; re-exported to keep the old import path working.
export { buildCommentMarkdown };

// ---------- conclusion history helpers (contract §1) ----------

/** Deep copy of JSON-shaped state so history versions never alias live objects. */
function cloneJson(value) {
  return value === undefined ? null : JSON.parse(JSON.stringify(value));
}

/** Build one round entry of the permanent conclusion history. */
function makeRoundEntry(round, headSha, startedAt) {
  return {
    round,
    headSha: typeof headSha === 'string' ? headSha : '',
    startedAt: startedAt ?? Date.now(),
    finishedAt: 0,
    conclusions: [],
    findings: null,
    feedback: null,
    publishedIds: [],
  };
}

/** The permanent round history; a legacy record without one gets a synthesized single round. */
function roundHistoryOf(record) {
  if (!Array.isArray(record.roundHistory) || record.roundHistory.length === 0) {
    const round = Number.isFinite(record.round) && record.round > 0 ? record.round : 1;
    const conclusion = record.conclusion ?? null;
    record.roundHistory = [{
      round,
      headSha: typeof record.headSha === 'string' ? record.headSha : '',
      startedAt: record.startedAt ?? 0,
      finishedAt: record.finishedAt ?? 0,
      conclusions: conclusion === null ? [] : [{
        version: 1,
        createdAt: record.conclusionAt || record.finishedAt || record.startedAt || Date.now(),
        source: 'model',
        conclusion,
        coverage: record.coverage ?? null,
      }],
      feedback: record.feedback ?? null,
      publishedIds: (Array.isArray(record.published) ? record.published : [])
        .filter((entry) => (entry.round ?? round) === round && typeof entry.id === 'number')
        .map((entry) => entry.id),
    }];
  }
  return record.roundHistory;
}

/** The current round is always the last entry (ascending history). */
function currentRoundEntry(record) {
  const history = roundHistoryOf(record);
  return history[history.length - 1];
}

/** Newest conclusion version of the current round (null before the first generation). */
function latestConclusionVersionOf(record) {
  const round = currentRoundEntry(record);
  return round.conclusions.length === 0 ? null : round.conclusions[round.conclusions.length - 1];
}

/** Copy the current round's newest conclusion back onto the legacy top-level fields. */
function syncTopLevelFromHistory(record) {
  const round = currentRoundEntry(record);
  record.round = round.round;
  record.feedback = round.feedback ?? null;
  const version = round.conclusions.length === 0 ? null : round.conclusions[round.conclusions.length - 1];
  record.conclusion = version === null ? null : version.conclusion;
  record.conclusionAt = version === null ? 0 : (version.createdAt ?? 0);
  record.coverage = version === null ? null : (version.coverage ?? null);
  return round;
}

/** Append one conclusion version to the current round (model generation or human edit). */
function pushConclusionVersion(record, source, conclusion, coverage) {
  if (conclusion === null || conclusion === undefined) return null;
  const round = currentRoundEntry(record);
  const previous = round.conclusions.length === 0 ? null : round.conclusions[round.conclusions.length - 1];
  const version = {
    version: previous === null ? 1 : (Number(previous.version) || round.conclusions.length) + 1,
    createdAt: Date.now(),
    source: source === 'human' ? 'human' : 'model',
    conclusion: cloneJson(conclusion),
    coverage: coverage === undefined ? (previous?.coverage ?? null) : cloneJson(coverage),
  };
  round.conclusions.push(version);
  record.conclusion = version.conclusion;
  record.conclusionAt = version.createdAt;
  record.coverage = version.coverage;
  record.round = round.round;
  return version;
}

/** One persisted round entry, tolerating missing or older fields. */
function sanitizeRoundEntry(entry, index) {
  const round = Number.isFinite(entry?.round) && entry.round > 0 ? entry.round : index + 1;
  const conclusions = (Array.isArray(entry?.conclusions) ? entry.conclusions : [])
    .filter((version) => version !== null && typeof version === 'object' && version.conclusion !== null && typeof version.conclusion === 'object')
    .map((version, versionIndex) => ({
      version: Number.isFinite(version.version) && version.version > 0 ? version.version : versionIndex + 1,
      createdAt: Number.isFinite(version.createdAt) ? version.createdAt : 0,
      source: version.source === 'human' ? 'human' : 'model',
      conclusion: ensureConclusionIds(version.conclusion),
      coverage: version.coverage ?? null,
    }));
  return {
    round,
    headSha: typeof entry?.headSha === 'string' ? entry.headSha : '',
    startedAt: Number.isFinite(entry?.startedAt) ? entry.startedAt : 0,
    finishedAt: Number.isFinite(entry?.finishedAt) ? entry.finishedAt : 0,
    conclusions,
    feedback: entry?.feedback ?? null,
    findings: Array.isArray(entry?.findings) && entry.findings.length > 0 ? entry.findings : null,
    publishedIds: Array.isArray(entry?.publishedIds) ? entry.publishedIds.filter((id) => typeof id === 'number') : [],
  };
}

/** Write feedback on both the top-level field and the current round entry. */
function setCurrentRoundFeedback(record, feedback) {
  currentRoundEntry(record).feedback = feedback ?? null;
  record.feedback = feedback ?? null;
}

/**
 * Copy a conclusion with only the item ids in `includeIds` kept (publish selection).
 * summary/verdict/nextSteps always survive; unknown ids are ignored, so an empty
 * list publishes the summary without any numbered item.
 */
function filterConclusionItems(conclusion, includeIds) {
  const allowed = new Set((Array.isArray(includeIds) ? includeIds : []).filter((id) => typeof id === 'string' && id !== ''));
  const keep = (kind, item) => {
    if (item === null || typeof item !== 'object') return false;
    const id = typeof item.id === 'string' && item.id !== '' ? item.id : itemId(kind, item.file, item.point);
    return allowed.has(id);
  };
  return {
    ...conclusion,
    blockers: (Array.isArray(conclusion?.blockers) ? conclusion.blockers : []).filter((item) => keep('blocker', item)),
    suggestions: (Array.isArray(conclusion?.suggestions) ? conclusion.suggestions : []).filter((item) => keep('suggestion', item)),
  };
}

export function apply(ctx, config) {
  const settings = { ...DEFAULTS, ...(typeof config === 'object' && config !== null ? config : {}) };
  let provider = resolveProviderConfig(settings);
  const state = {
    repoKey: `${provider.platform}:${provider.repo}`,
    prs: [],
    prsTruncated: false,
    reviews: new Map(),
    lastPollAt: 0,
    lastPollError: null,
    tokenMissing: false,
    pollRunning: false,
    client: null,
    persisted: false,
    cacheError: '',
    saveError: '',
    saveTimer: null,
    // Last workspace directory that activated a repository; evidence lookup greps there.
    workspaceCwd: '',
  };

  let cachePath = cacheFile(provider);

  /** Workspace cwd → resolved repository (the same workspace always maps to the same repo). */
  const repoByCwd = new Map();

  /** Effective comment language ('zh' default, 'en' opt-in). */
  function commentLanguage() {
    return settings.commentLanguage === 'en' ? 'en' : 'zh';
  }

  /** Newest report/explanation time the current conclusion has not caught up with. */
  function latestContextAt(record) {
    let latest = record.reportUpdatedAt ?? 0;
    for (const entry of record.explanations.values()) {
      if (entry.status === 'done') latest = Math.max(latest, entry.updatedAt ?? 0);
    }
    return latest;
  }

  /** A conclusion older than the newest report/explanation edit is stale. */
  function isStale(record) {
    const version = latestConclusionVersionOf(record);
    const createdAt = version === null ? 0 : (version.createdAt ?? 0);
    return createdAt < latestContextAt(record);
  }

  /** Stop a running conclusion job without letting it record a cancellation error. */
  function abortConclude(record) {
    const abort = record.concludingAbort;
    record.concludingAbort = null;
    record.concluding = null;
    if (abort !== null && abort !== undefined) abort.abort();
  }

  /**
   * Stop a running analysis batch and invalidate every explain still in flight: a provider
   * may ignore the abort, so the epoch bump — not the abort alone — is what keeps a late
   * answer from being written into a record that was cleared, replaced or pruned.
   */
  function abortAnalysis(record) {
    if (record === undefined || record === null) return;
    const job = record.analyzing;
    record.analyzing = null;
    record.analysisEpoch = (record.analysisEpoch ?? 0) + 1;
    if (job !== null && job !== undefined && job.abort !== undefined) job.abort.abort();
  }

  /** Background auto-regeneration (opt-in): only when stale, idle and rate-limited. */
  function maybeAutoConclude(record) {
    if (settings.autoReconclude !== true) return false;
    if (record === undefined || record === null) return false;
    if (record.concluding !== null && record.concluding !== undefined) return false;
    if (record.status === 'reviewing') return false;
    if (record.report === null || record.report === undefined) return false;
    if (!isStale(record)) return false;
    const now = Date.now();
    if (now - (record.lastAutoConcludeAt ?? 0) < 300_000) return false;
    record.lastAutoConcludeAt = now;
    return startConclude(record).ok === true;
  }

  /** Map an origin host to the platform whose API it speaks. */
  function platformForHost(host) {
    const value = String(host ?? '').toLowerCase();
    if (value === 'github.com') return 'github';
    if (value === 'gitlab.com') return 'gitlab';
    if (value === 'gitee.com') return 'gitee';
    if (value === 'gitcode.com' || value === 'gitcode.net') return 'gitcode';
    if (value === 'atomgit.com') return 'atomgit';
    if (value === 'codeup.aliyun.com') return 'codeup';
    return 'forgejo';
  }

  /** Default API base for one origin; self-hosted GitLab/Gitea reuse the origin host. */
  function baseUrlForPlatform(platform, host) {
    switch (platform) {
      case 'github': return 'https://api.github.com';
      case 'gitee': return `https://${host}/api/v5`;
      case 'gitcode': return 'https://api.gitcode.com/api/v5';
      case 'atomgit': return 'https://api.atomgit.com/api/v5';
      case 'codeup': return 'https://openapi-rdc.aliyuncs.com';
      default: return `https://${host}`;
    }
  }

  /** Parse a git remote URL into a reviewable repository description. */
  function parseRemote(remote) {
    const value = String(remote ?? '').trim();
    let host = '';
    let pathname = '';
    let match = /^(?:https?|ssh):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(value);
    if (match !== null) {
      host = match[1];
      pathname = match[2];
    } else {
      match = /^[^@]+@([^:]+):(.+)$/.exec(value);
      if (match !== null) {
        host = match[1];
        pathname = match[2];
      }
    }
    if (host === '' || pathname === '') return null;
    const repo = pathname.replace(/^\.git$/, '').replace(/\.git$/, '').replace(/^\/+/, '');
    // GitLab subgroups and Codeup group paths have more than two segments.
    if (!/^[^/]+\/.+$/.test(repo)) return null;
    const platform = platformForHost(host);
    return {
      platform,
      repo,
      baseUrl: baseUrlForPlatform(platform, host),
    };
  }

  /** Try `git -C <dir> remote get-url origin`, tolerating a GUI app's minimal PATH. */
  async function readGitRemote(dir) {
    for (const binary of GIT_CANDIDATES) {
      const result = await new Promise((resolve) => {
        execFile(binary, ['-C', dir, 'remote', 'get-url', 'origin'], { timeout: 8000 }, (error, stdout, stderr) => {
          resolve({ error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
        });
      });
      if (result.error === null || result.error === undefined) {
        return { ok: true, remote: result.stdout.trim() };
      }
      if (result.error.code === 'ENOENT') continue;
      const detail = result.stderr.trim().slice(0, 200);
      const lower = detail.toLowerCase();
      if (lower.includes('no such remote') || detail.includes('没有那个远程')) {
        return { ok: false, reason: 'no-origin', detail };
      }
      return { ok: false, reason: 'not-git', detail };
    }
    return { ok: false, reason: 'git-missing' };
  }

  /** Resolve the repository that owns a workspace directory (git remote origin). */
  async function resolveRepoForPath(cwd) {
    const dir = typeof cwd === 'string' ? cwd.trim() : '';
    if (dir === '') return { supported: false, reason: 'no-cwd', cwd: dir };
    const cached = repoByCwd.get(dir);
    if (cached !== undefined) return cached;
    const remote = await readGitRemote(dir);
    if (!remote.ok) return { supported: false, reason: remote.reason, detail: remote.detail, cwd: dir };
    if (remote.remote === '') return { supported: false, reason: 'no-origin', cwd: dir };
    const parsed = parseRemote(remote.remote);
    if (parsed === null) return { supported: false, reason: 'unsupported-remote', remote: remote.remote, cwd: dir };
    const result = { supported: true, ...parsed, cwd: dir };
    repoByCwd.set(dir, result);
    return result;
  }

  // ---------- persistence ----------

  /** Persist the lightweight review state (no diff text). */
  function scheduleSave() {
    if (state.saveTimer !== null) return;
    state.saveTimer = setTimeout(() => {
      state.saveTimer = null;
      void saveNow();
    }, 800);
  }

  /** Serialize the lightweight review state (no diff text). */
  function buildCachePayload() {
    const payload = { savedAt: Date.now(), reviews: {} };
    for (const [number, record] of state.reviews) {
      if (record.status === 'reviewing') continue;
      payload.reviews[number] = {
        number: record.number,
        status: record.status,
        headSha: record.headSha,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
        error: record.error,
        pull: record.pull,
        files: record.files,
        filesTruncated: record.filesTruncated === true,
        report: record.report,
        explanations: [...record.explanations.entries()].map(([filePath, entry]) => ({
          file: filePath,
          status: entry.status,
          error: entry.error,
          explanation: entry.explanation,
          chat: entry.chat,
          updatedAt: entry.updatedAt,
          baselineVerdicts: Array.isArray(entry.baselineVerdicts) ? entry.baselineVerdicts : null,
        })),
        pullChat: record.pullChat,
        reportUpdatedAt: record.reportUpdatedAt ?? 0,
        conclusionEditedAt: record.conclusionEditedAt ?? 0,
        round: record.round ?? 1,
        roundHistory: record.roundHistory ?? [],
        humanItemIds: record.humanItemIds ?? [],
        coverage: record.coverage ?? null,
        concludeError: record.concludeError ?? null,
        published: record.published ?? [],
        publishedItems: record.publishedItems ?? [],
        feedback: record.feedback ?? null,
        previousRound: record.previousRound ?? null,
        conclusionAt: record.conclusionAt ?? 0,
        conclusion: record.conclusion,
        comment: record.comment ?? null,
        revision: record.revision ?? 0,
        audit: Array.isArray(record.audit) ? record.audit : [],
      };
    }
    return payload;
  }

  /** Temp path next to the cache file: same directory keeps the rename atomic. */
  function cacheTempPath() {
    return `${cachePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  }

  /** Rename with short retries: Windows sync tools can briefly lock the target (EBUSY/EPERM). */
  async function renameWithRetry(from, to) {
    const waitBefore = [0, 80, 240];
    for (let attempt = 0; attempt < waitBefore.length; attempt += 1) {
      if (waitBefore[attempt] > 0) await new Promise((resolve) => setTimeout(resolve, waitBefore[attempt]));
      try {
        await rename(from, to);
        return;
      } catch (error) {
        if (attempt === waitBefore.length - 1) throw error;
      }
    }
  }

  /**
   * Persist through a temp file + rename: a crash mid-write can never leave a
   * truncated cache behind, because the previous file stays intact until the rename.
   */
  async function saveNow() {
    // Nothing to persist before a workspace (or explicit config) names the repository.
    if (provider.repo === '') return;
    const tempPath = cacheTempPath();
    try {
      const text = JSON.stringify(buildCachePayload());
      await mkdir(cacheDir(), { recursive: true });
      await writeFile(tempPath, text, 'utf8');
      await renameWithRetry(tempPath, cachePath);
      state.saveError = '';
    } catch (error) {
      console.warn('[pr-review] 保存审查缓存失败', error);
      state.saveError = `保存审查缓存失败：${error instanceof Error ? error.message : String(error)}`;
      try {
        await unlink(tempPath);
      } catch {
        // Temp file already gone or locked; the next save uses a fresh temp name.
      }
    }
  }

  /** Synchronous best-effort save for teardown, when async work may not get another turn. */
  function saveNowSync() {
    if (provider.repo === '') return;
    const tempPath = cacheTempPath();
    try {
      mkdirSync(cacheDir(), { recursive: true });
      writeFileSync(tempPath, JSON.stringify(buildCachePayload()), 'utf8');
      renameSync(tempPath, cachePath);
    } catch (error) {
      console.warn('[pr-review] 退出前保存审查缓存失败', error);
      try {
        unlinkSync(tempPath);
      } catch {
        // Temp file already gone or locked.
      }
    }
  }

  /**
   * Rebuild one persisted review record, tolerating missing or older fields.
   * Returns null when the entry has no usable number.
   */
  function restoreReviewRecord(saved, key) {
    const explanations = new Map();
    for (const entry of Array.isArray(saved.explanations) ? saved.explanations : []) {
      if (typeof entry?.file !== 'string') continue;
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
        // The persisted per-item verdicts drive the re-review comparison; a legacy
        // cache without them lands every baseline finding in「未判定」(undetermined) —
        // conservative: no data never means resolved.
        baselineVerdicts: Array.isArray(entry.baselineVerdicts)
          ? entry.baselineVerdicts
            .filter((item) => item !== null && typeof item === 'object'
              && Number.isInteger(item.index) && item.index >= 1
              && (item.status === 'fixed' || item.status === 'still-open'))
            .map((item) => ({ ...item, status: item.status }))
          : null,
      });
    }
    const number = Number(saved.number ?? key);
    if (!Number.isFinite(number)) return null;
    const record = {
      number,
      status: saved.status === 'reviewing' ? 'stale' : (saved.status ?? 'done'),
      // A failed review keeps no head marker, so the next poll retries it.
      headSha: saved.status === 'error' ? '' : (saved.headSha ?? ''),
      startedAt: saved.startedAt ?? 0,
      finishedAt: saved.finishedAt ?? 0,
      error: saved.error ?? null,
      pull: saved.pull ?? null,
      files: Array.isArray(saved.files) ? saved.files : [],
      filesTruncated: saved.filesTruncated === true,
      report: saved.report ?? null,
      explanations,
      pullChat: Array.isArray(saved.pullChat) ? saved.pullChat : [],
      reportUpdatedAt: saved.reportUpdatedAt ?? 0,
      conclusionEditedAt: saved.conclusionEditedAt ?? 0,
      round: saved.round ?? 1,
      published: (Array.isArray(saved.published) ? saved.published : []).map((entry) => ({
        ...entry,
        version: Number.isFinite(entry?.version) ? entry.version : 0,
      })),
      publishedItems: Array.isArray(saved.publishedItems) ? saved.publishedItems : [],
      feedback: saved.feedback ?? null,
      previousRound: saved.previousRound ?? null,
      conclusionAt: saved.conclusionAt ?? 0,
      conclusion: saved.conclusion ?? null,
      comment: saved.comment ?? null,
      humanItemIds: Array.isArray(saved.humanItemIds)
        ? saved.humanItemIds.filter((id) => typeof id === 'string' && id !== '')
        : [],
      coverage: saved.coverage ?? null,
      roundHistory: [],
      concluding: null,
      concludingAbort: null,
      analyzing: null,
      analysisEpoch: 0,
      publishing: false,
      concludeError: null,
      lastAutoConcludeAt: 0,
      diffFiles: undefined,
      revision: Number.isInteger(saved.revision) && saved.revision >= 0 ? saved.revision : 0,
      audit: Array.isArray(saved.audit) ? saved.audit.filter((item) => item !== null && typeof item === 'object') : [],
    };
    if (Array.isArray(saved.roundHistory) && saved.roundHistory.length > 0) {
      record.roundHistory = saved.roundHistory.map((entry, index) => sanitizeRoundEntry(entry, index));
    } else {
      // Legacy cache: synthesize the single round it had so the history starts non-empty.
      const legacyRound = Number.isFinite(record.round) && record.round > 0 ? record.round : 1;
      record.roundHistory = [sanitizeRoundEntry({
        round: legacyRound,
        headSha: record.headSha,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
        conclusions: record.conclusion === null || record.conclusion === undefined
          ? []
          : [{
              version: 1,
              createdAt: record.conclusionAt || record.finishedAt || record.startedAt || Date.now(),
              source: 'model',
              conclusion: record.conclusion,
              coverage: record.coverage ?? null,
            }],
        feedback: record.feedback ?? null,
        publishedIds: record.published
          .filter((entry) => (entry.round ?? legacyRound) === legacyRound && typeof entry.id === 'number')
          .map((entry) => entry.id),
      }, 0)];
    }
    // Legacy published items get the same stable ids the current commentItems() would use.
    record.publishedItems = record.publishedItems.map((item) => (
      item !== null && typeof item === 'object' && (typeof item.id !== 'string' || item.id === '')
        ? { ...item, id: itemId(item.kind, item.file, item.point) }
        : item
    ));
    const current = syncTopLevelFromHistory(record);
    record.round = current.round;
    return record;
  }

  async function loadCache() {
    try {
      const text = await readFile(cachePath, 'utf8');
      const payload = JSON.parse(text);
      const reviews = payload.reviews ?? {};
      for (const key of Object.keys(reviews)) {
        const record = restoreReviewRecord(reviews[key], key);
        if (record !== null) state.reviews.set(record.number, record);
      }
      state.persisted = true;
    } catch (error) {
      state.persisted = false;
      // First run for this repository: no cache to read, start empty.
      if (error?.code === 'ENOENT') return;
      // Never let the next save overwrite a cache we could not read: keep it for recovery.
      const archivedPath = `${cachePath}.corrupt-${Date.now()}`;
      try {
        await rename(cachePath, archivedPath);
        state.cacheError = `审查缓存读取失败，原文件已另存为 ${path.basename(archivedPath)}（${error instanceof Error ? error.message : String(error)}）`;
      } catch (renameError) {
        state.cacheError = `审查缓存读取失败：${error instanceof Error ? error.message : String(error)}`;
        console.warn('[pr-review] 缓存留档失败', renameError);
      }
      console.warn('[pr-review] 审查缓存读取失败', error);
    }
  }

  /** Switch the active repository: flush the previous cache, reload this repo's cache, start polling. */
  async function activateRepo(nextProvider) {
    const key = `${nextProvider.platform}:${nextProvider.repo}`;
    if (state.repoKey === key) return false;
    if (state.saveTimer !== null) {
      clearTimeout(state.saveTimer);
      state.saveTimer = null;
    }
    await saveNow();
    for (const record of state.reviews.values()) {
      abortConclude(record);
      abortAnalysis(record);
    }
    provider = nextProvider;
    cachePath = cacheFile(provider);
    state.repoKey = key;
    state.prs = [];
    state.prsTruncated = false;
    state.reviews = new Map();
    state.lastPollAt = 0;
    state.lastPollError = null;
    state.pollRunning = false;
    state.client = null;
    state.tokenMissing = false;
    state.persisted = false;
    state.cacheError = '';
    state.saveError = '';
    await loadCache();
    void refreshPulls();
    return true;
  }

  /** Honor the workspace-scoped ?repo=&platform=&baseUrl= query (browser half always sends it). */
  async function ensureRepoFor(req) {
    const url = pathOf(req);
    const repo = url.searchParams.get('repo') ?? '';
    const platform = url.searchParams.get('platform') ?? '';
    if (repo === '' || platform === '') return;
    const baseUrl = platform === 'github'
      ? 'https://api.github.com'
      : (url.searchParams.get('baseUrl') ?? settings.baseUrl);
    await activateRepo(resolveProviderConfig({
      ...settings,
      platform: platform === 'github' ? 'github' : 'forgejo',
      repo,
      baseUrl,
    }));
  }

  // ---------- provider client ----------

  async function ensureClient() {
    if (state.client !== null) return state.client;
    const token = await resolveToken(settings, provider);
    if (token === null || token === undefined) {
      state.tokenMissing = true;
      throw new HarnessError(
        missingTokenMessage(provider.platform),
        'MISSING_CREDENTIAL',
      );
    }
    state.tokenMissing = false;
    state.client = createClient(settings, provider, token);
    return state.client;
  }

  /** Refetch the diff for a review whose in-memory copy is gone (e.g. after restart). */
  async function ensureDiffFiles(record) {
    if (record.diffFiles !== undefined) return record.diffFiles;
    const client = await ensureClient();
    const diff = await client.pullDiff(record.number);
    record.diffFiles = parseDiff(diff);
    if (!Array.isArray(record.files) || record.files.length === 0) {
      record.files = await client.pullFiles(record.number);
    }
    return record.diffFiles;
  }

  /** Full text of one changed file at the PR head, cached per review record. */
  async function ensureFileContent(record, filePath) {
    const cache = record.fileContents ?? new Map();
    record.fileContents = cache;
    const cached = cache.get(filePath);
    if (cached !== undefined) return cached;
    const client = await ensureClient();
    const ref = record.pull?.headSha ?? record.headSha ?? '';
    const result = await client.pullFileContent(filePath, ref);
    cache.set(filePath, result);
    return result;
  }

  // ---------- evidence for the verifier ----------

  /** Run one git command in the workspace; evidence lookup only, so failures read as null. */
  function runGit(cwd, args) {
    return new Promise((resolve) => {
      const attempt = (at) => {
        if (at >= GIT_CANDIDATES.length) {
          resolve(null);
          return;
        }
        execFile(GIT_CANDIDATES[at], ['-C', cwd, ...args], { timeout: 5000, maxBuffer: 512 * 1024 }, (error, stdout) => {
          if (error !== null && error !== undefined && error.code === 'ENOENT') {
            attempt(at + 1);
            return;
          }
          resolve(error === null ? String(stdout) : null);
        });
      };
      attempt(0);
    });
  }

  /**
   * Workspace directory whose origin is the repository under review, or '' when unusable.
   * The directory may be on another branch, so it only ever supplies candidate paths.
   */
  function evidenceWorkspace() {
    const cwd = state.workspaceCwd;
    if (typeof cwd !== 'string' || cwd === '') return '';
    const known = repoByCwd.get(cwd);
    if (known === undefined || known.supported !== true) return '';
    return known.repo === provider.repo && known.platform === provider.platform ? cwd : '';
  }

  /** Candidate paths: files in the workspace that contain the symbol. */
  async function grepWorkspaceSymbol(cwd, symbol, limit) {
    // --full-name keeps paths repo-root-relative even when the workspace is a subdirectory.
    const stdout = await runGit(cwd, ['grep', '--full-name', '-l', '-F', '-e', symbol]);
    if (stdout === null) return [];
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .slice(0, limit);
  }

  /** Fallback candidates: changed files whose diff mentions the symbol. */
  function diffSymbolCandidates(record, symbol) {
    const paths = [];
    for (const [filePath, diff] of record.diffFiles ?? new Map()) {
      if (typeof diff?.text === 'string' && diff.text.includes(symbol)) paths.push(filePath);
    }
    return paths.slice(0, 3);
  }

  function describeNeed(need) {
    const target = need.path !== '' ? need.path : (need.symbol !== '' ? need.symbol : '?');
    return `${need.kind} ${target}${need.reason === '' ? '' : `（${need.reason}）`}`;
  }

  /**
   * Around the first symbol occurrence when there is one, else the file's head. The note
   * states which lines were shown: a verifier that sees only part of a file must know it,
   * or it will report "this file lacks X" from a truncated view.
   */
  function sliceEvidence(content, symbol, maxChars) {
    const text = String(content ?? '');
    const lines = text.split('\n');
    const total = lines.length;
    let start = 0;
    let end = total;
    let note = '';
    if (symbol !== '') {
      const at = text.indexOf(symbol);
      if (at !== -1) {
        const lineIndex = text.slice(0, at).split('\n').length - 1;
        start = Math.max(0, lineIndex - 40);
        end = Math.min(total, lineIndex + 41);
        note = `第 ${start + 1}–${end} 行（共 ${total} 行）`;
      } else {
        end = Math.min(total, 200);
        note = `未找到 ${symbol}，显示前 ${end} 行（共 ${total} 行）`;
      }
    } else if (total > 200) {
      end = 200;
      note = `前 ${end} 行（共 ${total} 行）`;
    }
    let chunk = lines.slice(start, end).join('\n');
    if (chunk.length > maxChars) {
      chunk = `${chunk.slice(0, maxChars)}\n…（已按字符上限截断）`;
      note = note === '' ? '内容超过字符上限，已截断' : `${note}，且超过字符上限已截断`;
    }
    return { text: chunk, note };
  }

  /** A fence longer than any backtick run inside the evidence, so Markdown cannot close it. */
  function fenceFor(text) {
    const runs = String(text).match(/`{3,}/g);
    const longest = runs === null ? 0 : Math.max(...runs.map((run) => run.length));
    return '`'.repeat(Math.max(3, longest + 1));
  }

  function evidenceBlock(index, need, filePath, content, maxChars) {
    const meta = [need.kind, need.symbol === '' ? '' : `symbol=${need.symbol}`].filter((item) => item !== '').join(' · ');
    const sliced = sliceEvidence(content, need.symbol, maxChars);
    const scope = sliced.note === '' ? '' : `；${sliced.note}`;
    const fence = fenceFor(sliced.text);
    return `## 证据 ${index}：${filePath}（${meta}${scope}）\n\n${fence}text\n${sliced.text}\n${fence}`;
  }

  /**
   * Fetch what the triage pass asked for. Local files only nominate candidates; the bytes in
   * the prompt always come from the PR head, so a stale worktree can never turn into evidence.
   */
  async function collectEvidence(record, needs, maxFiles, maxChars) {
    const blocks = [];
    const missing = [];
    const used = new Set();
    const cwd = evidenceWorkspace();
    let index = 0;
    for (const need of needs) {
      if (blocks.length >= maxFiles) {
        missing.push(`${describeNeed(need)}：证据超过上限（${maxFiles} 个文件），未读取`);
        continue;
      }
      const candidates = [];
      if (need.path !== '') candidates.push(need.path);
      if (need.symbol !== '') {
        if (cwd !== '') candidates.push(...await grepWorkspaceSymbol(cwd, need.symbol, 3));
        if (candidates.length === 0) candidates.push(...diffSymbolCandidates(record, need.symbol));
      }
      if (candidates.length === 0) {
        missing.push(`${describeNeed(need)}：没有可读取的文件路径`);
        continue;
      }
      let covered = false;
      for (const candidate of candidates) {
        // Dedupe per (file, symbol): the same file can hold several symbols, and each
        // needs its own window. An existing key still covers this need; keep trying later
        // candidates because one may offer a better match.
        const cacheKey = `${candidate}::${need.symbol}`;
        if (used.has(cacheKey)) {
          covered = true;
          continue;
        }
        try {
          const content = await ensureFileContent(record, candidate);
          index += 1;
          blocks.push(evidenceBlock(index, need, candidate, content.content, maxChars));
          used.add(cacheKey);
          covered = true;
          break;
        } catch (error) {
          console.warn('[pr-review] 读取证据失败:', candidate, error);
        }
      }
      if (!covered) missing.push(`${describeNeed(need)}：无法读取 ${candidates[0]}`);
    }
    return { blocks: blocks.join('\n\n'), missing };
  }

  /**
   * Score the triage pass's concerns against the evidence. A verifier failure never fails the
   * review: the candidates become unverified notes instead of findings.
   */
  async function verifyConcerns(record, concerns, rawNeeds, buildPrompt, epoch, signal) {
    const needs = normalizeEvidenceNeeds(rawNeeds);
    const evidence = await collectEvidence(
      record,
      needs,
      settings.evidenceMaxFiles ?? DEFAULTS.evidenceMaxFiles,
      settings.evidenceMaxChars ?? DEFAULTS.evidenceMaxChars,
    );
    if (epoch !== null && (record.analysisEpoch ?? 0) !== epoch) {
      return { discarded: true, issues: [], unverified: [] };
    }
    if (signal !== undefined && signal !== null && signal.aborted) {
      return { discarded: true, issues: [], unverified: [] };
    }
    let answer;
    try {
      answer = await callModelJson(
        buildPrompt(evidence.blocks, evidence.missing),
        signal,
        // A reply without a results array is a stub, not a verdict.
        (value) => value !== null && typeof value === 'object' && Array.isArray(value.results),
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // A cancelled batch must not persist its cancellation as "unverified" findings.
      if ((signal !== undefined && signal !== null && signal.aborted) || reason.includes('已取消')) {
        return { discarded: true, issues: [], unverified: [] };
      }
      console.warn('[pr-review] 复审调用失败，候选问题转入未验证项：', error);
      return {
        discarded: false,
        issues: [],
        unverified: concerns.map((item) => ({ point: item.point, missing: `复审未完成：${reason}` })),
        dropped: 0,
        raw: null,
      };
    }
    if (answer.parsed === null) {
      return {
        discarded: false,
        issues: [],
        unverified: concerns.map((item) => ({ point: item.point, missing: '复审未完成：模型没有返回可解析的 JSON' })),
        dropped: 0,
        raw: null,
      };
    }
    const verdicts = partitionVerdicts(answer.parsed, concerns);
    // Dropped candidates are neither findings nor unverified notes; keep the count visible
    // so a model that stopped answering in range does not look like "no problems found".
    if (verdicts.dropped > 0) {
      console.warn(`[pr-review] 复审丢弃 ${verdicts.dropped} 条候选（无法归位或置信度 < 25）`);
    }
    return { discarded: false, raw: answer.parsed, ...verdicts };
  }

  // ---------- pull list ----------

  /**
   * Keep the review cache bounded: drop the oldest finished records that were never
   * published. Records with published comments are the reviewer's history and stay
   * forever (the product promises version history is never deleted).
   */
  function pruneReviews() {
    if (state.reviews.size <= MAX_REVIEWS) return;
    const candidates = [...state.reviews.entries()]
      .filter(([, record]) => record.status !== 'reviewing' && (record.published ?? []).length === 0)
      .sort((left, right) => (left[1].finishedAt ?? 0) - (right[1].finishedAt ?? 0));
    let pruned = 0;
    for (const [number, record] of candidates) {
      if (state.reviews.size <= MAX_REVIEWS) break;
      abortAnalysis(record);
      state.reviews.delete(number);
      pruned += 1;
    }
    if (pruned > 0) {
      console.log(`[pr-review] 已淘汰 ${pruned} 条未发布的旧审查缓存（上限 ${MAX_REVIEWS}）`);
      scheduleSave();
    }
  }

  async function refreshPulls() {
    if (state.pollRunning) return;
    // No configured repository yet: workspace sessions activate one from their git origin.
    if (provider.repo === '' || provider.baseUrl === '') return;
    state.pollRunning = true;
    try {
      const client = await ensureClient();
      // The provider asks for one extra entry: a full page means older PRs were cut off,
      // and the panel says so instead of silently hiding them.
      const fetched = await client.listOpenPulls();
      const prs = fetched.slice(0, MAX_LISTED_PRS);
      state.prs = prs;
      state.prsTruncated = fetched.length > MAX_LISTED_PRS;
      state.lastPollAt = Date.now();
      state.lastPollError = null;
      if (settings.autoReview !== false) {
        for (const pr of prs) {
          if (pr.headSha === '') continue;
          const record = state.reviews.get(pr.number);
          if (record === undefined) {
            startReview(pr.number, false);
            continue;
          }
          if (record.status === 'reviewing') continue;
          // A failure is not a completed round: retry it in place (throttled) before
          // looking at the head sha, so no round entry is appended by a retry.
          if (record.status === 'error') {
            if (Date.now() - (record.finishedAt ?? 0) > 300_000) startReview(pr.number, false);
            continue;
          }
          if (record.headSha !== pr.headSha) {
            startReview(pr.number, true);
            continue;
          }
        }
      }
      pruneReviews();
    } catch (error) {
      state.lastPollError = error instanceof Error ? error.message : String(error);
    } finally {
      state.pollRunning = false;
    }
  }

  // ---------- review pipeline ----------

  /** A brand-new record shell for round 1; runReview fills it in. */
  function newReviewRecord(number, now) {
    const record = {
      number,
      round: 1,
      status: 'reviewing',
      startedAt: now,
      finishedAt: 0,
      headSha: '',
      error: null,
      pull: null,
      files: [],
      filesTruncated: false,
      report: null,
      explanations: new Map(),
      pullChat: [],
      reportUpdatedAt: 0,
      conclusionEditedAt: 0,
      conclusionAt: 0,
      conclusion: null,
      comment: null,
      published: [],
      publishedItems: [],
      feedback: null,
      humanItemIds: [],
      coverage: null,
      roundHistory: [],
      concluding: null,
      concludingAbort: null,
      analyzing: null,
      analysisEpoch: 0,
      publishing: false,
      concludeError: null,
      lastAutoConcludeAt: 0,
      diffFiles: undefined,
    };
    const round = roundHistoryOf(record)[0];
    round.startedAt = now;
    round.headSha = '';
    return record;
  }

  /**
   * Start a new round on an existing record: keep the previous conclusion (and its items)
   * available for the implementer-feedback flow, then clear every per-round field.
   */
  function rollNewRound(record, now) {
    const history = roundHistoryOf(record);
    const previousRoundEntry = history[history.length - 1];
    const previousVersion = latestConclusionVersionOf(record);
    const previousItems = previousVersion === null ? [] : commentItems(previousVersion.conclusion);
    record.previousRound = previousVersion === null ? null : {
      round: previousRoundEntry.round,
      headSha: previousRoundEntry.headSha || record.headSha || '',
      conclusion: cloneJson(previousVersion.conclusion),
      items: previousItems.length > 0
        ? previousItems
        : (Array.isArray(record.publishedItems) ? record.publishedItems : []),
    };
    abortConclude(record);
    // Cancels the batch (if any) and invalidates explanations still in flight, including
    // manual ones that hold no batch job.
    abortAnalysis(record);
    history.push(makeRoundEntry(previousRoundEntry.round + 1, '', now));
    record.round = previousRoundEntry.round + 1;
    record.report = null;
    record.explanations = new Map();
    record.filesTruncated = false;
    record.pullChat = [];
    record.reportUpdatedAt = 0;
    record.conclusionEditedAt = 0;
    record.conclusionAt = 0;
    record.conclusion = null;
    record.comment = null;
    record.publishedItems = [];
    record.feedback = null;
    record.humanItemIds = [];
    record.coverage = null;
    record.concludeError = null;
    record.lastAutoConcludeAt = 0;
  }

  /** Create the record shell and kick off the report; safe to call repeatedly. */
  function startReview(number, force) {
    const existing = state.reviews.get(number);
    if (existing !== undefined && existing.status === 'reviewing') return false;
    const now = Date.now();
    let record;
    if (existing === undefined) {
      record = newReviewRecord(number, now);
    } else {
      record = existing;
      if (force) rollNewRound(record, now);
      record.status = 'reviewing';
      record.startedAt = now;
      record.finishedAt = 0;
      record.error = null;
      // Both caches are keyed by path only; a new head (or a retry after new commits)
      // must fetch again or the analysis would read the previous head's code.
      record.diffFiles = undefined;
      record.fileContents = undefined;
    }
    state.reviews.set(number, record);
    void runReview(record).catch((error) => {
      record.status = 'error';
      record.error = error instanceof Error ? error.message : String(error);
      record.finishedAt = Date.now();
      currentRoundEntry(record).finishedAt = record.finishedAt;
      scheduleSave();
    });
    return true;
  }

  /**
   * Model call that must return JSON. Models occasionally answer in prose or with a stub
   * object despite the contract; one corrective turn — echoing its answer back with the
   * required shape — recovers most of those instead of failing the whole round.
   *
   * `isUsable` decides whether a parsed answer is complete enough to keep. The corrective
   * turn uses a user message, never an assistant one: the Host's LLM runtime expects
   * assistant history to carry `finish.replayState`, which callModel does not collect.
   */
  async function callModelJson(prompt, signal, isUsable) {
    const usable = typeof isUsable === 'function' ? isUsable : () => true;
    const request = signal === undefined || signal === null ? prompt : { ...prompt, signal };
    const first = await callModel(ctx, settings, request);
    const parsed = extractJson(first);
    if (parsed !== null && usable(parsed)) return { raw: first, parsed };
    const correction = {
      ...prompt,
      messages: [
        ...prompt.messages,
        {
          role: 'user',
          content: [{
            type: 'text',
            text: `上一次的输出不是合法的、完整的 JSON：\n---\n${first.slice(0, 4000)}\n---\n请按上面的字段约定，只输出一个完整的 JSON 对象，不要 markdown 代码块，不要任何解释。`,
          }],
        },
      ],
    };
    const retried = await callModel(ctx, settings, signal === undefined || signal === null ? correction : { ...correction, signal });
    return { raw: retried, parsed: extractJson(retried) };
  }

  /**
   * Both the report and the per-file prompt require a summary or at least one candidate
   * concern; an answer with neither is a stub, not a review. Shared so the two paths cannot
   * drift apart.
   */
  function answerHasContent(value) {
    if (value === null || typeof value !== 'object') return false;
    const summary = typeof value.summary === 'string' ? value.summary.trim() : '';
    const concerns = Array.isArray(value.concerns) ? value.concerns : [];
    return summary !== '' || concerns.length > 0;
  }

  /** Fetch one pull request and produce the overall report plus reading order. */
  async function runReview(record) {
    const client = await ensureClient();
    const pull = await client.pullDetail(record.number);
    record.pull = pull;
    record.headSha = pull.headSha;
    currentRoundEntry(record).headSha = pull.headSha;
    const files = await client.pullFiles(record.number);
    record.files = files;
    // A full last page means the API has more files than the page cap; the panel says so.
    record.filesTruncated = files.length >= MAX_PULL_FILES;
    if (record.filesTruncated) console.warn(`[pr-review] PR #${record.number} 的变更文件超过 ${MAX_PULL_FILES} 个，列表已截断`);
    const diffText = await client.pullDiff(record.number);
    record.diffFiles = parseDiff(diffText);
    // The host file endpoint may cap its page; keep every path the diff knows.
    if (record.diffFiles.size > 0) {
      const fileMap = new Map(files.map((file) => [file.path, file]));
      for (const [filePath, parsed] of record.diffFiles) {
        if (!fileMap.has(filePath)) {
          fileMap.set(filePath, {
            path: filePath,
            previousPath: '',
            status: 'changed',
            additions: parsed.additions,
            deletions: parsed.deletions,
            changes: parsed.additions + parsed.deletions,
          });
        }
      }
      record.files = [...fileMap.values()];
    }
    const prompt = buildReportPrompt(pull, record.files, record.diffFiles, settings);
    let answer;
    try {
      answer = await callModelJson(prompt, undefined, answerHasContent);
    } catch (error) {
      record.status = 'error';
      record.error = error instanceof Error ? error.message : String(error);
      record.finishedAt = Date.now();
      currentRoundEntry(record).finishedAt = record.finishedAt;
      scheduleSave();
      return;
    }
    const parsed = answer.parsed;
    if (parsed === null || !answerHasContent(parsed)) {
      record.status = 'error';
      record.error = `模型没有返回完整的报告 JSON。原始输出：${answer.raw.slice(0, 400)}`;
      record.finishedAt = Date.now();
      currentRoundEntry(record).finishedAt = record.finishedAt;
      scheduleSave();
      return;
    }
    const order = Array.isArray(files) ? files.map((file) => file.path) : [];
    const draft = normalizeReportDraft(parsed, order);
    let risks = [];
    let unverified = [];
    let discarded = 0;
    if (draft.concerns.length > 0) {
      if (settings.evidenceVerify === false) {
        risks = draft.concerns.map((item) => ({ severity: item.severity, file: item.file, point: item.point }));
      } else {
        const verdicts = await verifyConcerns(
          record,
          draft.concerns,
          parsed.evidenceNeeds,
          (evidence, missing) => buildReportVerifyPrompt(pull, draft.concerns, evidence, missing, { language: commentLanguage() }),
          null,
        );
        risks = verdicts.issues.map((item) => ({ severity: item.severity, file: item.file, point: item.point }));
        unverified = verdicts.unverified;
        discarded = verdicts.dropped ?? 0;
      }
    }
    // A confirmed blocker outranks the triage verdict; a confirmed finding never leaves a "pass".
    const verdict = risks.some((risk) => risk.severity === 'block')
      ? 'block'
      : (risks.length > 0 && draft.verdict === 'pass' ? 'suggest' : draft.verdict);
    record.report = normalizeReport({
      ...draft,
      verdict,
      risks,
      unverified,
      raised: draft.concerns.length,
      discarded,
    }, order);
    record.reportUpdatedAt = 0;
    record.status = 'done';
    record.finishedAt = Date.now();
    currentRoundEntry(record).finishedAt = record.finishedAt;
    scheduleSave();
    // Every finished round analyzed in the background: files no longer wait for a click.
    ensureAutoAnalyze(record);
  }

  /** In-flight file explanations: duplicate requests share one model call. */
  const explainInFlight = new Map();

  /** Explain one file: deep logic walkthrough + findings. `signal` cancels a batch call. */
  async function explainFile(number, filePath, force, signal) {
    const record = state.reviews.get(number);
    if (record === undefined) {
      const started = startReview(number, false);
      if (!started) throw new Error('该 PR 正在审查中，请稍后再试。');
      throw new Error('该 PR 还没有审查报告，已开始审查，请稍后重试。');
    }
    const cached = record.explanations.get(filePath);
    if (!force && cached !== undefined && cached.status === 'done' && cached.explanation !== null) {
      return { explanation: cached.explanation, cached: true };
    }
    // A double click, a panel retry or the agent tool can ask for the same file at once;
    // they await the same promise instead of paying for two model calls. Keyed by round:
    // a request for the new round must not join an answer the cleared round will discard.
    const inFlightKey = `${number}:${filePath}:${record.analysisEpoch ?? 0}`;
    const running = explainInFlight.get(inFlightKey);
    if (running !== undefined) return running;
    const task = explainFileUncached(record, number, filePath, cached, signal);
    explainInFlight.set(inFlightKey, task);
    try {
      return await task;
    } finally {
      explainInFlight.delete(inFlightKey);
    }
  }

  /** The model call behind explainFile; callers deduplicate through explainInFlight. */
  async function explainFileUncached(record, number, filePath, cached, signal) {
    // A new round may start while the model is answering; its per-file analyses are cleared,
    // so this answer must not land in the fresh round.
    const epoch = record.analysisEpoch ?? 0;
    const diffFiles = await ensureDiffFiles(record);
    const file = (record.files ?? []).find((item) => item.path === filePath) ?? {
      path: filePath,
      status: 'changed',
      additions: 0,
      deletions: 0,
    };
    const diff = diffFiles.get(filePath);
    const diffText = diff === undefined ? '' : diff.text.slice(0, settings.maxDiffCharsPerFile ?? 14000);
    const focus = record.report?.focus?.[filePath] ?? '';
    let fileContent = '';
    try {
      const content = await ensureFileContent(record, filePath);
      fileContent = content.content;
    } catch (error) {
      console.warn('[pr-review] 读取文件完整内容失败，讲解退化为仅 diff：', error);
    }
    const pull = record.pull ?? { number, title: '', repo: provider.repo, platform: provider.platform };
    // The baseline snapshot (the newest concluded round's findings) rides along with the
    // analysis prompt: the model re-judges every baseline finding for this file.
    const baselineFindings = baselineRoundOf(record)?.findings ?? [];
    const prompt = buildExplainPrompt(
      pull,
      file,
      diffText,
      record.report,
      focus,
      fileContent,
      { language: commentLanguage(), baselineFindings },
    );
    if ((record.analysisEpoch ?? 0) !== epoch) return { explanation: null, cached: false, discarded: true };
    if (signal !== undefined && signal !== null && signal.aborted) throw new Error('模型请求已取消。');
    const answer = await callModelJson(prompt, signal, answerHasContent);
    // The round can switch while the model answers; drop the answer before parsing, so a
    // late malformed reply is never reported as a failure of the round that replaced it.
    if ((record.analysisEpoch ?? 0) !== epoch) return { explanation: null, cached: false, discarded: true };
    const parsed = answer.parsed;
    if (parsed === null || !answerHasContent(parsed)) {
      throw new Error(`模型没有返回完整的分析 JSON。原始输出：${answer.raw.slice(0, 400)}`);
    }
    const concerns = normalizeConcerns(parsed.concerns);
    // Baseline re-judgement (review-delta spec v7): every baseline finding must come out
    // of the analysis with a status. "fixed" drops it (the model's explicit resolved
    // verdict); "still-open" re-enters this round's findings as a carry-over that skips
    // verification (the baseline round already confirmed it). A baseline finding the
    // model never judged falls back conservatively to still-open (marked unjudged) when
    // its file was analyzed here, and stays pending when the file wasn't.
    const baselineVerdicts = normalizePreviousVerdicts(parsed.previousVerdicts, baselineFindings.length);
    const verdictByIndex = new Map(baselineVerdicts.map((item) => [item.index, item]));
    const carried = [];
    for (const item of baselineFindings) {
      const verdict = verdictByIndex.get(item.index);
      if (verdict === undefined) {
        if (item.file === filePath) {
          carried.push({
            severity: item.severity,
            point: item.point,
            suggestion: item.suggestion,
            line: item.line,
            roundItem: item.index,
            unjudged: true,
          });
        }
        continue;
      }
      if (verdict.status === 'still-open') {
        // 归属文件在本轮会被分析：该条目的判定与展示归它（其最新分析是权威），认领只在
        // 归属文件缺席时落库——重命名场景（旧文件已不在变更列表，新文件认领延续）。
        const owningListed = item.file !== filePath
          && (Array.isArray(record.files) ? record.files : []).some((file) => file.path === item.file);
        if (owningListed) continue;
        carried.push({
          severity: verdict.severity ?? item.severity,
          point: verdict.point ?? item.point,
          suggestion: verdict.suggestion ?? item.suggestion,
          line: verdict.line ?? item.line,
          roundItem: item.index,
        });
      }
    }
    // One concern carries one suggestion; the verifier's suggestion rewrites win, the
    // candidate's are the fallback. Legacy model output that still carries a separate
    // `suggestions` array is folded into issues by normalizeExplanation (findingsOf).
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
        // partitionVerdicts products still carry a `file` key; normalizeExplanation
        // (findingsOf) drops it, so the stored shape stays the uniform four keys.
        issues = verdicts.issues;
        unverified = verdicts.unverified;
      }
    }
    // 同文去重：模型有时把已判 still-open 的问题又作为一条新发现写进 issues（完全同文）。
    // 延续条目优先，同文的无 roundItem 条目丢弃——不做语义猜测，只认归一后的完全相等。
    const comparablePoint = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    const carriedPoints = new Set(carried.map((item) => comparablePoint(item.point)));
    issues = issues.filter((item) => !carriedPoints.has(comparablePoint(item.point)));
    // Carried-over baseline findings lead the list: they were confirmed in the baseline
    // round and only re-checked for survival this round.
    issues = [...carried, ...issues];
    // Verdict reconciliation (semantic contract):
    // - any confirmed blocker -> block: never "pass" a file with confirmed blockers;
    // - no confirmed findings -> pass: an all-dropped triage is a pass, since a "suggest"
    //   verdict without a surviving finding is an unanchored judgment (the dropped
    //   candidates and unverified notes stay visible in their own sections);
    // - only suggest findings -> the model's verdict stands, except a bare "block"
    //   (a blocked call with no confirmed blocker degrades to suggest).
    const rawVerdict = ['block', 'suggest', 'pass'].includes(parsed.verdict) ? parsed.verdict : 'suggest';
    const verdict = issues.some((item) => item.severity === 'block')
      ? 'block'
      : (issues.length === 0 ? 'pass' : (rawVerdict === 'block' ? 'suggest' : rawVerdict));
    const explanation = normalizeExplanation({
      ...parsed,
      issues,
      unverified,
      verdict,
    });
    // Repeat the check at the write point: an await added between parse and store must
    // not reopen the stale-write window.
    if ((record.analysisEpoch ?? 0) !== epoch) return { explanation: null, cached: false, discarded: true };
    record.explanations.set(filePath, {
      status: 'done',
      error: null,
      explanation,
      chat: cached?.chat ?? [],
      updatedAt: Date.now(),
      // The baseline re-judgement is persisted with the entry (review-delta spec v7):
      // findingsDeltaOf reads explicit verdicts instead of inferring "no claim = fixed",
      // so later issue rewrites (chat findOps, review_update_analysis, clearFindings)
      // can never manufacture a fake resolved state.
      baselineVerdicts: baselineVerdicts.length === 0 ? null : baselineVerdicts,
    });
    scheduleSave();
    maybeAutoConclude(record);
    return { explanation, cached: false };
  }

  // ---------- batch file analysis ----------

  /**
   * Batches of different PRs run in parallel (auto review can finish several rounds at
   * once); this ceiling keeps their model calls from piling up on the provider.
   */
  const ANALYZE_CONCURRENCY = 2;
  let analyzeActive = 0;
  const analyzeWaiters = [];

  /**
   * Run `task` while holding one of the analysis slots. A cancelled batch may still sit in
   * the waiter queue; when woken it sees the record superseded and returns without calling
   * the model, so the queue stays bounded by the number of live batches.
   */
  async function withAnalyzeSlot(task) {
    while (analyzeActive >= ANALYZE_CONCURRENCY) {
      await new Promise((resolve) => analyzeWaiters.push(resolve));
    }
    analyzeActive += 1;
    try {
      return await task();
    } finally {
      analyzeActive -= 1;
      const next = analyzeWaiters.shift();
      if (next !== undefined) next();
    }
  }

  /** True while `job` still owns this record: same job, same round, still in the map. */
  function analysisBatchCurrent(record, job) {
    return record.analyzing === job
      && (record.analysisEpoch ?? 0) === job.epoch
      && state.reviews.get(record.number) === record;
  }

  /**
   * Analyze every file that has no analysis yet, one model call at a time.
   * `includeErrors` retries files whose previous analysis failed; the automatic path
   * leaves them alone so a broken call is not repeated on every panel poll.
   */
  function startAnalysisBatch(record, options = {}) {
    if (record === undefined || record === null) return false;
    if (record.status !== 'done') return false;
    if (record.report === null || record.report === undefined) return false;
    if (record.analyzing !== null && record.analyzing !== undefined) return false;
    const includeErrors = options.includeErrors === true;
    const pending = [];
    for (const file of Array.isArray(record.files) ? record.files : []) {
      const entry = record.explanations.get(file.path);
      // An entry without an explanation is not an analysis (restored legacy records can
      // carry `done` with a null body); the automatic pass still leaves failures alone.
      const empty = entry !== undefined && entry.status === 'done'
        && (entry.explanation === null || entry.explanation === undefined);
      const unanalyzed = entry === undefined || empty;
      if (unanalyzed || (includeErrors && entry !== undefined && entry.status === 'error')) pending.push(file.path);
    }
    if (pending.length === 0) return false;
    const job = {
      total: pending.length,
      done: 0,
      failed: 0,
      current: pending[0],
      abort: new AbortController(),
      // The round this batch belongs to; every guard rejects a batch from another round.
      epoch: record.analysisEpoch ?? 0,
    };
    record.analyzing = job;
    scheduleSave();
    void runAnalysisBatch(record, job, pending);
    return true;
  }

  /** Auto mode entry: honors the `autoAnalyze` setting. */
  function ensureAutoAnalyze(record) {
    if (settings.autoAnalyze !== true) return false;
    return startAnalysisBatch(record);
  }

  /** The batch itself; a failed file is kept on the record and does not stop the rest. */
  async function runAnalysisBatch(record, job, pending) {
    try {
      for (const filePath of pending) {
        if (!analysisBatchCurrent(record, job)) return;
        job.current = filePath;
        try {
          // Re-check after waiting for a slot: a new round may have taken over meanwhile.
          const result = await withAnalyzeSlot(() => (
            analysisBatchCurrent(record, job)
              ? explainFile(record.number, filePath, false, job.abort.signal)
              : null
          ));
          // A discarded answer belongs to a round that is gone; stop instead of counting it.
          if (result === null || result.discarded === true) return;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // A cancelled call is not a failed file: the record belongs to a round that is gone.
          if (!analysisBatchCurrent(record, job) || job.abort.signal.aborted) return;
          console.warn(`[pr-review] PR #${record.number} 自动分析 ${filePath} 失败：${message}`);
          record.explanations.set(filePath, {
            status: 'error',
            error: message,
            explanation: null,
            chat: record.explanations.get(filePath)?.chat ?? [],
            updatedAt: Date.now(),
          });
          job.failed += 1;
        }
        if (!analysisBatchCurrent(record, job)) return;
        job.done += 1;
        scheduleSave();
      }
    } finally {
      // Clear the marker by job identity, not by map membership: a record that left the
      // review map must not keep pointing at a finished job.
      if (record.analyzing === job) {
        record.analyzing = null;
        scheduleSave();
      }
    }
  }

  /** Continue the conversation about one file, or about the whole PR. */
  async function chat(number, filePath, question) {
    const record = state.reviews.get(number);
    if (record === undefined) throw new Error('该 PR 还没有审查记录，请先审查。');
    const file = filePath === '' ? null : (record.files ?? []).find((item) => item.path === filePath) ?? { path: filePath, status: 'changed', additions: 0, deletions: 0 };
    const entry = filePath === '' ? null : (record.explanations.get(filePath) ?? null);
    const history = entry === null ? record.pullChat : entry.chat;
    const prompt = buildChatPrompt(
      record.pull ?? { number, title: '', repo: provider.repo, platform: provider.platform },
      file,
      entry?.explanation ?? null,
      record.report,
      history,
      question,
      record.conclusion ?? null,
      { language: commentLanguage() },
    );
    const { answer, ops } = parseChatReply(await callModel(ctx, settings, prompt));
    let applied = [];
    if (entry === null) {
      record.pullChat.push({ role: 'user', text: question }, { role: 'assistant', text: answer });
      if (ops.length > 0) applied = applyOverviewOps(record, ops, () => maybeAutoConclude(record));
    } else {
      entry.chat.push({ role: 'user', text: question }, { role: 'assistant', text: answer });
      entry.updatedAt = Date.now();
      if (entry.explanation !== null && entry.explanation !== undefined && ops.length > 0) {
        const result = applyFindingOps(entry.explanation, ops);
        if (result.applied.length > 0) {
          // No in-tree write path produces the legacy `suggestions` key any more, but the
          // write-back still drops it: a stale out-of-tree cache must not fold straight back
          // on the next read and double every number the chat prompt shows.
          const { suggestions: _legacy, ...explanation } = entry.explanation;
          entry.explanation = { ...explanation, issues: result.list };
          applied = result.applied;
        }
      }
    }
    scheduleSave();
    return { answer, applied };
  }

  // ---------- final conclusion (async task with cancellation) ----------

  /** Start one background conclusion generation; returns immediately. */
  function startConclude(record) {
    if (record === undefined || record === null) return { ok: false, code: 'not-found' };
    if (record.concluding !== null && record.concluding !== undefined) return { ok: false, code: 'concluding' };
    record.concludeError = null;
    record.concluding = { stage: 'collect', startedAt: Date.now() };
    const abort = new AbortController();
    record.concludingAbort = abort;
    void runConclude(record, abort);
    return { ok: true };
  }

  /** The staged job behind POST /conclude: collect → model → parse → write. */
  /** Everything the conclusion prompt needs from the finished per-file analyses. */
  function concludeInputsOf(record) {
    const files = Array.isArray(record.files) ? record.files : [];
    // Only finished explanations feed the conclusion and the coverage number.
    const done = new Map();
    for (const [filePath, entry] of record.explanations) {
      if (entry.status !== 'done' || entry.explanation === null || entry.explanation === undefined) continue;
      done.set(filePath, entry.explanation);
    }
    return { files, done, coverage: conclusionCoverage(record.explanations, files) };
  }

  async function runConclude(record, abort) {
    const stillCurrent = () => record.concludingAbort === abort;
    try {
      const { files, done, coverage } = concludeInputsOf(record);
      const previousVersion = latestConclusionVersionOf(record);
      const previousConclusion = previousVersion === null ? null : previousVersion.conclusion;
      const humanEdited = (record.conclusionEditedAt ?? 0) > 0
        && previousVersion !== null
        && previousVersion.source === 'human';
      const prompt = buildConcludePrompt(
        record.pull ?? { number: record.number, title: '', repo: provider.repo, platform: provider.platform },
        record.report,
        done,
        previousConclusion,
        {
          coverage,
          previousItems: commentItems(previousConclusion),
          feedback: record.feedback ?? null,
          pullChat: Array.isArray(record.pullChat) ? record.pullChat : [],
          humanItemIds: Array.isArray(record.humanItemIds) ? record.humanItemIds : [],
          language: commentLanguage(),
        },
      );
      if (record.concluding !== null) record.concluding.stage = 'model';
      const raw = await callModel(ctx, settings, { ...prompt, signal: abort.signal });
      if (abort.signal.aborted) throw new Error('已取消');
      if (record.concluding !== null) record.concluding.stage = 'parse';
      const parsed = extractJson(raw);
      if (parsed === null) throw new Error(`模型没有返回可解析的 JSON。原始输出：${String(raw).slice(0, 400)}`);
      const generated = normalizeConclusion(parsed, { files: files.map((file) => file.path) });
      const merged = mergeConclusion(previousConclusion, generated, {
        lockedItemIds: Array.isArray(record.humanItemIds) ? record.humanItemIds : [],
      });
      // The conclusion model reviewed every per-file analysis; its blocker judgment
      // (including dismissing per-file blocks) is authoritative.
      const calibrated = calibrateVerdict(merged, { humanEdited });
      if (abort.signal.aborted) throw new Error('已取消');
      if (record.concluding !== null) record.concluding.stage = 'write';
      const version = pushConclusionVersion(record, 'model', calibrated, coverage);
      if (version === null) throw new Error('模型返回了空结论。');
      // Freeze the round's findings as the next round's comparison baseline (review-delta
      // spec v7): the conclusion is the marker of a completed round, so its snapshot is
      // what a later round compares against — skipping any conclusion-less rounds between.
      currentRoundEntry(record).findings = findingsSnapshotOf(record);
      record.conclusionEditedAt = 0;
      record.reportUpdatedAt = 0;
      record.error = null;
      record.concludeError = null;
      scheduleSave();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = abort.signal.aborted || message.includes('已取消');
      if (stillCurrent()) {
        record.concludeError = cancelled ? `已取消：${message}` : message;
        record.error = record.concludeError;
      }
    } finally {
      if (stillCurrent()) {
        record.concludingAbort = null;
        record.concluding = null;
      }
      scheduleSave();
    }
  }

  // ---------- HTTP routes ----------

  const rejected = (req, res) => {
    const rejection = ctx.connection.requestRejection(req);
    if (rejection === undefined) return false;
    res.statusCode = rejection;
    res.end();
    return true;
  };

  const pathOf = (req) => new URL(String(req.url), 'http://localhost');

  function route(pathname, handlers) {
    const methods = Object.keys(handlers).join(', ');
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: pathname,
      handler: async (req, res) => {
        if (rejected(req, res)) return;
        const handler = handlers[req.method];
        try {
          if (handler === undefined) {
            res.statusCode = 405;
            res.setHeader('allow', methods);
            res.end();
            return;
          }
          await handler(req, res);
        } catch (error) {
          console.warn('[pr-review]', error);
          sendError(res, 500, 'internal', error instanceof Error ? error.message : String(error));
        }
      },
    }), `pr-review: ${pathname} (${methods})`);
  }

  route(`${PREFIX}/context`, {
    GET: async (req, res) => {
      const url = pathOf(req);
      const cwd = url.searchParams.get('cwd') ?? '';
      const info = await resolveRepoForPath(cwd);
      if (!info.supported) {
        sendJson(res, 200, {
          ok: true,
          supported: false,
          reason: info.reason,
          detail: typeof info.detail === 'string' ? info.detail : '',
          cwd: typeof info.cwd === 'string' ? info.cwd : cwd,
        });
        return;
      }
      await activateRepo(resolveProviderConfig({
        ...settings,
        platform: info.platform,
        repo: info.repo,
        baseUrl: info.baseUrl,
      }));
      // Only a workspace whose origin matches the active repository may seed evidence lookups.
      state.workspaceCwd = typeof info.cwd === 'string' && info.repo === provider.repo ? info.cwd : '';
      sendJson(res, 200, {
        ok: true,
        supported: true,
        repo: { platform: info.platform, repo: info.repo, baseUrl: info.baseUrl },
      });
    },
  });

  route(`${PREFIX}/prs`, {
    GET: async (req, res) => {
      await ensureRepoFor(req);
      const reviews = {};
      for (const [number, record] of state.reviews) reviews[number] = reviewSummary(record);
      let modelLabel = '';
      try {
        const { resolveSelection } = await import('./llm.js');
        const selection = resolveSelection(ctx, settings);
        modelLabel = `${selection.provider}/${selection.model}`;
      } catch {
        modelLabel = '';
      }
      sendJson(res, 200, {
        ok: true,
        platform: provider.platform,
        repo: provider.repo,
        baseUrl: provider.baseUrl,
        autoReview: settings.autoReview !== false,
        autoAnalyze: settings.autoAnalyze === true,
        pollSeconds: settings.pollSeconds,
        commentLanguage: commentLanguage(),
        autoReconclude: settings.autoReconclude === true,
        lastPollAt: state.lastPollAt,
        lastPollError: state.lastPollError,
        tokenMissing: state.tokenMissing,
        model: modelLabel,
        prs: state.prs,
        truncatedList: state.prsTruncated,
        cacheError: state.cacheError,
        saveError: state.saveError,
        reviews,
      });
    },
  });

  route(`${PREFIX}/refresh`, {
    POST: async (req, res) => {
      await ensureRepoFor(req);
      await refreshPulls();
      sendJson(res, 200, { ok: true, lastPollAt: state.lastPollAt, lastPollError: state.lastPollError });
    },
  });

  route(`${PREFIX}/review`, {
    GET: async (req, res) => {
      await ensureRepoFor(req);
      const url = pathOf(req);
      const number = Number(url.searchParams.get('number'));
      if (!Number.isInteger(number) || number <= 0) {
        sendError(res, 400, 'bad-request', 'number must be a positive integer');
        return;
      }
      const record = state.reviews.get(number);
      // Resume a batch the app restart or a disabled setting left unfinished.
      ensureAutoAnalyze(record);
      sendJson(res, 200, { ok: true, review: serializeReview(record) });
    },
    POST: async (req, res) => {
      await ensureRepoFor(req);
      const text = await readBoundedBody(req);
      const body = text === null ? null : parseBody(text);
      const number = Number(body?.number);
      if (!Number.isInteger(number) || number <= 0) {
        sendError(res, 400, 'bad-request', 'number must be a positive integer');
        return;
      }
      const started = startReview(number, body?.force === true);
      sendJson(res, 200, { ok: true, started });
    },
  });

  route(`${PREFIX}/file`, {
    GET: async (req, res) => {
      await ensureRepoFor(req);
      const url = pathOf(req);
      const number = Number(url.searchParams.get('number'));
      const filePath = url.searchParams.get('path') ?? '';
      if (!Number.isInteger(number) || number <= 0 || filePath === '') {
        sendError(res, 400, 'bad-request', 'number and path are required');
        return;
      }
      const record = state.reviews.get(number);
      if (record === undefined) {
        sendError(res, 404, 'not-found', 'review not found');
        return;
      }
      const diffFiles = await ensureDiffFiles(record);
      const diff = diffFiles.get(filePath);
      sendJson(res, 200, {
        ok: true,
        file: {
          path: filePath,
          diff: diff === undefined ? '' : diff.text.slice(0, MAX_FILE_DIFF_BYTES),
          additions: diff?.additions ?? 0,
          deletions: diff?.deletions ?? 0,
          truncated: diff !== undefined && diff.text.length > MAX_FILE_DIFF_BYTES,
        },
      });
    },
  });

  route(`${PREFIX}/explain`, {
    POST: async (req, res) => {
      await ensureRepoFor(req);
      const text = await readBoundedBody(req);
      const body = text === null ? null : parseBody(text);
      const number = Number(body?.number);
      const filePath = typeof body?.path === 'string' ? body.path : '';
      if (!Number.isInteger(number) || number <= 0 || filePath === '') {
        sendError(res, 400, 'bad-request', 'number and path are required');
        return;
      }
      const result = await explainFile(number, filePath, body?.force === true);
      sendJson(res, 200, { ok: true, ...result });
    },
  });

  // Manual batch: analyze every file that has no analysis yet and retry the failed ones.
  route(`${PREFIX}/analyze`, {
    POST: async (req, res) => {
      await ensureRepoFor(req);
      const text = await readBoundedBody(req);
      const body = text === null ? null : parseBody(text);
      const number = Number(body?.number);
      if (!Number.isInteger(number) || number <= 0) {
        sendError(res, 400, 'bad-request', 'number must be a positive integer');
        return;
      }
      const record = state.reviews.get(number);
      if (record === undefined) {
        sendError(res, 404, 'not-found', 'review not found');
        return;
      }
      const started = startAnalysisBatch(record, { includeErrors: true });
      sendJson(res, 200, { ok: true, started });
    },
  });

  route(`${PREFIX}/chat`, {
    POST: async (req, res) => {
      await ensureRepoFor(req);
      const text = await readBoundedBody(req);
      const body = text === null ? null : parseBody(text);
      const number = Number(body?.number);
      const question = typeof body?.message === 'string' ? body.message.trim() : '';
      const filePath = typeof body?.path === 'string' ? body.path : '';
      if (!Number.isInteger(number) || number <= 0 || question === '') {
        sendError(res, 400, 'bad-request', 'number and message are required');
        return;
      }
      const result = await chat(number, filePath, question);
      sendJson(res, 200, { ok: true, answer: result.answer, applied: result.applied });
    },
  });

  route(`${PREFIX}/conclude`, {
    POST: async (req, res) => {
      await ensureRepoFor(req);
      const text = await readBoundedBody(req);
      const body = text === null ? null : parseBody(text);
      const number = Number(body?.number);
      if (!Number.isInteger(number) || number <= 0) {
        sendError(res, 400, 'bad-request', 'number must be a positive integer');
        return;
      }
      const record = state.reviews.get(number);
      if (record === undefined) {
        sendError(res, 404, 'not-found', 'review not found');
        return;
      }
      if (record.status === 'reviewing') {
        sendError(res, 409, 'reviewing', '该 PR 正在审查中，请等审查完成后再生成结论。');
        return;
      }
      if (record.report === null || record.report === undefined) {
        sendError(res, 400, 'no-report', '还没有审查报告，请先完成审查再生成结论。');
        return;
      }
      if (record.concluding !== null && record.concluding !== undefined) {
        sendError(res, 409, 'concluding', '结论正在生成中，请稍候。');
        return;
      }
      const started = startConclude(record);
      if (!started.ok) {
        sendError(res, 409, started.code === 'concluding' ? 'concluding' : 'conflict', '结论正在生成中，请稍候。');
        return;
      }
      sendJson(res, 200, { ok: true, started: true });
    },
  });

  route(`${PREFIX}/conclude/cancel`, {
    POST: async (req, res) => {
      await ensureRepoFor(req);
      const text = await readBoundedBody(req);
      const body = text === null ? null : parseBody(text);
      const number = Number(body?.number);
      if (!Number.isInteger(number) || number <= 0) {
        sendError(res, 400, 'bad-request', 'number must be a positive integer');
        return;
      }
      const record = state.reviews.get(number);
      if (record === undefined) {
        sendError(res, 404, 'not-found', 'review not found');
        return;
      }
      const abort = record.concludingAbort;
      if (abort === null || abort === undefined) {
        sendJson(res, 200, { ok: true, cancelled: false });
        return;
      }
      abort.abort();
      sendJson(res, 200, { ok: true, cancelled: true });
    },
  });

  route(`${PREFIX}/file-content`, {
    GET: async (req, res) => {
      await ensureRepoFor(req);
      const url = pathOf(req);
      const number = Number(url.searchParams.get('number'));
      const filePath = url.searchParams.get('path') ?? '';
      if (!Number.isInteger(number) || number <= 0 || filePath === '') {
        sendError(res, 400, 'bad-request', 'number and path are required');
        return;
      }
      const record = state.reviews.get(number);
      if (record === undefined) {
        sendError(res, 404, 'not-found', 'review not found');
        return;
      }
      const content = await ensureFileContent(record, filePath);
      sendJson(res, 200, { ok: true, file: content });
    },
  });

  /** Publish-selection counts so a partial comment never reads as "no blockers". */
  function selectionInfo(record, conclusion) {
    const all = commentItems(record.conclusion ?? null);
    const kept = commentItems(conclusion ?? null);
    const countOf = (list, kind) => list.filter((item) => item.kind === kind).length;
    return {
      total: all.length,
      included: kept.length,
      omittedBlockers: countOf(all, 'blocker') - countOf(kept, 'blocker'),
      omittedSuggestions: countOf(all, 'suggestion') - countOf(kept, 'suggestion'),
    };
  }

  /**
   * Appendix payload for the PR comment: the review content that would otherwise stay in the
   * panel only (initial risks, per-file findings, reading order, re-review comparison, and the
   * files that were not analyzed at all).
   */
  function commentAppendixOf(record) {
    const report = record.report ?? {};
    const severityOf = (value) => (value === 'block' ? 'block' : value === 'suggest' ? 'suggest' : '');
    const pointOf = (item) => (typeof item?.point === 'string' ? item.point : '');
    const risks = (Array.isArray(report.risks) ? report.risks : [])
      .map((item) => ({
        severity: severityOf(item?.severity),
        file: typeof item?.file === 'string' ? item.file : '',
        point: pointOf(item),
      }))
      .filter((item) => item.point !== '');
    const files = [];
    for (const file of Array.isArray(record.files) ? record.files : []) {
      const entry = record.explanations.get(file.path);
      if (entry === undefined || entry.status !== 'done' || entry.explanation === null || entry.explanation === undefined) continue;
      const findings = findingsOf(entry.explanation);
      if (findings.length === 0) continue;
      files.push({ file: file.path, findings });
    }
    const order = (Array.isArray(report.order) ? report.order : [])
      .map((item) => ({
        file: typeof item?.file === 'string' ? item.file : '',
        reason: typeof item?.reason === 'string' ? item.reason : '',
      }))
      .filter((item) => item.file !== '');
    const coverage = record.coverage ?? null;
    const unanalyzed = Array.isArray(coverage?.unanalyzed)
      ? coverage.unanalyzed.filter((file) => typeof file === 'string' && file !== '')
      : [];
    return {
      risks,
      files,
      order,
      unanalyzed,
    };
  }

  /** Markdown for a conclusion (defaults to the current one), with no side effects. */
  /**
   * Publish the current round's conclusion as one PR comment. Throws a code-tagged error the
   * route turns into an HTTP status and the tool surfaces to the model. Returns what it posted.
   */
  async function publishReviewComment(record, options) {
    if (record.conclusion === null || record.conclusion === undefined) {
      throw new HarnessError('请先生成最终结论，再发布审查评论', 'no-conclusion');
    }
    if (record.publishing === true) {
      throw new HarnessError('正在发布评论，请稍候。', 'publishing');
    }
    const round = record.round ?? 1;
    const version = latestConclusionVersionOf(record);
    const versionNumber = version === null ? 0 : (Number(version.version) || 0);
    const alreadyPublished = (Array.isArray(record.published) ? record.published : [])
      .some((entry) => (entry.round ?? 1) === round && (Number(entry.version) || 0) === versionNumber);
    if (alreadyPublished && options.force !== true) {
      throw new HarnessError('这一轮的这个结论版本已经发布过；如需再追加一条评论请显式 force。', 'already-published');
    }
    const includeIds = Array.isArray(options.includeIds) ? options.includeIds : null;
    const publishConclusion = includeIds === null ? record.conclusion : filterConclusionItems(record.conclusion, includeIds);
    const totalItems = commentItems(record.conclusion ?? null).length;
    if (includeIds !== null && totalItems > 0 && commentItems(publishConclusion).length === 0) {
      throw new HarnessError('请至少选择一条审查意见再发布。', 'empty-selection');
    }
    record.publishing = true;
    try {
      const client = await ensureClient();
      const items = commentItems(publishConclusion);
      const markdown = commentMarkdown(record, publishConclusion, { selection: includeIds !== null });
      const result = await client.createComment(record.number, markdown);
      const entry = {
        id: result.id,
        url: typeof result.url === 'string' ? result.url : '',
        round,
        version: versionNumber,
        publishedAt: Date.now(),
        itemCount: items.length,
      };
      record.comment = { id: result.id, url: entry.url, publishedAt: entry.publishedAt };
      record.published = Array.isArray(record.published) ? record.published : [];
      record.published.push(entry);
      const current = currentRoundEntry(record);
      if (!Array.isArray(current.publishedIds)) current.publishedIds = [];
      current.publishedIds.push(entry.id);
      record.publishedItems = items;
      setCurrentRoundFeedback(record, null);
      scheduleSave();
      return { comment: record.comment, published: record.published };
    } finally {
      record.publishing = false;
    }
  }

  /** PR page and published-comment links for the "open on the platform" actions. */
  function reviewLinksOf(record) {
    const pullUrl = typeof record.pull?.url === 'string' ? record.pull.url : '';
    const published = [...(Array.isArray(record.published) ? record.published : [])]
      .filter((entry) => typeof entry.url === 'string' && entry.url !== '')
      .sort((left, right) => (right.publishedAt ?? 0) - (left.publishedAt ?? 0));
    return { pullUrl, latestCommentUrl: published[0]?.url ?? (record.comment?.url ?? '') };
  }

  function commentMarkdown(record, conclusion = record.conclusion, options = {}) {
    const version = latestConclusionVersionOf(record);
    const headSha = typeof record.headSha === 'string' && record.headSha !== ''
      ? record.headSha
      : (typeof record.pull?.headSha === 'string' ? record.pull.headSha : '');
    return buildCommentMarkdown(conclusion, record.pull, record.round ?? 1, {
      language: commentLanguage(),
      coverage: record.coverage ?? null,
      headSha,
      version: version === null ? 0 : (Number(version.version) || 0),
      selection: options.selection === true ? selectionInfo(record, conclusion) : null,
      appendix: commentAppendixOf(record),
    });
  }

  route(`${PREFIX}/comment/preview`, {
    POST: async (req, res) => {
      await ensureRepoFor(req);
      const text = await readBoundedBody(req);
      const body = text === null ? null : parseBody(text);
      const number = Number(body?.number);
      if (!Number.isInteger(number) || number <= 0) {
        sendError(res, 400, 'bad-request', 'number must be a positive integer');
        return;
      }
      const record = state.reviews.get(number);
      if (record === undefined) {
        sendError(res, 404, 'not-found', 'review not found');
        return;
      }
      if (record.conclusion === null || record.conclusion === undefined) {
        sendError(res, 400, 'bad-request', '请先生成最终结论，再预览 PR 评论');
        return;
      }
      // Optional publish selection: only the checked item ids go into the markdown.
      const includeIds = Array.isArray(body?.includeIds) ? body.includeIds : null;
      const previewConclusion = includeIds === null ? record.conclusion : filterConclusionItems(record.conclusion, includeIds);
      const items = commentItems(record.conclusion).map((item) => ({
        id: item.id,
        kind: item.kind,
        file: item.file,
        point: item.point,
        line: item.line,
      }));
      sendJson(res, 200, {
        ok: true,
        markdown: commentMarkdown(record, previewConclusion, { selection: includeIds !== null }),
        language: commentLanguage(),
        items,
      });
    },
  });

  route(`${PREFIX}/comment`, {
    POST: async (req, res) => {
      await ensureRepoFor(req);
      const text = await readBoundedBody(req);
      const body = text === null ? null : parseBody(text);
      const number = Number(body?.number);
      if (!Number.isInteger(number) || number <= 0) {
        sendError(res, 400, 'bad-request', 'number must be a positive integer');
        return;
      }
      const record = state.reviews.get(number);
      if (record === undefined) {
        sendError(res, 404, 'not-found', 'review not found');
        return;
      }
      try {
        const published = await publishReviewComment(record, {
          includeIds: Array.isArray(body?.includeIds) ? body.includeIds : null,
          force: body?.force === true,
        });
        sendJson(res, 200, { ok: true, ...published });
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : 'publish-failed';
        const status = code === 'publishing' || code === 'already-published' ? 409 : 400;
        sendError(res, status, code, error instanceof Error ? error.message : String(error));
      }
    },
  });

  // ---------- developer feedback on our published comment ----------
  route(`${PREFIX}/feedback`, {
    POST: async (req, res) => {
      await ensureRepoFor(req);
      const text = await readBoundedBody(req);
      const body = text === null ? null : parseBody(text);
      const number = Number(body?.number);
      if (!Number.isInteger(number) || number <= 0) {
        sendError(res, 400, 'bad-request', 'number must be a positive integer');
        return;
      }
      const record = state.reviews.get(number);
      if (record === undefined) {
        sendError(res, 404, 'not-found', 'review not found');
        return;
      }
      // Feedback answers the review comment of the round before this one: the implementer
      // replies to what we published for the previous round. The current round therefore does
      // NOT need to be published first — only an earlier published comment must exist.
      const published = Array.isArray(record.published) ? record.published : [];
      const latest = published.length === 0 ? null : published[published.length - 1];
      const roundPublished = latest !== null && (latest.round ?? 1) === (record.round ?? 1);
      const previousItems = Array.isArray(record.previousRound?.items) ? record.previousRound.items : [];
      const storedItems = Array.isArray(record.publishedItems) ? record.publishedItems : [];
      // Match the items to the anchored comment: this round's own items when it has been
      // published, otherwise the previous round's conclusion items.
      const items = roundPublished ? storedItems : (previousItems.length > 0 ? previousItems : storedItems);
      if (latest === null || items.length === 0) {
        sendJson(res, 200, { ok: true, feedback: record.feedback ?? null, parsed: false, reason: 'no-previous-review' });
        return;
      }
      const client = await ensureClient();
      const comments = await client.listIssueComments(number);
      const lastPublishedId = latest.id;
      const lastIndex = comments.findIndex((comment) => comment.id === lastPublishedId);
      const ourIds = new Set(published.map((entry) => entry.id));
      const candidates = (lastIndex >= 0 ? comments.slice(lastIndex + 1) : [])
        .filter((comment) => comment.body.trim() !== '' && !ourIds.has(comment.id));
      const knownCommentId = record.feedback?.lastCommentId ?? 0;
      const fresh = candidates.filter((comment) => comment.id > knownCommentId);
      if (fresh.length === 0) {
        sendJson(res, 200, { ok: true, feedback: record.feedback ?? null, parsed: false });
        return;
      }
      const prompt = buildFeedbackPrompt(
        record.pull ?? { number, title: '', repo: provider.repo, platform: provider.platform },
        items,
        fresh,
        { language: commentLanguage() },
      );
      const parsed = parseFeedbackReply(await callModel(ctx, settings, prompt));
      const states = { ...(record.feedback?.states ?? {}) };
      const previousStates = { ...(record.feedback?.states ?? {}) };
      for (const item of parsed.states) {
        const target = items.find((entry) => entry.index === item.index);
        if (target === undefined) continue;
        // Feedback is keyed by the stable item id (legacy item key as fallback).
        const stateKey = typeof target.id === 'string' && target.id !== '' ? target.id : target.key;
        states[stateKey] = {
          status: item.status,
          reason: item.reason,
          commentId: fresh[fresh.length - 1].id,
          updatedAt: Date.now(),
        };
      }
      const feedback = {
        fetchedAt: Date.now(),
        lastCommentId: fresh.reduce((max, comment) => Math.max(max, comment.id), knownCommentId),
        comments: fresh.slice(-20).map((comment) => ({ id: comment.id, author: comment.author, createdAt: comment.createdAt, body: comment.body.slice(0, 6000) })),
        states,
        previousStates,
        notes: parsed.notes,
      };
      setCurrentRoundFeedback(record, feedback);
      scheduleSave();
      sendJson(res, 200, { ok: true, feedback: record.feedback, parsed: true });
    },
  });

  // ---------- review tools (the main conversation agent reads review data) ----------

  /** Session → PR the reviewer currently has open in the right-side review panel. */
  const activeReviewBySession = new Map();

  /** The session id a tool call runs for, when the runtime exposes one. */
  function agentSessionId(agent) {
    const session = agent && typeof agent === 'object' ? agent.session : undefined;
    const id = session?.id ?? session?.sessionId ?? agent?.sessionId ?? '';
    return typeof id === 'string' ? id : '';
  }

  /** Resolve the record a tool call means: explicit number → session binding → newest review. */
  function resolveToolReview(agent, explicitNumber) {
    if (Number.isInteger(explicitNumber) && explicitNumber > 0) {
      return state.reviews.get(explicitNumber) ?? null;
    }
    const sessionId = agentSessionId(agent);
    if (sessionId !== '') {
      const bound = activeReviewBySession.get(sessionId);
      if (Number.isInteger(bound)) {
        const boundRecord = state.reviews.get(bound);
        if (boundRecord !== undefined) return boundRecord;
      }
    }
    if (state.reviews.size === 1) return [...state.reviews.values()][0];
    let latest = null;
    let latestAt = -1;
    for (const record of state.reviews.values()) {
      const at = record.finishedAt ?? record.startedAt ?? 0;
      if (at > latestAt) {
        latest = record;
        latestAt = at;
      }
    }
    return latest;
  }

  /** Like resolveToolReview, but a missing record is a teaching error for the model. */
  function requireToolReview(agent, explicitNumber) {
    const record = resolveToolReview(agent, explicitNumber);
    if (record === null) {
      throw toolError(TOOL_ERROR.notFound, '找不到对应的审查：请先在右侧「审查」面板打开该 PR，或在调用里带上 number。');
    }
    return record;
  }

  /** Coverage of the current round; recomputed when the persisted record has none. */
  function toolCoverage(record) {
    if (record.coverage !== null && record.coverage !== undefined) return record.coverage;
    const files = Array.isArray(record.files) ? record.files.map((file) => file.path) : [];
    return conclusionCoverage(record.explanations ?? new Map(), files);
  }

  /** Model-facing text from lines, dropping the empty ones. */
  function toolText(lines) {
    return lines.filter((line) => typeof line === 'string' && line.trim() !== '').join('\n');
  }

  /** One conclusion as markdown text (used by the round/report tools). */
  function conclusionText(conclusion) {
    if (conclusion === null || conclusion === undefined) return '（该轮还没有结论）';
    const lines = [
      `结论：${conclusion.verdict ?? ''}`,
      `摘要：${conclusion.summary ?? ''}`,
      (conclusion.blockers ?? []).length === 0 ? '阻塞项：无' : '阻塞项：',
    ];
    for (const item of conclusion.blockers ?? []) {
      const where = [item.file, item.line].filter((value) => value !== undefined && value !== null && value !== '').join(':');
      const id = typeof item.id === 'string' && item.id !== '' ? `[${item.id}] ` : '';
      lines.push(`- ${id}${item.title ?? item.point ?? ''}${where === '' ? '' : `（${where}）`}`);
    }
    if ((conclusion.suggestions ?? []).length > 0) lines.push('修改建议：');
    for (const item of conclusion.suggestions ?? []) {
      const where = [item.file, item.line].filter((value) => value !== undefined && value !== null && value !== '').join(':');
      const id = typeof item.id === 'string' && item.id !== '' ? `[${item.id}] ` : '';
      lines.push(`- ${id}${item.title ?? item.point ?? ''}${where === '' ? '' : `（${where}）`}`);
    }
    if ((conclusion.nextSteps ?? []).length > 0) {
      lines.push('下一步：');
      for (const step of conclusion.nextSteps) lines.push(`- ${step}`);
    }
    return toolText(lines);
  }

  /** One report as markdown text. */
  function reportText(report) {
    if (report === null || report === undefined) return '（还没有总体报告）';
    const lines = [
      `总体评价：${report.verdict ?? ''}`,
      `摘要：${report.summary ?? ''}`,
    ];
    if (Array.isArray(report.risks) && report.risks.length > 0) {
      lines.push('总体初筛风险：');
      for (const risk of report.risks) {
        const where = typeof risk.file === 'string' && risk.file !== '' ? `（${risk.file}）` : '';
        lines.push(`- [${risk.severity ?? '?'}] ${risk.point ?? ''}${where}`);
      }
    }
    if (Array.isArray(report.order) && report.order.length > 0) {
      lines.push('审查顺序：');
      for (const item of report.order) lines.push(`- ${item.file}${item.reason ? `：${item.reason}` : ''}`);
    }
    if (report.focus && typeof report.focus === 'object' && Object.keys(report.focus).length > 0) {
      lines.push(`审查重点：${JSON.stringify(report.focus)}`);
    }
    return toolText(lines);
  }

  /** Per-file analysis as markdown text. */
  function analysisText(filePath, entry) {
    if (entry === undefined) return `${filePath}：还没有分析（尚未请求过逐文件分析）。`;
    if (entry.status === 'error') return `${filePath}：分析失败（${entry.error ?? '未知错误'}）。`;
    if (entry.status !== 'done' || entry.explanation === null || entry.explanation === undefined) {
      return `${filePath}：分析尚未完成（状态 ${entry.status ?? 'pending'}）。`;
    }
    const explanation = entry.explanation;
    const lines = [
      `文件：${filePath}`,
      `结论：${explanation.verdict ?? ''} · ${explanation.summary ?? ''}`,
    ];
    if (typeof explanation.logic === 'string' && explanation.logic !== '') {
      lines.push(`代码逻辑：${explanation.logic}`);
    }
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
  }

  /** One round entry as markdown text. */
  function roundText(entry) {
    if (entry === null || entry === undefined) return '（没有这一轮）';
    const lines = [`第 ${entry.round} 轮 · head ${String(entry.headSha ?? '').slice(0, 8)} · 结论版本 ${(entry.conclusions ?? []).length} 个`];
    const latest = (entry.conclusions ?? [])[entry.conclusions.length - 1];
    if (latest !== undefined) lines.push(conclusionText(latest.conclusion));
    const states = entry.feedback?.states ?? {};
    const entries = Object.entries(states);
    if (entries.length > 0) {
      lines.push('实现者反馈：');
      for (const [id, state] of entries) {
        lines.push(`- ${id}：${state?.status ?? '?'}${state?.reason ? `（${state.reason}）` : ''}`);
      }
    }
    return toolText(lines);
  }

  /** One file's diff text, capped so a tool result cannot flood the conversation. */
  async function diffText(record, filePath) {
    const diffFiles = await ensureDiffFiles(record);
    const diff = diffFiles.get(filePath);
    if (diff === undefined) return `${filePath}：没有找到该文件的 diff（可能没有变更或路径不对）。`;
    const limit = Math.max(4000, Number(settings.maxDiffCharsPerFile) || 14000);
    const text = diff.text.length > limit ? `${diff.text.slice(0, limit)}\n…（已截断，共 ${diff.text.length} 字符；完整内容见审查面板）` : diff.text;
    return text;
  }

  /** Reject a write whose revision is stale: the model re-reads and retries. */
  function assertToolRevision(record, revision) {
    const current = record.revision ?? 0;
    if (revision !== current) {
      throw toolError(TOOL_ERROR.staleRevision, `审查数据已被更新（当前 revision ${current}，传入 ${revision}）：请重新调用 review_get 读取 revision 后再改。`);
    }
  }

  /** Append one audit entry and bump the record revision a write just produced. */
  function recordToolAudit(record, exec, tool, summary) {
    const audit = Array.isArray(record.audit) ? record.audit : [];
    audit.push({
      at: Date.now(),
      tool,
      sessionId: agentSessionId(exec.agent),
      summary,
    });
    if (audit.length > 100) audit.splice(0, audit.length - 100);
    record.audit = audit;
    record.revision = (record.revision ?? 0) + 1;
  }

  /** Keep one model-written issue/suggestion inside the size and shape limits. */
  function sanitizeToolItem(item, kind) {
    if (item === null || typeof item !== 'object') throw toolError(TOOL_ERROR.invalidArgs, `${kind} 必须是对象`);
    const text = typeof item.point === 'string' ? item.point : (typeof item.title === 'string' ? item.title : '');
    if (text.trim() === '') throw toolError(TOOL_ERROR.invalidArgs, `${kind} 需要 point 或 title`);
    if (text.length > 500) throw toolError(TOOL_ERROR.limitExceeded, `${kind} 超过 500 字，请拆成多条`);
    const line = Number.isInteger(item.line) && item.line > 0 ? item.line : 0;
    const output = {
      point: text,
      line,
    };
    if (typeof item.severity === 'string') output.severity = item.severity === 'block' ? 'block' : 'suggest';
    if (typeof item.file === 'string' && item.file !== '') output.file = item.file;
    if (typeof item.suggestion === 'string' && item.suggestion.trim() !== '') output.suggestion = item.suggestion.trim().slice(0, 1000);
    return output;
  }

  /** One write's before/after summary for the audit trail. */
  function writeSummary(before, after) {
    const beforeText = before === null || before === undefined ? 0 : JSON.stringify(before).length;
    const afterText = after === null || after === undefined ? 0 : JSON.stringify(after).length;
    return `${beforeText} → ${afterText} 字符`;
  }

  /** What the reviewer currently has on screen in the panel (reported by the client). */
  const focusBySession = new Map();

  /** Build the compact review snapshot the model reads as runtime context (§5). */
  function reviewSnapshotText(record, focus) {
    const round = focus && Number.isInteger(focus.round) ? focus.round : (record.round ?? 1);
    const latest = latestConclusionVersionOf(record);
    const coverage = toolCoverage(record);
    const lines = [
      '<review-context>',
      `${provider.repo} · PR #${record.number} · ${record.pull?.title ?? ''}`,
      `head ${String(record.headSha ?? record.pull?.headSha ?? '').slice(0, 8)} · 第 ${round} 轮 · 结论：${record.conclusion === null || record.conclusion === undefined ? '尚未生成' : `${record.conclusion.verdict ?? ''}（v${latest?.version ?? '?'}，${latest?.published === true ? '已发布' : '未发布'}）`}`,
      `覆盖率：已分析 ${coverage.analyzed ?? 0}/${coverage.total ?? (record.files ?? []).length} 个文件${isStale(record) ? ' · 结论之后有新的改动' : ''}`,
    ];
    const view = focus && typeof focus.view === 'string' ? focus.view : 'overview';
    if (view === 'file' && typeof focus.path === 'string' && focus.path !== '') {
      const entry = record.explanations.get(focus.path);
      const analysis = entry === undefined
        ? '未分析'
        : entry.status === 'done'
          ? `已分析（${(entry.explanation?.issues ?? []).length} 条意见）`
          : entry.status === 'error' ? '分析失败' : '分析中';
      lines.push(`当前查看：文件 ${focus.path}（${analysis}${focus.pane === 'analysis' ? '，分析面板' : '，代码变更面板'}）`);
    } else {
      lines.push('当前查看：总览');
    }
    lines.push(
      `revision：${record.revision ?? 0}`,
      '提示：用户说“这条/这里”时指上述范围；读取细节用 review_* 工具；写入必须带上面的 revision。',
      '</review-context>',
    );
    return lines.join('\n');
  }

  /**
   * Render the snapshot for one session, or '' when the panel shows no review. It runs inside
   * the host's runtime-context assembly, which re-reads contributed text before every admitted
   * step, so the focus and the review record are both whatever the panel shows right now.
   */
  function reviewContextText(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return '';
    const bound = activeReviewBySession.get(sessionId);
    if (!Number.isInteger(bound)) return '';
    const record = state.reviews.get(bound);
    if (record === undefined || record === null) return '';
    try {
      return reviewSnapshotText(record, focusBySession.get(sessionId) ?? null);
    } catch (error) {
      console.warn('[pr-review] 生成审查上下文失败', error);
      return '';
    }
  }

  /**
   * Record the reviewer's current view. Nothing is pushed to the agent here: the snapshot is
   * registered as a runtime-context contribution, and the host renders it into its own
   * superseding snapshot on the next step. A message injected with `source.kind:
   * 'runtime-context'` is owned by the agent loop and dropped at admission, so that path never
   * reaches the model.
   */
  function recordReviewFocus(sessionId, focus) {
    if (typeof sessionId !== 'string' || sessionId === '') return;
    focusBySession.set(sessionId, focus);
  }

  /** Human-written conclusion items keep their existing ids where the point is unchanged. */
  function normalizeConclusionItems(kind, items, existing) {
    const byKey = new Map();
    for (const item of Array.isArray(existing) ? existing : []) {
      if (item !== null && typeof item === 'object' && typeof item.point === 'string') {
        byKey.set(`${typeof item.file === 'string' ? item.file : ''}|${item.point}`, item.id);
      }
    }
    const seen = new Set();
    const output = [];
    for (const raw of Array.isArray(items) ? items : []) {
      if (raw === null || typeof raw !== 'object') throw toolError(TOOL_ERROR.invalidArgs, `${kind} 每条必须是对象`);
      const point = typeof raw.point === 'string' ? raw.point.trim() : '';
      if (point === '') throw toolError(TOOL_ERROR.invalidArgs, `${kind} 每条需要 point`);
      if (point.length > 500) throw toolError(TOOL_ERROR.limitExceeded, `${kind} 某条超过 500 字，请拆分后重试`);
      const file = typeof raw.file === 'string' ? raw.file.trim() : '';
      const line = Number.isInteger(raw.line) && raw.line > 0 ? raw.line : 0;
      const prior = byKey.get(`${file}|${point}`);
      let id = typeof prior === 'string' && prior !== '' ? prior : itemId(kind, file, point);
      if (seen.has(id)) id = itemId(kind, file, point);
      seen.add(id);
      output.push({ id, file, point, line });
    }
    return output;
  }

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
      // No in-tree write path produces the legacy `suggestions` key any more, but clearing
      // still drops it when rewriting: a stale out-of-tree cache must not fold straight back
      // on every later read while the count claimed the findings cleared.
      const { suggestions: _legacy, ...explanation } = entry.explanation;
      entry.explanation = { ...explanation, issues: nextFindings };
      entry.updatedAt = at;
    }
    const risks = Array.isArray(record.report?.risks) ? record.report.risks : [];
    const nextRisks = effective === 'all' ? [] : risks.filter((item) => item?.severity === 'block');
    cleared.risks = risks.length - nextRisks.length;
    if (cleared.risks > 0) record.report = { ...record.report, risks: nextRisks };
    return cleared;
  }

  /** Read-only review tools: they never mutate review data. */
  function readOnlyToolDefinitions(numberProperty, textOutput) {
    return [
      {
        name: 'review_list_prs',
        description: '列出当前仓库的 open PR 及其审查状态（审查中/已报告/结论/是否已发布），用来发现可审查的 PR 编号。',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
        output: textOutput,
        async execute() {
          const prs = Array.isArray(state.prs) ? state.prs : [];
          const lines = [`${provider.repo}（${provider.platform}）open PR：${prs.length} 个`];
          for (const pr of prs) {
            const record = state.reviews.get(pr.number);
            const summary = record === undefined ? null : reviewSummary(record);
            const verdict = summary?.verdict ?? null;
            const progress = record === undefined
              ? '未审查'
              : record.status === 'reviewing'
                ? '审查中'
                : record.status === 'error'
                  ? `审查失败：${record.error ?? ''}`
                  : record.conclusion === null
                    ? '已报告，未生成结论'
                    : `结论 ${verdict ?? ''}`;
            lines.push(`- #${pr.number} ${pr.title ?? ''}（${progress}；第 ${record?.round ?? 1} 轮；head ${String(pr.headSha ?? '').slice(0, 8)}）`);
          }
          if (prs.length === 0) lines.push('- 暂无 open PR（列表可能还没轮询到，可稍后再试）。');
          return toolText(lines);
        },
      },
      {
        name: 'review_get',
        description: '读取一个 PR 审查的概要：轮次、状态、head、结论版本与发布状态、覆盖率、是否过期、变更文件数。',
        parameters: { type: 'object', additionalProperties: false, properties: { number: numberProperty } },
        output: textOutput,
        async execute(args, exec) {
          const record = requireToolReview(exec.agent, args.number);
          const latest = latestConclusionVersionOf(record);
          const coverage = toolCoverage(record);
          return toolText([
            `PR #${record.number} · ${record.pull?.title ?? ''}`,
            `状态：${record.status ?? '?'}${record.error ? `（${record.error}）` : ''} · 第 ${record.round ?? 1} 轮 · head ${String(record.headSha ?? record.pull?.headSha ?? '').slice(0, 8)}`,
            `结论：${record.conclusion === null || record.conclusion === undefined ? '尚未生成' : `${record.conclusion.verdict ?? ''}（v${latest?.version ?? '?'}，${latest?.published === true ? '已发布' : '未发布'}）`}`,
            `覆盖率：已分析 ${coverage.analyzed ?? 0}/${coverage.total ?? (record.files ?? []).length} 个文件`,
            `过期：${isStale(record) ? '结论之后有新的报告/分析改动，可重新生成结论' : '无'}`,
            `变更文件：${(record.files ?? []).length} 个 · 已发布评论：${(record.published ?? []).length} 条`,
            `总览：初筛风险 ${overviewCounts(record).risks} · 逐文件审查意见 ${overviewCounts(record).issues} 条（review_update_overview 可一次改总览）`,
            `revision：${record.revision ?? 0}（写入工具必须带回这个值）`,
          ]);
        },
      },
      {
        name: 'review_get_report',
        description: '读取总体报告：总体评价、摘要、总体初筛风险、审查顺序与审查重点。',
        parameters: { type: 'object', additionalProperties: false, properties: { number: numberProperty } },
        output: textOutput,
        async execute(args, exec) {
          return reportText(requireToolReview(exec.agent, args.number).report);
        },
      },
      {
        name: 'review_list_files',
        description: '列出变更文件及逐文件分析状态（未分析/分析中/已分析、审查意见数量），按审查顺序排列。',
        parameters: { type: 'object', additionalProperties: false, properties: { number: numberProperty } },
        output: textOutput,
        async execute(args, exec) {
          const record = requireToolReview(exec.agent, args.number);
          const files = Array.isArray(record.files) ? record.files : [];
          const order = Array.isArray(record.report?.order) ? record.report.order.map((item) => item.file) : [];
          const rank = (filePath) => {
            const index = order.indexOf(filePath);
            return index < 0 ? order.length + files.findIndex((file) => file.path === filePath) : index;
          };
          const sorted = [...files].sort((left, right) => rank(left.path) - rank(right.path));
          const lines = [`变更文件 ${files.length} 个（按审查顺序）：`];
          for (const file of sorted) {
            const entry = record.explanations.get(file.path);
            const progress = entry === undefined
              ? '未分析'
              : entry.status === 'done'
                ? `已分析（${(entry.explanation?.issues ?? []).length} 条意见）`
                : entry.status === 'error'
                  ? '分析失败'
                  : '分析中';
            lines.push(`- ${file.path}（${file.status ?? ''} +${file.additions ?? 0}/-${file.deletions ?? 0}；${progress}）`);
          }
          return toolText(lines);
        },
      },
      {
        name: 'review_get_analysis',
        description: '读取单个变更文件的逐文件分析：结论、代码逻辑与审查意见（含建议与行号）。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', description: '变更文件路径（相对仓库根）。' },
            number: numberProperty,
          },
          required: ['path'],
        },
        output: textOutput,
        async execute(args, exec) {
          const record = requireToolReview(exec.agent, args.number);
          if (typeof args.path !== 'string' || args.path === '') throw toolError(TOOL_ERROR.invalidArgs, 'path 不能为空');
          return analysisText(args.path, record.explanations.get(args.path));
        },
      },
      {
        name: 'review_get_diff',
        description: '读取单个变更文件的 diff 文本（可能被截断，完整内容在审查面板）。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', description: '变更文件路径（相对仓库根）。' },
            number: numberProperty,
          },
          required: ['path'],
        },
        output: textOutput,
        async execute(args, exec) {
          const record = requireToolReview(exec.agent, args.number);
          if (typeof args.path !== 'string' || args.path === '') throw toolError(TOOL_ERROR.invalidArgs, 'path 不能为空');
          return diffText(record, args.path);
        },
      },
      {
        name: 'review_get_file',
        description: '读取 PR head 版本的文件完整内容（可指定行区间），用于核对实现细节。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', description: '文件路径（相对仓库根）。' },
            start: { type: 'integer', description: '起始行（1 起，含）。' },
            end: { type: 'integer', description: '结束行（1 起，含）。' },
            number: numberProperty,
          },
          required: ['path'],
        },
        output: textOutput,
        async execute(args, exec) {
          const record = requireToolReview(exec.agent, args.number);
          if (typeof args.path !== 'string' || args.path === '') throw toolError(TOOL_ERROR.invalidArgs, 'path 不能为空');
          const file = await ensureFileContent(record, args.path);
          let text = typeof file?.content === 'string' ? file.content : '';
          let suffix = file?.truncated === true ? '\n…（文件过大，已截断）' : '';
          const start = Number.isInteger(args.start) && args.start > 0 ? args.start : 0;
          const end = Number.isInteger(args.end) && args.end >= start && start > 0 ? args.end : 0;
          if (start > 0) {
            const lines = text.split('\n');
            const last = end > 0 ? Math.min(end, lines.length) : Math.min(start + 199, lines.length);
            text = lines.slice(start - 1, last).join('\n');
            suffix = `\n（显示第 ${start}-${last} 行，共 ${lines.length} 行）`;
          }
          return `${text.slice(0, 120_000)}${suffix}`;
        },
      },
      {
        name: 'review_list_rounds',
        description: '列出审查轮次：每轮 head、结论版本数、是否发布与实现者反馈。',
        parameters: { type: 'object', additionalProperties: false, properties: { number: numberProperty } },
        output: textOutput,
        async execute(args, exec) {
          const record = requireToolReview(exec.agent, args.number);
          const rounds = roundHistoryOf(record);
          if (rounds.length === 0) return '（还没有轮次记录）';
          const lines = [`PR #${record.number} 共 ${rounds.length} 轮：`];
          for (const entry of rounds) {
            const latest = (entry.conclusions ?? [])[entry.conclusions.length - 1];
            lines.push(
              `- 第 ${entry.round} 轮 · head ${String(entry.headSha ?? '').slice(0, 8)} · 结论 ${latest === undefined ? '无' : `v${latest.version ?? '?'}（${latest.published === true ? '已发布' : '未发布'}）`} · 反馈状态 ${Object.keys(entry.feedback?.states ?? {}).length} 条`,
            );
          }
          return toolText(lines);
        },
      },
      {
        name: 'review_get_round',
        description: '读取指定轮次的结论与实现者反馈状态。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: { round: { type: 'integer', description: '轮次编号（从 1 开始）。' }, number: numberProperty },
          required: ['round'],
        },
        output: textOutput,
        async execute(args, exec) {
          const record = requireToolReview(exec.agent, args.number);
          if (!Number.isInteger(args.round) || args.round <= 0) throw toolError(TOOL_ERROR.invalidArgs, 'round 必须是正整数');
          const entry = roundHistoryOf(record).find((item) => item.round === args.round);
          return roundText(entry);
        },
      },
      {
        name: 'review_get_comments',
        description: '读取代码平台上该 PR 的评论（含实现者反馈原文，markdown）。',
        parameters: { type: 'object', additionalProperties: false, properties: { number: numberProperty } },
        output: textOutput,
        async execute(args, exec) {
          const record = requireToolReview(exec.agent, args.number);
          const client = await ensureClient();
          const comments = await client.listIssueComments(record.number);
          if (!Array.isArray(comments) || comments.length === 0) return '（该 PR 还没有评论）';
          const lines = [`PR #${record.number} 评论 ${comments.length} 条（从旧到新）：`];
          for (const comment of comments) {
            lines.push(`\n--- ${comment.author ?? '?'} · ${new Date(comment.createdAt ?? 0).toISOString().slice(0, 16)}`);
            lines.push(String(comment.body ?? '').slice(0, 6000));
          }
          return toolText(lines);
        },
      },
    ];
  }

  /** Mutating review tools: they rewrite review data or drive conclude/publish. */
  /** Write review tools: they rewrite analyses, report or conclusion in place. */
  function writeToolDefinitions(numberProperty, textOutput) {
    return [
      {
        name: 'review_update_analysis',
        description: '更新单个变更文件的逐文件分析（结论/摘要/代码逻辑/审查意见），改写审查数据，右栏面板随后可见。必须带 review_get 返回的 revision 做乐观锁。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string', description: '变更文件路径（相对仓库根）。' },
            revision: { type: 'integer', description: 'review_get 返回的 revision。' },
            verdict: { type: 'string', enum: ['pass', 'suggest', 'block'], description: '该文件的结论。' },
            summary: { type: 'string', description: '该文件的一句话结论。' },
            logic: { type: 'string', description: '代码逻辑说明（整体，不复述 diff）。' },
            issues: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
              description: '审查意见列表（传入即整体替换）；每条 { point, suggestion?, line?, severity? }，point 写问题与影响（≤ 500 字），suggestion 写具体修法，一条最多一条。',
            },
            number: numberProperty,
          },
          required: ['path', 'revision'],
        },
        output: textOutput,
        async execute(args, exec) {
          const record = requireToolReview(exec.agent, args.number);
          if (typeof args.path !== 'string' || args.path === '') throw toolError(TOOL_ERROR.invalidArgs, 'path 不能为空');
          const file = (record.files ?? []).find((item) => item.path === args.path);
          if (file === undefined) throw toolError(TOOL_ERROR.notFound, `path 不在变更文件里：${args.path}`);
          assertToolRevision(record, args.revision);
          const issues = args.issues === undefined
            ? undefined
            : args.issues.map((item) => sanitizeToolItem(item, 'issue'));
          const entry = record.explanations.get(args.path) ?? {
            file: args.path,
            status: 'done',
            error: null,
            explanation: null,
            chat: [],
            updatedAt: 0,
          };
          const before = entry.explanation ?? null;
          // Normalize the merged explanation through the single shape point: issues become
          // four-key findings (suggestion inlined), any legacy `suggestions` key is dropped,
          // and fields the call omits (walkthrough/changes/unverified) survive the edit.
          const next = normalizeExplanation({
            verdict: args.verdict ?? before?.verdict,
            summary: args.summary ?? before?.summary,
            logic: args.logic ?? before?.logic,
            walkthrough: before?.walkthrough,
            changes: before?.changes,
            issues: issues ?? before?.issues,
            unverified: before?.unverified,
          });
          if (JSON.stringify(next).length > 12_000) {
            throw toolError(TOOL_ERROR.limitExceeded, '该文件分析超过 12000 字符，请精简 issues 后重试。');
          }
          entry.explanation = next;
          entry.status = 'done';
          entry.error = null;
          entry.updatedAt = Date.now();
          record.explanations.set(args.path, entry);
          recordToolAudit(record, exec, 'review_update_analysis', `${args.path}: ${writeSummary(before, next)}`);
          scheduleSave();
          return toolText([
            `已更新分析：${args.path}（revision ${record.revision}）`,
            `结论：${next.verdict} · ${next.summary}`,
            `意见 ${next.issues.length} 条`,
            '需要继续修改请重新 review_get 取 revision。',
          ]);
        },
      },
      {
        name: 'review_update_report',
        description: '更新总体报告（总体评价/摘要/总体初筛风险/审查顺序/审查重点），改写审查数据，右栏面板随后可见。必须带 review_get 返回的 revision 做乐观锁。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            revision: { type: 'integer', description: 'review_get 返回的 revision。' },
            verdict: { type: 'string', enum: ['pass', 'suggest', 'block'], description: '总体评价。' },
            summary: { type: 'string', description: '总体摘要。' },
            risks: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
              description: '总体初筛风险（传入即整体替换）；每条 { severity?, file?, point }，point ≤ 500 字。',
            },
            order: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
              description: '审查顺序（传入即整体替换）；每条 { file, reason? }。',
            },
            focus: { type: 'object', additionalProperties: true, description: '审查重点（自由结构）。' },
            number: numberProperty,
          },
          required: ['revision'],
        },
        output: textOutput,
        async execute(args, exec) {
          const record = requireToolReview(exec.agent, args.number);
          if (record.report === null || record.report === undefined) {
            throw toolError(TOOL_ERROR.notFound, '还没有总体报告：请先完成审查（review_list_prs 可看状态）。');
          }
          assertToolRevision(record, args.revision);
          const before = record.report;
          const next = { ...before };
          if (args.verdict !== undefined) next.verdict = normalizeVerdict(args.verdict, before.verdict ?? 'suggest');
          if (args.summary !== undefined) next.summary = String(args.summary);
          if (args.risks !== undefined) {
            next.risks = args.risks.map((item) => {
              if (item === null || typeof item !== 'object') throw toolError(TOOL_ERROR.invalidArgs, 'risks 的每一行必须是对象');
              const point = typeof item.point === 'string' ? item.point.trim() : '';
              if (point === '') throw toolError(TOOL_ERROR.invalidArgs, 'risks 每行需要 point');
              if (point.length > 500) throw toolError(TOOL_ERROR.limitExceeded, 'risks 某条超过 500 字，请精简');
              return {
                severity: item.severity === 'block' ? 'block' : 'suggest',
                file: typeof item.file === 'string' ? item.file : '',
                point,
              };
            });
          }
          if (args.order !== undefined) {
            next.order = args.order.map((item) => {
              if (item === null || typeof item !== 'object') throw toolError(TOOL_ERROR.invalidArgs, 'order 的每一行必须是对象');
              const file2 = typeof item.file === 'string' ? item.file : '';
              if (file2 === '') throw toolError(TOOL_ERROR.invalidArgs, 'order 每行需要 file');
              return { file: file2, reason: typeof item.reason === 'string' ? item.reason : '' };
            });
          }
          if (args.focus !== undefined) next.focus = args.focus;
          if (JSON.stringify(next).length > 12_000) {
            throw toolError(TOOL_ERROR.limitExceeded, '报告超过 12000 字符，请精简 risks/order/summary 后重试。');
          }
          record.report = next;
          record.reportUpdatedAt = Date.now();
          recordToolAudit(record, exec, 'review_update_report', `报告: ${writeSummary(before, next)}`);
          scheduleSave();
          return toolText([
            `已更新总体报告（revision ${record.revision}）`,
            `总体评价：${next.verdict ?? ''} · ${String(next.summary ?? '').slice(0, 160)}`,
            `初筛风险 ${(next.risks ?? []).length} 条 / 审查顺序 ${(next.order ?? []).length} 个文件`,
            '报告更新会让结论变 stale，需要时可重新生成结论。',
          ]);
        },
      },
      {
        name: 'review_update_conclusion',
        description: '调整当前轮次的最终结论（总体评价/摘要/阻塞项/修改建议/下一步）。这是下一份「发布」评论的正文来源，改完再点发布即可。必须带 review_get 返回的 revision；不要直接去平台上编辑已发布的评论。用户要改的条目不唯一时，先 review_get_round 取条目 id 并用 ask_user_question 确认改哪几条。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            revision: { type: 'integer', description: 'review_get 返回的 revision。' },
            verdict: { type: 'string', enum: ['pass', 'suggest', 'block'], description: '总体评价。' },
            summary: { type: 'string', description: '总体摘要。' },
            blockers: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
              description: '阻塞项（传入即整体替换，[] 表示没有阻塞项）；每条 { point, file?, line? }，point ≤ 500 字。',
            },
            suggestions: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
              description: '修改建议（传入即整体替换，[] 表示去掉该小节）；每条 { point, file?, line? }。',
            },
            nextSteps: {
              type: 'array',
              items: { type: 'string' },
              description: '下一步清单（传入即整体替换，[] 表示清空）。',
            },
            number: numberProperty,
          },
          required: ['revision'],
        },
        output: textOutput,
        async execute(args, exec) {
          const record = requireToolReview(exec.agent, args.number);
          const before = record.conclusion ?? null;
          if (before === null || before === undefined) {
            throw toolError(TOOL_ERROR.notFound, '当前轮还没有最终结论：请先在审查面板生成结论，再调整。');
          }
          assertToolRevision(record, args.revision);
          const working = {
            verdict: args.verdict ?? before.verdict,
            summary: args.summary ?? before.summary,
            blockers: args.blockers === undefined
              ? (Array.isArray(before.blockers) ? before.blockers : [])
              : normalizeConclusionItems('blocker', args.blockers, before.blockers),
            suggestions: args.suggestions === undefined
              ? (Array.isArray(before.suggestions) ? before.suggestions : [])
              : normalizeConclusionItems('suggestion', args.suggestions, before.suggestions),
            nextSteps: args.nextSteps === undefined
              ? (Array.isArray(before.nextSteps) ? before.nextSteps : [])
              : args.nextSteps.map((item) => {
                  if (typeof item !== 'string' || item.trim() === '') throw toolError(TOOL_ERROR.invalidArgs, 'nextSteps 每条必须是非空字符串');
                  return item.trim();
                }),
          };
          const normalized = normalizeConclusion(working, {
            files: (record.files ?? []).map((file) => file.path),
          });
          pushConclusionVersion(record, 'human', normalized, record.coverage);
          record.conclusionEditedAt = Date.now();
          const touched = [...normalized.blockers, ...normalized.suggestions].map((item) => item.id);
          record.humanItemIds = [...new Set([...(record.humanItemIds ?? []), ...touched])];
          recordToolAudit(record, exec, 'review_update_conclusion', `结论: ${writeSummary(before, normalized)}`);
          scheduleSave();
          return toolText([
            `已更新当前轮结论（revision ${record.revision}）：${normalized.verdict} · ${normalized.summary.slice(0, 160)}`,
            `阻塞项 ${normalized.blockers.length} 条 · 修改建议 ${normalized.suggestions.length} 条 · 下一步 ${normalized.nextSteps.length} 条`,
            '这就是下一份发布评论的正文；在审查面板点「发布」并按需勾选后即可发出。',
          ]);
        },
      },
    ];
  }

  /** Action review tools: they drive conclude, publish and platform links. */
  function actionToolDefinitions(numberProperty, textOutput) {
    return [
      {
        name: 'review_conclude',
        description: '为当前轮触发（重新）生成最终结论，等同于审查面板的「生成最终结论 / 重新生成结论」按钮。后台运行，可用 review_get 查看进度与结果。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: { number: numberProperty },
        },
        output: textOutput,
        async execute(args, exec) {
          const record = requireToolReview(exec.agent, args.number);
          if (record.status === 'reviewing') throw toolError(TOOL_ERROR.conflict, '该 PR 正在审查中，请等审查完成后再生成结论。');
          if (record.report === null || record.report === undefined) throw toolError(TOOL_ERROR.notFound, '还没有审查报告，请先完成审查再生成结论。');
          if (record.concluding !== null && record.concluding !== undefined) throw toolError(TOOL_ERROR.conflict, '结论正在生成中，请稍候。');
          const started = startConclude(record);
          if (!started.ok) throw toolError(TOOL_ERROR.conflict, '结论正在生成中，请稍候。');
          return toolText([
            `已开始生成结论：PR #${record.number} 第 ${record.round ?? 1} 轮（后台任务）`,
            '稍后用 review_get 查看状态与 revision；生成完成后可在对话里继续调整，或让用户点「发布」。',
          ]);
        },
      },
      {
        name: 'review_publish',
        description: '把当前轮的最终结论发布为一条新的 PR 评论（等同于审查面板的「发布」按钮）。默认全量选中；传 includeIds 只发布列出的条目（id 见 review_get_round 的结论条目）。会真实写入代码平台，用户明确要求发布时才调用；同一轮同一版本重复发布需要 force。若用户没说清发布范围、或是否要追加一条重复评论，先用 ask_user_question 列出候选让用户选，不要猜。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            number: numberProperty,
            force: { type: 'boolean', description: '同一轮同一结论版本已发布过时，是否仍然追加一条评论。' },
            includeIds: {
              type: 'array',
              items: { type: 'string' },
              description: '只发布这些阻塞项/修改建议的 id（来自 review_get_round 的结论条目）；省略或空数组外的省略即全量。',
            },
          },
        },
        output: textOutput,
        async execute(args, exec) {
          const record = requireToolReview(exec.agent, args.number);
          const includeIds = Array.isArray(args.includeIds) && args.includeIds.length > 0
            ? args.includeIds.filter((id) => typeof id === 'string' && id !== '')
            : null;
          const result = await publishReviewComment(record, {
            force: args.force === true,
            includeIds,
          });
          const url = typeof result.comment?.url === 'string' ? result.comment.url : '';
          return toolText([
            `已发布审查评论：PR #${record.number} 第 ${record.round ?? 1} 轮（版本 v${latestConclusionVersionOf(record)?.version ?? '?'}）`,
            url === '' ? '' : `评论链接：${url}`,
            `已发布评论总数：${Array.isArray(result.published) ? result.published.length : 0}`,
            includeIds === null ? '' : `本次仅纳入 ${includeIds.length} 条勾选条目（其余未发布）。`,
          ]);
        },
      },
      {
        name: 'review_get_links',
        description: '返回该 PR 的代码平台链接与最新一条审查评论链接，用于「在代码平台打开 / 查看评论」。',
        parameters: { type: 'object', additionalProperties: false, properties: { number: numberProperty } },
        output: textOutput,
        async execute(args, exec) {
          const record = requireToolReview(exec.agent, args.number);
          const links = reviewLinksOf(record);
          return toolText([
            `PR #${record.number} · ${record.pull?.title ?? ''}`,
            links.pullUrl === '' ? 'PR 链接：无' : `代码平台：${links.pullUrl}`,
            links.latestCommentUrl === '' ? '最新审查评论：还没有发布过评论' : `最新审查评论：${links.latestCommentUrl}`,
            `已发布评论：${Array.isArray(record.published) ? record.published.length : 0} 条`,
          ]);
        },
      },
      {
        name: 'review_update_overview',
        description: '一次更新「总览」：总体评价/摘要、总体初筛风险、审查顺序、审查重点，以及当前轮结论（阻塞项/修改建议/下一步），可选清理逐文件审查意见（clearFindings）。会刷新结论时间戳（清除 stale），并让面板、发布评论与后续重新生成看到同一份总览；用户说“结论通过 / 清理意见”时优先用它，不要逐个文件改。必须带 revision。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            revision: { type: 'integer', description: 'review_get 返回的 revision。' },
            verdict: { type: 'string', enum: ['pass', 'suggest', 'block'], description: '总体评价（同时写入总体报告与结论）。' },
            summary: { type: 'string', description: '总体摘要（同时写入总体报告与结论）。' },
            risks: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
              description: '总体初筛风险（传入即整体替换）；每条 { severity?, file?, point }，point ≤ 500 字。',
            },
            order: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
              description: '审查顺序（传入即整体替换）；每条 { file, reason? }。',
            },
            focus: { type: 'object', additionalProperties: true, description: '审查重点（自由结构）。' },
            blockers: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
              description: '结论阻塞项（传入即整体替换，[] 表示没有阻塞项）；每条 { point, file?, line? }。',
            },
            suggestions: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
              description: '结论修改建议（传入即整体替换，[] 表示去掉该小节）；每条 { point, file?, line? }。',
            },
            nextSteps: {
              type: 'array',
              items: { type: 'string' },
              description: '结论下一步清单（传入即整体替换，[] 表示清空）。',
            },
            clearFindings: {
              type: 'string',
              enum: ['none', 'suggest', 'all'],
              description: '清理逐文件/风险层面的 findings：suggest=清 suggest 级审查意见与 suggest 级初筛风险（保留阻塞项）；all=清空全部意见与风险；suggestions 为弃用别名，等同 suggest。默认 none。',
            },
            number: numberProperty,
          },
          required: ['revision'],
        },
        output: textOutput,
        async execute(args, exec) {
          const record = requireToolReview(exec.agent, args.number);
          if (record.report === null || record.report === undefined) {
            throw toolError(TOOL_ERROR.notFound, '还没有总体报告：请先完成审查（review_list_prs 可看状态）。');
          }
          assertToolRevision(record, args.revision);
          const beforeReport = record.report;
          const beforeConclusion = record.conclusion ?? null;
          const beforeCounts = overviewCounts(record);

          // 1) report-level fields
          const nextReport = { ...beforeReport };
          let reportChanged = false;
          if (args.verdict !== undefined) { nextReport.verdict = normalizeVerdict(args.verdict, beforeReport.verdict ?? 'suggest'); reportChanged = true; }
          if (args.summary !== undefined) { nextReport.summary = String(args.summary); reportChanged = true; }
          if (args.risks !== undefined) {
            nextReport.risks = args.risks.map((item) => {
              if (item === null || typeof item !== 'object') throw toolError(TOOL_ERROR.invalidArgs, 'risks 的每一行必须是对象');
              const point = typeof item.point === 'string' ? item.point.trim() : '';
              if (point === '') throw toolError(TOOL_ERROR.invalidArgs, 'risks 每行需要 point');
              if (point.length > 500) throw toolError(TOOL_ERROR.limitExceeded, 'risks 某条超过 500 字，请精简');
              return { severity: item.severity === 'block' ? 'block' : 'suggest', file: typeof item.file === 'string' ? item.file : '', point };
            });
            reportChanged = true;
          }
          if (args.order !== undefined) {
            nextReport.order = args.order.map((item) => {
              if (item === null || typeof item !== 'object') throw toolError(TOOL_ERROR.invalidArgs, 'order 的每一行必须是对象');
              const file = typeof item.file === 'string' ? item.file : '';
              if (file === '') throw toolError(TOOL_ERROR.invalidArgs, 'order 每行需要 file');
              return { file, reason: typeof item.reason === 'string' ? item.reason : '' };
            });
            reportChanged = true;
          }
          if (args.focus !== undefined) { nextReport.focus = args.focus; reportChanged = true; }
          if (reportChanged) {
            if (JSON.stringify(nextReport).length > 12_000) throw toolError(TOOL_ERROR.limitExceeded, '报告超过 12000 字符，请精简后重试。');
            record.report = nextReport;
          }

          // 2) conclusion-level fields (one human version, ids preserved)
          const working = {
            verdict: normalizeVerdict(args.verdict, beforeConclusion?.verdict ?? 'suggest'),
            summary: args.summary ?? beforeConclusion?.summary ?? '',
            blockers: args.blockers === undefined
              ? (Array.isArray(beforeConclusion?.blockers) ? beforeConclusion.blockers : [])
              : normalizeConclusionItems('blocker', args.blockers, beforeConclusion?.blockers),
            suggestions: args.suggestions === undefined
              ? (Array.isArray(beforeConclusion?.suggestions) ? beforeConclusion.suggestions : [])
              : normalizeConclusionItems('suggestion', args.suggestions, beforeConclusion?.suggestions),
            nextSteps: args.nextSteps === undefined
              ? (Array.isArray(beforeConclusion?.nextSteps) ? beforeConclusion.nextSteps : [])
              : args.nextSteps.map((item) => {
                  if (typeof item !== 'string' || item.trim() === '') throw toolError(TOOL_ERROR.invalidArgs, 'nextSteps 每条必须是非空字符串');
                  return item.trim();
                }),
          };
          const normalized = normalizeConclusion(working, { files: (record.files ?? []).map((file) => file.path) });
          // One instant for every stamp. The conclusion is written last, so the report and
          // explanation edits below can never read as newer than it (which would mark the
          // fresh conclusion stale again — a millisecond tick used to do exactly that).
          const writeAt = Date.now();
          pushConclusionVersion(record, 'human', normalized, record.coverage);
          record.conclusionEditedAt = writeAt;
          const touched = [...normalized.blockers, ...normalized.suggestions].map((item) => item.id);
          record.humanItemIds = [...new Set([...(record.humanItemIds ?? []), ...touched])];

          // 3) optional findings cleanup (evidence layer the overview renders)
          const cleared = clearOverviewFindings(record, args.clearFindings ?? 'none', writeAt);
          if (reportChanged || cleared.risks > 0) record.reportUpdatedAt = writeAt;

          const afterCounts = overviewCounts(record);
          recordToolAudit(
            record,
            exec,
            'review_update_overview',
            `风险 ${beforeCounts.risks}→${afterCounts.risks} · 审查意见 ${beforeCounts.issues}→${afterCounts.issues} · 结论 ${normalized.verdict}`,
          );
          scheduleSave();
          return toolText([
            `已更新总览（revision ${record.revision}）：结论 ${normalized.verdict} · ${normalized.summary.slice(0, 160)}`,
            `阻塞项 ${normalized.blockers.length} 条 / 修改建议 ${normalized.suggestions.length} 条 / 下一步 ${normalized.nextSteps.length} 条`,
            `初筛风险 ${afterCounts.risks} 条 · 逐文件审查意见 ${afterCounts.issues} 条`,
            cleared.issues + cleared.risks === 0 ? '' : `已清理：意见 ${cleared.issues} 条、风险 ${cleared.risks} 条`,
            '结论时间戳已刷新（stale 清除）；下一份发布评论、面板总览与重新生成看到的是同一份数据。',
          ]);
        },
      },
    ];
  }

  /** Register the review tools on the context that carries a tool registry (root or agent). */
  function registerReviewTools(ownerCtx) {
    const toolsService = ownerCtx.get('tools') ?? ownerCtx.tools;
    if (toolsService === undefined || toolsService === null || typeof toolsService.register !== 'function') return;
    const numberProperty = {
      type: 'integer',
      description: 'PR 编号；省略时使用当前会话在审查面板打开的 PR（没有绑定时取最近一次审查的 PR）。',
    };
    const textOutput = {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    };
    const definitions = [
      ...readOnlyToolDefinitions(numberProperty, textOutput),
      ...writeToolDefinitions(numberProperty, textOutput),
      ...actionToolDefinitions(numberProperty, textOutput),
    ];
    ownerCtx.effect(() => {
      const disposers = [];
      for (const definition of definitions) {
        try {
          const dispose = toolsService.register(definition);
          if (typeof dispose === 'function') disposers.push(dispose);
        } catch (error) {
          console.warn(`[pr-review] 注册工具 ${definition.name} 失败`, error);
        }
      }
      return () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            // registration cleanup is best-effort during unload
          }
        }
      };
    }, 'pr-review: review tools');
  }

  // The registry is a root service in some profiles; the Web composition mounts tools on each
  // agent instead, so register there through agent/created and let the agent own the lifetime.
  if (ctx.get('tools') !== undefined) {
    registerReviewTools(ctx);
  } else {
    ctx.on('agent/created', ({ agent }) => {
      if (agent === undefined || agent === null || agent.ctx === undefined) return;
      registerReviewTools(agent.ctx);
    });
  }

  // Steer the model to the local-data workflow: the platform comment is a render of the panel
  // data, so edits belong in review_* before publishing, not in published comments.
  const systemPrompt = ctx.get('systemPrompt');
  if (systemPrompt !== undefined && systemPrompt !== null && typeof systemPrompt.section === 'function') {
    try {
      systemPrompt.section({
        name: 'pr-review: review-data',
        order: 60,
        text: 'PR 审查插件：审查数据（总体报告、逐文件分析、当前轮结论）保存在本地，代码平台上的审查评论只是这份数据的渲染结果。要调整下一次发布的审查意见，用 review_update_overview 一次改总览（结论 + 总体评价/风险/顺序，可选 clearFindings 清理逐文件审查意见）；只有单文件/单轮细节才用 review_update_conclusion / review_update_analysis / review_update_report（先 review_get 取 revision）；不要直接编辑平台上已发布的评论。用户要求「重新生成结论 / 发布 / 查看评论 / 在代码平台打开」时，分别用 review_conclude / review_publish / review_get_links 触发；发布是真实写操作，只在用户明确要求时调用。对话里出现 <review-context> 时，用户说「这个文件/这条/这里」默认指快照的「当前查看」范围：直接按它操作（例如标记该文件通过就 review_update_analysis + verdict），不要反问是哪个文件；只有没有快照时才问。需要确认时主动用 ask_user_question 问、不要猜：发布范围不唯一（哪些条目）、同一轮同一版本已发布过是否追加、要改哪一轮/哪个文件但快照缺失、或用户一句话里出现多个候选对象。',
      });
    } catch (error) {
      console.warn('[pr-review] 注册提示词段落失败', error);
    }
  }

  // The panel's snapshot is runtime context, not a pushed message: the host renders contributed
  // context into the user-role snapshot it owns, dedupes unchanged sections, and supersedes the
  // previous one, which is what keeps "这个文件" pointing at what the reviewer sees right now.
  if (systemPrompt !== undefined && systemPrompt !== null && typeof systemPrompt.context === 'function') {
    try {
      systemPrompt.context({
        name: 'pr-review: focus',
        order: CONTEXT_ORDER,
        interpolate: false,
        text: (context) => reviewContextText(agentSessionId(context?.agent)),
      });
    } catch (error) {
      console.warn('[pr-review] 注册运行时上下文失败', error);
    }
  }

  /** Read the optional panel focus fields a client reports alongside the active PR. */
  function focusOfBody(body) {
    if (body === null || typeof body !== 'object') return null;
    return {
      view: body.view === 'file' ? 'file' : 'overview',
      path: typeof body.path === 'string' ? body.path : '',
      pane: body.pane === 'analysis' ? 'analysis' : 'diff',
      round: Number.isInteger(body.round) && body.round > 0 ? body.round : 0,
    };
  }

  // The panel reports the PR it shows so tools default to what the reviewer is reading, and so
  // the runtime-context snapshot follows the panel; see `pr-review: focus` above.
  route(`${PREFIX}/active`, {
    POST: async (req, res) => {
      const text = await readBoundedBody(req);
      const body = text === null ? null : parseBody(text);
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
      const number = Number(body?.number);
      if (sessionId === '') {
        sendError(res, 400, 'bad-request', 'sessionId is required');
        return;
      }
      const focus = focusOfBody(body);
      if (Number.isInteger(number) && number > 0) {
        activeReviewBySession.set(sessionId, number);
        recordReviewFocus(sessionId, focus);
      } else {
        activeReviewBySession.delete(sessionId);
        focusBySession.delete(sessionId);
      }
      sendJson(res, 200, { ok: true, active: Number.isInteger(number) && number > 0 ? number : null });
    },
  });

  // View/file changes update the recorded focus; the host re-reads it on the next step.
  route(`${PREFIX}/focus`, {
    POST: async (req, res) => {
      const text = await readBoundedBody(req);
      const body = text === null ? null : parseBody(text);
      const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
      const number = Number(body?.number);
      if (sessionId === '' || !Number.isInteger(number) || number <= 0) {
        sendError(res, 400, 'bad-request', 'sessionId and number are required');
        return;
      }
      // Focus is also a binding report: a late `/active` release must not leave the panel
      // invisible to the agent, so a focus event re-binds the session to the PR on screen.
      activeReviewBySession.set(sessionId, number);
      recordReviewFocus(sessionId, focusOfBody(body));
      sendJson(res, 200, { ok: true, active: number });
    },
  });

  // ---------- lifecycle ----------

  void loadCache().then(() => {
    void refreshPulls();
  });

  const pollSeconds = Math.max(15, Number(settings.pollSeconds) || DEFAULTS.pollSeconds);
  ctx.effect(() => {
    const timer = setInterval(() => {
      void refreshPulls();
    }, pollSeconds * 1000);
    return () => clearInterval(timer);
  }, `pr-review: poll every ${pollSeconds}s`);

  ctx.effect(() => () => {
    if (state.saveTimer !== null) clearTimeout(state.saveTimer);
    for (const record of state.reviews.values()) {
      abortConclude(record);
      abortAnalysis(record);
    }
    // Synchronous flush: teardown may be the last turn the event loop gets.
    saveNowSync();
  }, 'pr-review: flush cache on unload');

  console.log(provider.repo === ''
    ? '[pr-review] ready: 未配置仓库，等待工作区会话从 git origin 识别（也可在插件配置中填写 baseUrl/repo）'
    : `[pr-review] ready: ${provider.label} → ${provider.baseUrl}`);
}

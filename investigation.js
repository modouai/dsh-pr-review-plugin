/**
 * Protocol helpers for the review investigation loop.
 *
 * Nothing here touches the host: query validation, dedupe keys, claim bookkeeping and
 * final-answer validation are pure functions so the loop's contract is unit-testable.
 */

export const QUERY_OPS = Object.freeze(['read', 'find', 'grep', 'tests', 'diff']);
const SCOPES = new Set(['changed', 'repo', 'tests']);
const CLAIM_STATUSES = new Set(['investigating', 'confirmed', 'refuted']);
const MAX_PATTERN = 200;

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const positive = (value) => (Number.isInteger(value) && value > 0 ? value : 0);
const CONTROL = /[\u0000-\u001f\u007f]/;
const BACKREFERENCE = /\\[1-9]/;
const NESTED_QUANTIFIER = /(\([^)]*[*+?}][^)]*\))[*+?{]/;
const MAX_SYMBOL = 200;
const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;

/** A preview of any rejected value; never throws, even for circular or exotic input. */
const preview = (value) => {
  try {
    const json = JSON.stringify(value);
    if (typeof json === 'string') return json.slice(0, 200);
  } catch {
    // Fall through to String(value).
  }
  try {
    return String(value).slice(0, 200);
  } catch {
    return '[unserializable]';
  }
};

/** A path the executor may read: repo-relative, no traversal, no absolute paths. */
export function isSafePath(value) {
  if (typeof value !== 'string' || value === '' || value.length > 300) return false;
  if (value.startsWith('/') || value.startsWith('~') || value.includes('\\')) return false;
  if (CONTROL.test(value) || WINDOWS_DRIVE.test(value)) return false;
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** A glob the executor may use: repo-relative, no traversal segments, no absolute paths. */
export function isSafeGlob(value) {
  if (typeof value !== 'string' || value === '' || value.length > 300) return false;
  if (value.startsWith('/') || value.startsWith('~') || value.includes('\\')) return false;
  if (CONTROL.test(value)) return false;
  return value.split('/').every((part) => part !== '..');
}

/** Normalize one query; an invalid query returns null and never reaches the executor. */
export function normalizeQuery(raw) {
  if (raw === null || typeof raw !== 'object') return null;
  const op = text(raw.op);
  if (!QUERY_OPS.includes(op)) return null;
  const path = text(raw.path);
  const symbol = text(raw.symbol);
  // Regex whitespace is meaningful, so the pattern is preserved verbatim.
  const pattern = typeof raw.pattern === 'string' ? raw.pattern : '';
  const pathGlob = text(raw.pathGlob);
  if (path !== '' && !isSafePath(path)) return null;
  if (pathGlob !== '' && !isSafeGlob(pathGlob)) return null;
  if (symbol.length > MAX_SYMBOL || CONTROL.test(symbol)) return null;
  if (op === 'read' && path === '') return null;
  if ((op === 'find' || op === 'tests') && symbol === '') return null;
  if (op === 'grep') {
    if (pattern.trim() === '' || pattern.length > MAX_PATTERN) return null;
    if (CONTROL.test(pattern) || BACKREFERENCE.test(pattern) || NESTED_QUANTIFIER.test(pattern)) return null;
    try {
      new RegExp(pattern);
    } catch {
      return null;
    }
  }
  if (op === 'diff' && path === '') return null;
  const startLine = positive(raw.startLine);
  const endLine = positive(raw.endLine);
  if (startLine > 0 && endLine > 0 && endLine < startLine) return null;
  return {
    op,
    path,
    symbol,
    pattern,
    pathGlob,
    scope: op === 'tests' ? 'tests' : (SCOPES.has(raw.scope) ? raw.scope : 'repo'),
    limit: Number.isInteger(raw.limit) && raw.limit > 0 ? Math.min(raw.limit, 20) : 20,
    startLine,
    endLine,
  };
}

/** Stable identity for the evidence cache. */
export function queryKey(query) {
  return JSON.stringify([
    query.op, query.path, query.symbol, query.pattern, query.pathGlob,
    query.scope, query.limit, query.startLine, query.endLine,
  ]);
}

/** Normalize one step's query batch; extra queries are rejected, not silently dropped. */
export function normalizeQueries(raw, max = 4) {
  const accepted = [];
  const rejected = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (accepted.length >= max) {
      rejected.push(`单步查询超过 ${max} 条，其余未执行`);
      break;
    }
    const query = normalizeQuery(item);
    if (query === null) {
      rejected.push(`查询格式不合法：${preview(item)}`);
      continue;
    }
    accepted.push(query);
  }
  return { accepted, rejected };
}

/** Merge one step's claims into the ledger; an existing id keeps its statement. */
export function normalizeClaims(raw, previous = [], max = 12) {
  const next = new Map();
  for (const claim of Array.isArray(previous) ? previous : []) {
    if (!claim || typeof claim !== 'object' || typeof claim.id !== 'string') continue;
    next.set(claim.id, claim);
  }
  for (const item of Array.isArray(raw) ? raw : []) {
    if (item === null || typeof item !== 'object') continue;
    const id = text(item.id);
    if (id === '') continue;
    const existing = next.get(id);
    const rawStatement = text(item.statement);
    const statement = rawStatement !== ''
      ? rawStatement.slice(0, 300)
      : (existing?.statement ?? '');
    if (statement === '') continue;
    const status = CLAIM_STATUSES.has(item.status) ? item.status : (existing?.status ?? 'investigating');
    const reason = typeof item.reason === 'string'
      ? item.reason.trim().slice(0, 500)
      : (existing?.reason ?? '');
    const evidence = Array.isArray(item.evidence)
      ? item.evidence.filter((value) => typeof value === 'string' && /^E\d+$/.test(value)).slice(0, 8)
      : (existing?.evidence ?? []);
    next.set(id, { id, statement, status, reason, evidence });
  }
  return { claims: [...next.values()].slice(0, max), overflow: next.size > max };
}

/**
 * Validate the terminal answer. Every claim must be closed; every confirmed claim must
 * cite real evidence and produce exactly one finding. The host synthesizes baseline
 * carry-overs from previousVerdicts, so the model may never supply roundItem items.
 */
export function validateFinal(final, claims, evidenceIds, mode = 'file') {
  if (final === null || typeof final !== 'object') return { ok: false, error: 'final 必须是对象' };
  const safeClaims = Array.isArray(claims) ? claims : [];
  const open = safeClaims.filter((claim) => claim.status === 'investigating');
  if (open.length > 0) return { ok: false, error: `仍有未闭合 claim：${open.map((claim) => claim.id).join('、')}` };
  const known = evidenceIds instanceof Set ? evidenceIds : new Set(Array.isArray(evidenceIds) ? evidenceIds : []);
  const refuted = [];
  const confirmed = new Map();
  const settled = safeClaims.map((claim) => {
    if (claim.status !== 'confirmed') {
      refuted.push({ point: claim.statement, reason: claim.reason || '已证伪' });
      return claim;
    }
    const evidence = claim.evidence.filter((id) => known.has(id));
    if (evidence.length === 0) {
      refuted.push({ point: claim.statement, reason: '确认缺少证据引用' });
      return { ...claim, status: 'refuted', evidence: [] };
    }
    const closed = { ...claim, evidence };
    confirmed.set(claim.id, closed);
    return closed;
  });
  const listKey = mode === 'report' ? 'risks' : 'issues';
  const list = Array.isArray(final[listKey]) ? final[listKey] : null;
  if (list === null) return { ok: false, error: `final.${listKey} 必须是数组` };
  const used = new Set();
  const items = [];
  for (const rawItem of list) {
    if (rawItem === null || typeof rawItem !== 'object') {
      return { ok: false, error: `final.${listKey} 的条目必须是对象` };
    }
    const point = text(rawItem.point);
    if (point === '') return { ok: false, error: '终稿条目缺少 point' };
    const claim = text(rawItem.claim);
    if (claim === '' || !confirmed.has(claim)) {
      return { ok: false, error: `终稿条目未对应已确认 claim：${point}` };
    }
    if (used.has(claim)) return { ok: false, error: `claim ${claim} 产生了多条审查意见` };
    used.add(claim);
    items.push({
      severity: rawItem.severity === 'block' ? 'block' : 'suggest',
      point,
      suggestion: text(rawItem.suggestion),
      line: positive(rawItem.line),
      ...(mode === 'report' ? { file: text(rawItem.file) } : {}),
      claim,
    });
  }
  for (const id of confirmed.keys()) {
    if (!used.has(id)) return { ok: false, error: `已确认 claim ${id} 没有对应的审查意见` };
  }
  const summary = text(final.summary);
  if (summary === '' && items.length === 0) {
    return { ok: false, error: '终稿既没有 summary 也没有审查意见' };
  }
  return { ok: true, claims: settled, issues: items, refuted, summary };
}

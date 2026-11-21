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
  if (op === 'read' && path === '') return null;
  if ((op === 'find' || op === 'tests') && symbol === '') return null;
  if (op === 'grep') {
    if (pattern.trim() === '' || pattern.length > MAX_PATTERN) return null;
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

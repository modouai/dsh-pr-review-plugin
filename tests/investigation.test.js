import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isSafeGlob, isSafePath, normalizeClaims, normalizeQueries, normalizeQuery, queryKey, validateFinal,
} from '../investigation.js';

test('normalizeQuery accepts the five ops and normalizes defaults', () => {
  assert.deepEqual(normalizeQuery({ op: 'read', path: 'src/a.js' }), {
    op: 'read', path: 'src/a.js', symbol: '', pattern: '', pathGlob: '',
    scope: 'repo', limit: 20, startLine: 0, endLine: 0,
  });
  const ranged = normalizeQuery({ op: 'read', path: 'src/a.js', startLine: 10, endLine: 30 });
  assert.equal(ranged.startLine, 10);
  assert.equal(ranged.endLine, 30);
  assert.equal(normalizeQuery({ op: 'diff', path: 'src/a.js' }).op, 'diff');
  assert.equal(normalizeQuery({ op: 'find', symbol: 'cacheMap', scope: 'tests' }).scope, 'tests');
  assert.equal(normalizeQuery({ op: 'tests', symbol: 'cacheMap' }).op, 'tests');
});

test('normalizeQuery rejects unsafe or malformed queries', () => {
  assert.equal(normalizeQuery({ op: 'rm', path: 'src/a.js' }), null);
  assert.equal(normalizeQuery({ op: 'read' }), null);
  assert.equal(normalizeQuery({ op: 'read', path: '../etc/passwd' }), null);
  assert.equal(normalizeQuery({ op: 'read', path: '/etc/passwd' }), null);
  assert.equal(normalizeQuery({ op: 'read', path: 'src\\a.js' }), null);
  assert.equal(normalizeQuery({ op: 'read', path: 'a'.repeat(301) }), null);
  assert.equal(normalizeQuery({ op: 'read', path: 'a.js', startLine: 10, endLine: 5 }), null);
  assert.equal(normalizeQuery({ op: 'find' }), null);
  assert.equal(normalizeQuery({ op: 'grep', pattern: '(' }), null);
  assert.equal(normalizeQuery({ op: 'grep', pattern: 'x'.repeat(201) }), null);
  assert.equal(normalizeQuery({ op: 'diff' }), null);
  assert.equal(normalizeQuery(null), null);
});

test('isSafePath only accepts repo-relative normal paths', () => {
  assert.equal(isSafePath('src/a.js'), true);
  assert.equal(isSafePath('a/b/c.md'), true);
  assert.equal(isSafePath(''), false);
  assert.equal(isSafePath('a//b'), false);
  assert.equal(isSafePath('a/../b'), false);
  assert.equal(isSafePath('./a'), false);
  assert.equal(isSafePath('~/.ssh/id_rsa'), false);
  assert.equal(isSafePath('C:/x'), false);
  assert.equal(isSafePath('a\u0000b'), false);
  assert.equal(isSafePath('a'.repeat(301)), false);
});

test('normalizeQueries caps the batch and reports rejects', () => {
  const { accepted, rejected } = normalizeQueries([
    { op: 'read', path: 'a.js' },
    { op: 'bogus' },
    { op: 'read', path: 'b.js' },
  ], 2);
  assert.deepEqual(accepted.map((query) => query.path), ['a.js', 'b.js']);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0], /不合法/);
});

test('queryKey distinguishes every normalized field', () => {
  const base = normalizeQuery({ op: 'read', path: 'a.js' });
  const variants = {
    op: 'diff', path: 'b.js', symbol: 'x', pattern: 'p', pathGlob: 'g',
    scope: 'tests', limit: 5, startLine: 1, endLine: 2,
  };
  for (const [field, value] of Object.entries(variants)) {
    assert.notEqual(queryKey({ ...base, [field]: value }), queryKey(base), field);
  }
  assert.equal(queryKey(base), queryKey({ ...base }));
});

test('normalizeQuery preserves grep pattern whitespace', () => {
  assert.equal(normalizeQuery({ op: 'grep', pattern: 'foo ' }).pattern, 'foo ');
  const spaced = normalizeQuery({ op: 'grep', pattern: ' +' });
  assert.notEqual(spaced, null);
  assert.equal(spaced.pattern, ' +');
  assert.equal(normalizeQuery({ op: 'grep', pattern: '   ' }), null);
});

test('normalizeQuery clamps the limit and pins tests scope', () => {
  assert.equal(normalizeQuery({ op: 'find', symbol: 'x', limit: 99 }).limit, 20);
  assert.equal(normalizeQuery({ op: 'find', symbol: 'x', limit: 0 }).limit, 20);
  assert.equal(normalizeQuery({ op: 'tests', symbol: 'x' }).scope, 'tests');
  assert.equal(normalizeQuery({ op: 'tests', symbol: 'x', scope: 'repo' }).scope, 'tests');
});

test('pathGlob safety allows double dots inside names but rejects traversal', () => {
  assert.equal(normalizeQuery({ op: 'grep', pattern: 'x', pathGlob: 'src/../a' }), null);
  const dotted = normalizeQuery({ op: 'grep', pattern: 'x', pathGlob: 'src/a..b/*.js' });
  assert.equal(dotted.pathGlob, 'src/a..b/*.js');
  assert.equal(isSafeGlob('src/../a'), false);
  assert.equal(isSafeGlob('src/a..b/*.js'), true);
  assert.equal(isSafeGlob('/src/a.js'), false);
});

test('normalizeQueries tolerates undefined input and entries', () => {
  assert.deepEqual(normalizeQueries(undefined), { accepted: [], rejected: [] });
  const { accepted, rejected } = normalizeQueries([undefined]);
  assert.deepEqual(accepted, []);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0], /不合法/);
  const circular = {};
  circular.self = circular;
  assert.doesNotThrow(() => normalizeQueries([circular]));
});

test('normalizeClaims merges by id, keeps prior state, and caps new claims', () => {
  const previous = [{ id: 'C1', statement: '旧断言', status: 'investigating', reason: '', evidence: [] }];
  const { claims, overflow } = normalizeClaims([
    { id: 'C1', status: 'confirmed', reason: '读到证据', evidence: ['E1', 'bogus'] },
    { id: 'C2', statement: '  新断言  ', status: 'refuted', reason: '无此调用' },
  ], previous);
  assert.equal(overflow, false);
  assert.deepEqual(claims, [
    { id: 'C1', statement: '旧断言', status: 'confirmed', reason: '读到证据', evidence: ['E1'] },
    { id: 'C2', statement: '新断言', status: 'refuted', reason: '无此调用', evidence: [] },
  ]);
  const capped = normalizeClaims(
    Array.from({ length: 3 }, (_, i) => ({ id: `C${i + 1}`, statement: `s${i}`, status: 'investigating' })),
    [],
    2,
  );
  assert.equal(capped.claims.length, 2);
  assert.equal(capped.overflow, true);
});

test('validateFinal rejects a final while a claim is still investigating', () => {
  const result = validateFinal({ summary: 's', issues: [] }, [
    { id: 'C1', statement: 'x', status: 'investigating', reason: '', evidence: [] },
  ], new Set(), 'file');
  assert.equal(result.ok, false);
  assert.match(result.error, /C1/);
});

test('validateFinal rejects an issue attached to a claim with no real evidence', () => {
  const result = validateFinal({
    summary: 's',
    issues: [{ severity: 'block', point: '悬空确认', claim: 'C1' }],
  }, [
    { id: 'C1', statement: '悬空确认', status: 'confirmed', reason: '模型说确认', evidence: ['E9'] },
  ], new Set(['E1']), 'file');
  assert.equal(result.ok, false, 'confirmed claim without a real issue cannot satisfy the tree');
  assert.match(result.error, /未对应已确认 claim/);
});

test('validateFinal accepts confirmed claims that cite real evidence exactly once', () => {
  const result = validateFinal({
    summary: '讲解',
    issues: [{ severity: 'block', point: '空指针', suggestion: '先判空', line: 2, claim: 'C1' }],
  }, [
    { id: 'C1', statement: '空指针', status: 'confirmed', reason: '第 2 行未判空', evidence: ['E1'] },
  ], new Set(['E1']), 'file');
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, [
    { severity: 'block', point: '空指针', suggestion: '先判空', line: 2, claim: 'C1' },
  ]);
  assert.deepEqual(result.refuted, []);
});

test('validateFinal rejects an issue that points at a refuted claim', () => {
  const result = validateFinal({
    summary: 's',
    issues: [{ severity: 'suggest', point: 'x', claim: 'C1' }],
  }, [
    { id: 'C1', statement: 'x', status: 'refuted', reason: '证伪', evidence: [] },
  ], new Set(), 'file');
  assert.equal(result.ok, false);
  assert.match(result.error, /未对应已确认 claim/);
});

test('validateFinal rejects a confirmed claim with no issue', () => {
  const result = validateFinal({ summary: 's', issues: [] }, [
    { id: 'C1', statement: 'x', status: 'confirmed', reason: 'r', evidence: ['E1'] },
  ], new Set(['E1']), 'file');
  assert.equal(result.ok, false);
  assert.match(result.error, /没有对应的审查意见/);
});

test('validateFinal exempts baseline carry-over items and validates report risks', () => {
  const fileResult = validateFinal({
    summary: 's',
    issues: [{ severity: 'suggest', point: '旧问题', roundItem: 2 }],
  }, [], new Set(), 'file');
  assert.equal(fileResult.ok, true);

  const reportResult = validateFinal({
    summary: '报告',
    risks: [{ severity: 'block', file: 'src/a.js', point: '并发写入', claim: 'C1' }],
  }, [
    { id: 'C1', statement: '并发写入', status: 'confirmed', reason: '读写同 Map', evidence: ['E2'] },
  ], new Set(['E2']), 'report');
  assert.equal(reportResult.ok, true);
  assert.equal(reportResult.issues[0].file, 'src/a.js');
});

test('validateFinal downgrades a confirmed claim whose evidence is unknown with a fixed reason', () => {
  const result = validateFinal({ summary: 's', issues: [] }, [
    { id: 'C1', statement: '悬空确认', status: 'confirmed', reason: '模型说确认', evidence: ['E9'] },
  ], new Set(['E1']), 'file');
  assert.equal(result.ok, true);
  assert.deepEqual(result.refuted, [{ point: '悬空确认', reason: '确认缺少证据引用' }]);
  assert.equal(result.claims[0].status, 'refuted');
  assert.deepEqual(result.claims[0].evidence, []);
});

test('validateFinal rejects a final with neither summary nor items', () => {
  const result = validateFinal({ summary: '   ', issues: [] }, [], new Set(), 'file');
  assert.equal(result.ok, false);
  assert.match(result.error, /既没有 summary/);
});

test('validateFinal rejects two issues that reuse one confirmed claim', () => {
  const result = validateFinal({
    summary: 's',
    issues: [
      { severity: 'block', point: '第一处', claim: 'C1' },
      { severity: 'suggest', point: '第二处', claim: 'C1' },
    ],
  }, [
    { id: 'C1', statement: 'x', status: 'confirmed', reason: 'r', evidence: ['E1'] },
  ], new Set(['E1']), 'file');
  assert.equal(result.ok, false);
  assert.match(result.error, /多条审查意见/);
});

test('normalizeClaims hardens status, truncation, evidence cap and empty statements', () => {
  const previous = [
    { id: 'C1', statement: '旧断言', status: 'confirmed', reason: '旧理由', evidence: ['E1'] },
    null,
    { id: 42, statement: 'ignored' },
  ];
  const { claims } = normalizeClaims([
    { id: 'C1', statement: '   ', status: 'bogus' },
    {
      id: 'C2',
      statement: 'x'.repeat(400),
      status: 'bogus',
      reason: 'r'.repeat(600),
      evidence: Array.from({ length: 10 }, (_, i) => `E${i + 1}`),
    },
    { id: 'C3', statement: '   ', status: 'confirmed' },
  ], previous);
  assert.equal(claims.length, 2);
  assert.deepEqual(claims[0], { id: 'C1', statement: '旧断言', status: 'confirmed', reason: '旧理由', evidence: ['E1'] });
  assert.equal(claims[1].statement, 'x'.repeat(300));
  assert.equal(claims[1].status, 'investigating');
  assert.equal(claims[1].reason, 'r'.repeat(500));
  assert.deepEqual(claims[1].evidence, ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8']);
});

test('normalizeQuery rejects ReDoS-prone grep patterns and unsafe symbols', () => {
  assert.equal(normalizeQuery({ op: 'grep', pattern: '(a+)+$' }), null);
  assert.equal(normalizeQuery({ op: 'grep', pattern: '(x*)*' }), null);
  assert.equal(normalizeQuery({ op: 'grep', pattern: '\\1' }), null);
  const literal = normalizeQuery({ op: 'grep', pattern: 'new Map\\(' });
  assert.notEqual(literal, null);
  assert.equal(literal.pattern, 'new Map\\(');
  assert.equal(normalizeQuery({ op: 'find', symbol: 'a\u0000b' }), null);
  assert.equal(normalizeQuery({ op: 'find', symbol: 'a'.repeat(201) }), null);
  assert.notEqual(normalizeQuery({ op: 'find', symbol: 'a'.repeat(200) }), null);
  assert.equal(normalizeQuery({ op: 'grep', pattern: 'a\u0000b' }), null);
});

test('validateFinal enforces allowed baseline round items when provided', () => {
  const final = { summary: 's', issues: [{ severity: 'suggest', point: '旧问题', roundItem: 2 }] };
  const rejected = validateFinal(final, [], new Set(), 'file', { allowedRoundItems: new Set([1]) });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /不存在的基准序号：2/);
  assert.equal(validateFinal(final, [], new Set(), 'file', { allowedRoundItems: new Set([1, 2]) }).ok, true);
  assert.equal(validateFinal(final, [], new Set(), 'file').ok, true);
});

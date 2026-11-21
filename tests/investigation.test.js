import test from 'node:test';
import assert from 'node:assert/strict';

import { isSafeGlob, isSafePath, normalizeQueries, normalizeQuery, queryKey } from '../investigation.js';

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

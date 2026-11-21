import test from 'node:test';
import assert from 'node:assert/strict';

import { isSafePath, normalizeQueries, normalizeQuery, queryKey } from '../investigation.js';

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
  assert.notEqual(queryKey(base), queryKey({ ...base, startLine: 1 }));
  assert.notEqual(queryKey(base), queryKey({ ...base, symbol: 'x' }));
  assert.equal(queryKey(base), queryKey({ ...base }));
});

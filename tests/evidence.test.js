import test from 'node:test';
import assert from 'node:assert/strict';

import { createEvidenceExecutor } from '../evidence.js';
import { normalizeQuery } from '../investigation.js';

const diffFiles = new Map([
  ['src/a.js', { text: 'line1\nconst cacheMap = new Map();\n' }],
  ['tests/a.test.js', { text: 'import { cacheMap } from "../src/a.js";\n' }],
]);

function executor(overrides = {}) {
  return createEvidenceExecutor({
    readFile: async (filePath) => {
      if (filePath === 'src/a.js') return 'l1\nl2\nfunction writeCache() {\n  cacheMap.set(1, 2);\n}\n';
      throw new Error('not found');
    },
    diffFiles,
    workspace: '',
    runGit: async () => null,
    maxChars: 4000,
    maxFiles: 2,
    maxTotalChars: 200,
    ...overrides,
  });
}

test('read returns a numbered evidence block and slices around a symbol', async () => {
  const evidence = executor();
  const result = await evidence.execute(normalizeQuery({ op: 'read', path: 'src/a.js', symbol: 'writeCache' }));
  assert.equal(result.id, 'E1');
  assert.match(result.block, /^## E1 · read/);
  assert.match(result.block, /diff-only|workspace/);
  assert.match(result.block, /writeCache/);
  assert.match(result.block, /第 1–6 行（共 6 行）/);
});

test('a repeated query reuses the same evidence id', async () => {
  const evidence = executor();
  const query = normalizeQuery({ op: 'diff', path: 'src/a.js' });
  const first = await evidence.execute(query);
  const second = await evidence.execute(query);
  assert.equal(first.id, 'E1');
  assert.equal(second.id, 'E1');
  assert.equal(second.cached, true);
  assert.deepEqual(evidence.evidenceIds(), ['E1']);
});

test('find falls back to diff text when the workspace is unavailable', async () => {
  const evidence = executor();
  const result = await evidence.execute(normalizeQuery({ op: 'find', symbol: 'cacheMap' }));
  assert.equal(result.id, 'E1');
  assert.match(result.block, /diff-only/);
  assert.match(result.block, /src\/a\.js/);
  assert.match(result.block, /tests\/a\.test\.js/);
});

test('scope=tests keeps only test paths', async () => {
  const evidence = executor();
  const result = await evidence.execute(normalizeQuery({ op: 'tests', symbol: 'cacheMap' }));
  assert.match(result.block, /tests\/a\.test\.js/);
  assert.doesNotMatch(result.block, /src\/a\.js —/);
});

test('the file budget rejects further reads without consuming an evidence id', async () => {
  const evidence = executor();
  await evidence.execute(normalizeQuery({ op: 'read', path: 'src/a.js' }));
  await evidence.execute(normalizeQuery({ op: 'read', path: 'src/b.js' }));
  const rejected = await evidence.execute(normalizeQuery({ op: 'read', path: 'src/c.js' }));
  assert.equal(rejected.id, '');
  assert.match(rejected.block, /文件预算已用尽/);
  assert.deepEqual(evidence.evidenceIds(), ['E1', 'E2']);
});

test('an unreadable file becomes evidence text, not an exception', async () => {
  const evidence = executor();
  const result = await evidence.execute(normalizeQuery({ op: 'read', path: 'src/missing.js' }));
  assert.equal(result.id, 'E1');
  assert.match(result.block, /无法读取 src\/missing\.js/);
});

test('workspace search uses git grep and filters by scope', async () => {
  const calls = [];
  const evidence = executor({
    workspace: '/repo',
    diffFiles: new Map([['src/a.js', { text: 'const cacheMap = new Map();\n' }]]),
    runGit: async (cwd, args) => {
      calls.push(args);
      return 'src/a.js:2:const cacheMap = new Map();\ntests/a.test.js:1:import { cacheMap } from "../src/a.js";\n';
    },
  });
  const result = await evidence.execute(normalizeQuery({ op: 'find', symbol: 'cacheMap', scope: 'changed' }));
  assert.deepEqual(calls[0], ['grep', '-n', '-F', '-e', 'cacheMap']);
  assert.match(result.block, /workspace:changed/);
  assert.match(result.block, /src\/a\.js:2/);
  assert.doesNotMatch(result.block, /tests\/a\.test\.js/);
});

test('the total character budget truncates instead of growing without bound', async () => {
  const evidence = executor({ maxTotalChars: 10 });
  const result = await evidence.execute(normalizeQuery({ op: 'diff', path: 'src/a.js' }));
  assert.equal(result.id, 'E1');
  assert.match(result.block, /总预算已用尽/);
  const rejected = await evidence.execute(normalizeQuery({ op: 'diff', path: 'tests/a.test.js' }));
  assert.equal(rejected.id, '');
  assert.match(rejected.block, /字符预算已用尽/);
});

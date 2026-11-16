/**
 * Chunk-contract tests for the package-local split (#12).
 *
 * These are static checks on the shipped files: the entry must load exactly the chunks the
 * package ships, each chunk must register under the package id with its own file name, and
 * every name a chunk destructures from another area must be exported by that area. The
 * runtime composition is covered by tests/client.test.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chunkFiles, stampOf } from '../scripts/stamp.js';

const ROOT = new URL('..', import.meta.url);
const ENTRY = readFileSync(new URL('client.js', ROOT), 'utf8');
/** The Host's accepted chunk names (`client-modules/src/index.ts`, CLIENT_CHUNK). */
const HOST_CHUNK = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/;
const PACKAGE = '@modouai/dsh-pr-review';

function chunkText(file) {
  return readFileSync(new URL(file, ROOT), 'utf8');
}

/** The single composition table in the entry: area, file and the areas it depends on. */
function entryAreas() {
  const table = ENTRY.match(/const AREAS = \[([\s\S]*?)\n    \];/);
  assert.ok(table, 'client.js declares the AREAS table');
  return [...table[1].matchAll(/area: '([^']+)', file: '([^']+)', deps: \[([^\]]*)\]/g)]
    .map((match) => ({
      area: match[1],
      file: match[2],
      deps: [...match[3].matchAll(/'([^']+)'/g)].map((dep) => dep[1]),
    }));
}

/** Key names of the last `return { ... };` block, the chunk's export list. */
function exportsOf(text) {
  const blocks = [...text.matchAll(/return \{\n([\s\S]*?)\n\s*\};/g)];
  assert.ok(blocks.length > 0, 'chunk returns its exports');
  return blocks[blocks.length - 1][1]
    .split(',')
    .map((name) => name.trim())
    .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
}

test('the entry loads exactly the chunks the package ships', () => {
  const areas = entryAreas();
  assert.deepEqual(areas.map(({ file }) => file).sort(), [...chunkFiles()].sort());
  for (const { file } of areas) {
    assert.match(file, HOST_CHUNK, `${file} must match the Host chunk route`);
  }
});

test('every chunk registers itself under the package id and its own file name', () => {
  for (const file of chunkFiles()) {
    const text = chunkText(file);
    assert.ok(text.includes('window.__ModuleLoader__.load({'), `${file} registers through the loader`);
    assert.ok(text.includes(`id: '${PACKAGE}'`), `${file} registers under the package id`);
    assert.ok(text.includes(`chunk: '${file}'`), `${file} registers under its own file name`);
    assert.ok(text.includes('factory(require) {'), `${file} exports a factory`);
  }
});

test('composition dependencies point backwards and cover every area', () => {
  const areas = entryAreas();
  const position = new Map(areas.map(({ area }, index) => [area, index]));
  for (const [index, { area, file, deps }] of areas.entries()) {
    for (const dep of deps) {
      assert.ok(position.has(dep), `${file} depends on unknown area ${dep}`);
      assert.ok(position.get(dep) < index, `${file} depends on ${dep}, which composes later`);
    }
    assert.ok(area.length > 0, `${file} names its area`);
  }
});

test('every destructured dependency is exported by the chunk that produces it', () => {
  const areas = entryAreas();
  const exportsByArea = new Map(areas.map(({ area, file }) => [area, exportsOf(chunkText(file))]));
  for (const { file } of areas) {
    const text = chunkText(file);
    for (const match of text.matchAll(/const \{\n([\s\S]*?)\n\s*\} = (\w+);/g)) {
      const dep = match[2];
      const produced = exportsByArea.get(dep);
      if (produced === undefined) continue; // a hook result or props object, not an area
      const names = match[1].split(',').map((name) => name.trim()).filter(Boolean);
      for (const name of names) {
        assert.ok(produced.includes(name), `${file} destructures ${name} from ${dep}, which does not export it`);
      }
    }
  }
});

test('the stamp is independent of the working tree line endings', () => {
  const lf = stampOf(['client.core.js'], () => 'a\nb\n');
  const crlf = stampOf(['client.core.js'], () => 'a\r\nb\r\n');
  assert.equal(lf, crlf, 'a CRLF checkout must not produce a different stamp');
});

test('the entry stamp covers every shipped chunk', () => {
  const stamps = ENTRY.match(/^\/\/ pr-review chunks: [0-9a-f]{12}$/gm) ?? [];
  assert.equal(stamps.length, 1, 'client.js carries exactly one chunk stamp');
  assert.equal(stamps[0], `// pr-review chunks: ${stampOf()}`,
    'run `pnpm stamp` after editing a chunk and commit the entry');
});

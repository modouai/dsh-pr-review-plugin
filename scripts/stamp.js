#!/usr/bin/env node
/**
 * Keep the entry's revision honest.
 *
 * The Host derives a package's client revision from the entry file's metadata only
 * (`packages/client/modules/src/index.ts`, `artifactRevision`), and every chunk URL is
 * `/plugins/<pkg>/client.<area>.js?rev=<entry rev>`. A chunk-only edit would therefore keep
 * the old rev and let a cached chunk win, so this script folds the chunk contents into a
 * stamp comment inside `client.js`; changing any chunk rewrites the entry and changes its
 * revision.
 *
 * `node scripts/stamp.js`          rewrites the stamp when it is stale
 * `node scripts/stamp.js --check`  exits 1 when the stamp is stale
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(ROOT, 'client.js');
const CHUNK = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/;
const STAMP = /^\/\/ pr-review chunks: [0-9a-f]{12}$/m;

/** Chunk files beside the entry, in a stable order. */
export function chunkFiles() {
  return readdirSync(ROOT)
    .filter((name) => CHUNK.test(name) && name !== 'client.js' && !name.startsWith('client.node.'))
    .sort();
}

/** Content hash stamped into the entry. */
export function stampOf(files = chunkFiles()) {
  const hash = createHash('sha1');
  hash.update('pr-review-chunks\0');
  for (const file of files) {
    const body = readFileSync(join(ROOT, file));
    hash.update(`${file}\0${body.length}\0`);
    hash.update(body);
  }
  return hash.digest('hex').slice(0, 12);
}

// Resolve both sides so the guard also holds when argv[1] is a relative path or uses the
// other separator style (Windows).
if (process.argv[1] !== undefined
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const entry = readFileSync(ENTRY, 'utf8');
  const stamps = entry.match(new RegExp(STAMP.source, 'gm')) ?? [];
  if (stamps.length > 1) {
    console.error(`client.js has ${stamps.length} chunk stamp lines; keep exactly one`);
    process.exit(1);
  }
  const current = stamps[0];
  if (current === undefined) {
    console.error('client.js is missing the "// pr-review chunks: <hash>" stamp line');
    process.exit(1);
  }
  const files = chunkFiles();
  const expected = `// pr-review chunks: ${stampOf(files)}`;
  const covered = `chunks: ${files.join(', ')}`;
  if (process.argv.includes('--check')) {
    if (current !== expected) {
      console.error(`chunk stamp is stale (${current} -> ${expected}); run \`node scripts/stamp.js\` (${covered})`);
      process.exit(1);
    }
    console.log('chunk stamp matches');
  } else if (current !== expected) {
    writeFileSync(ENTRY, entry.replace(STAMP, () => expected));
    console.log(`stamped client.js with ${expected.slice('// pr-review chunks: '.length)} (${covered})`);
  } else {
    console.log('chunk stamp already current');
  }
}

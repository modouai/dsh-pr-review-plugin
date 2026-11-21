/**
 * Prompt loader contract: files ship with the package, every placeholder is strict, and
 * dynamic values may contain `{{` without tripping the template check.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { sep } from 'node:path';

import {
  FRAGMENT_NAMES,
  PROMPT_NAMES,
  fragment,
  loadPrompt,
  renderPrompt,
  renderTemplate,
} from '../prompts.js';

test('prompts: every prompt and fragment file loads and is non-empty', () => {
  for (const name of PROMPT_NAMES) assert.notEqual(loadPrompt(name).trim(), '', name);
  for (const name of FRAGMENT_NAMES) assert.notEqual(fragment(name).trim(), '', name);
});

test('prompts: renderPrompt fills placeholders and rejects missing values', () => {
  const text = renderPrompt('reviewer', { reviewFramework: 'FRAME', languageRule: 'LANG' });
  assert.match(text, /FRAME/);
  assert.match(text, /LANG/);
  assert.throws(
    () => renderPrompt('reviewer', { reviewFramework: 'FRAME' }),
    /Missing prompt value: reviewer#languageRule/,
  );
});

test('prompts: dynamic values containing braces do not trip the template check', () => {
  const text = renderPrompt('reviewer', { reviewFramework: '{{not-a-placeholder}}', languageRule: '' });
  assert.match(text, /\{\{not-a-placeholder\}\}/);
  assert.doesNotMatch(text, /\{\{languageRule\}\}/);
});

test('prompts: renderTemplate rejects malformed placeholders and nullish values', () => {
  assert.throws(
    () => renderTemplate('a {{ bad }} b', 'x', {}),
    /Malformed placeholder: x/,
  );
  assert.throws(
    () => renderTemplate('{{a}}', 'x', { a: undefined }),
    /Missing prompt value: x#a/,
  );
  assert.throws(
    () => renderTemplate('{{a}}', 'x', { a: null }),
    /Missing prompt value: x#a/,
  );
  assert.equal(renderTemplate('pre{{a}}post', 'x', { a: '' }), 'prepost');
});

test('prompts: every Markdown file on disk is covered by the test lists', () => {
  const root = new URL('../prompts/', import.meta.url);
  const files = readdirSync(root, { recursive: true })
    .map((file) => file.split(sep).join('/'))
    .filter((file) => file.endsWith('.md'));
  const top = files
    .filter((file) => !file.includes('/'))
    .map((file) => file.slice(0, -3))
    .sort();
  const fragments = files
    .filter((file) => file.startsWith('fragments/'))
    .map((file) => file.slice('fragments/'.length, -3))
    .sort();
  const stray = files
    .filter((file) => file.includes('/') && !file.startsWith('fragments/'))
    .sort();
  assert.deepEqual(top, [...PROMPT_NAMES].sort());
  assert.deepEqual(fragments, [...FRAGMENT_NAMES].sort());
  assert.deepEqual(stray, []);
});

test('prompts: package files ship prompts.js and the Markdown tree', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.files.includes('prompts.js'));
  assert.ok(pkg.files.includes('prompts/**/*.md'));
});

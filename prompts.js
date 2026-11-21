/**
 * Prompt loading and rendering.
 *
 * Every static prompt text lives in `prompts/*.md`. Builders pass the dynamic values and
 * this module substitutes them. A missing value — absent, `null`, or `undefined` — is an
 * error, not an empty string: a prompt that silently loses its diff or its candidates is
 * worse than a failed review. An explicit empty string is valid.
 *
 * All prompt and fragment files are read once at import time, so a missing file fails fast
 * instead of surfacing on the first request.
 */

import { readFileSync } from 'node:fs';

const cache = new Map();

function read(relativePath) {
  if (!cache.has(relativePath)) {
    cache.set(relativePath, readFileSync(new URL(relativePath, import.meta.url), 'utf8').trimEnd());
  }
  return cache.get(relativePath);
}

/** Prompt file stems; `reviewer` loads `prompts/reviewer.md`. */
export const PROMPT_NAMES = [
  'reviewer', 'reviewer-compact',
  'report', 'explain', 'chat', 'conclude', 'feedback',
  'investigate-step', 'refuter', 'refute',
  'review-data',
];

/** Shared fragment file stems; `language-zh` loads `prompts/fragments/language-zh.md`. */
export const FRAGMENT_NAMES = [
  'review-framework', 'previous-verdicts', 'investigation-protocol',
  'language-zh', 'language-en', 'language-compact-zh', 'language-compact-en',
  'chat-file-contract', 'chat-overview-contract',
];

/** Load one task/system prompt by file stem (`report` → `prompts/report.md`). */
export function loadPrompt(name) {
  return read(`./prompts/${name}.md`);
}

/** Load one shared fragment by file stem (`language-zh` → `prompts/fragments/language-zh.md`). */
export function fragment(name) {
  return read(`./prompts/fragments/${name}.md`);
}

// Read every shipped file now so a missing one fails at import time.
for (const name of PROMPT_NAMES) loadPrompt(name);
for (const name of FRAGMENT_NAMES) fragment(name);

const PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g;

/**
 * Fill `{{key}}` placeholders in `template`; a missing or nullish key throws, and a
 * leftover `{{` that is not a valid placeholder throws as malformed.
 */
export function renderTemplate(template, name, values) {
  const given = values !== null && typeof values === 'object' ? values : {};
  // Check the template, not the result: dynamic values may legitimately contain `{{`.
  if (template.replace(PLACEHOLDER, '').includes('{{')) {
    throw new Error(`Malformed placeholder: ${name}`);
  }
  return template.replace(PLACEHOLDER, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(given, key)) {
      throw new Error(`Missing prompt value: ${name}#${key}`);
    }
    const value = given[key];
    if (value === null || value === undefined) {
      throw new Error(`Missing prompt value: ${name}#${key}`);
    }
    return String(value);
  }).trimEnd();
}

/** Fill `{{key}}` placeholders in a named prompt; a missing value throws. */
export function renderPrompt(name, values) {
  return renderTemplate(loadPrompt(name), name, values);
}

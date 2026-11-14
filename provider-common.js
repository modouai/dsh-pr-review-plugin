/**
 * Helpers shared by the platform adapters.
 *
 * The adapters normalize very different APIs (GitHub, Gitea, GitLab, Gitee,
 * Codeup) into one shape; the pieces that do not depend on a platform live here.
 */

/** Pages of 100 changed files each; callers flag a full page as truncation. */
export const MAX_PAGES = 4;

/** Changed files fetched per pull request (100 per page). */
export const MAX_PULL_FILES = MAX_PAGES * 100;

/** Cap for one fetched file body; the browser half never needs more than this. */
export const MAX_FILE_CHARS = 400_000;

/** Encode one repository file path for contents endpoints (slashes stay). */
export function encodePath(filePath) {
  return String(filePath).split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

/** Truncate a fetched file body to the shared cap. */
export function truncateContent(text) {
  const value = String(text ?? '');
  const truncated = value.length > MAX_FILE_CHARS;
  return { content: truncated ? value.slice(0, MAX_FILE_CHARS) : value, truncated, size: value.length };
}

/** Count added/removed lines in one unified-diff body (the file headers are excluded). */
export function countDiffLines(patch) {
  let additions = 0;
  let deletions = 0;
  for (const line of String(patch ?? '').split(/\r?\n/)) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) additions += 1;
    else if (line.startsWith('-')) deletions += 1;
  }
  return { additions, deletions };
}

/**
 * Synthesize one unified diff text from per-file patches. GitLab, Gitee and
 * Codeup return file lists (not one diff blob); the review pipeline parses a
 * single unified diff, so the adapter rebuilds it here.
 * Each file: { path, previousPath, status: 'added'|'removed'|'renamed'|'modified', patch }.
 */
export function unifiedDiffFromFiles(files) {
  const parts = [];
  for (const file of Array.isArray(files) ? files : []) {
    const path = typeof file?.path === 'string' ? file.path : '';
    if (path === '') continue;
    const previous = typeof file.previousPath === 'string' && file.previousPath !== ''
      ? file.previousPath
      : path;
    const status = typeof file.status === 'string' ? file.status : 'modified';
    parts.push(`diff --git a/${previous} b/${path}`);
    parts.push(status === 'added' ? '--- /dev/null' : `--- a/${previous}`);
    parts.push(status === 'removed' ? '+++ /dev/null' : `+++ b/${path}`);
    if (typeof file.patch === 'string' && file.patch !== '') parts.push(file.patch);
  }
  return parts.length === 0 ? '' : `${parts.join('\n')}\n`;
}

/** Map a platform-specific file status to the shared vocabulary. */
export function normalizeFileStatus(value) {
  const status = String(value ?? '').toLowerCase();
  if (status === 'new_file' || status === 'added' || status === 'add' || status === 'new') return 'added';
  if (status === 'deleted_file' || status === 'deleted' || status === 'removed' || status === 'delete') return 'removed';
  if (status === 'renamed_file' || status === 'renamed' || status === 'rename') return 'renamed';
  return 'modified';
}

/**
 * Unified-diff parsing and entry-first ordering for the PR review plugin.
 *
 * Both supported hosts return standard `git diff` text, so one parser serves
 * them; ordering is a heuristic base that the model may refine.
 */

/** Split a unified diff into per-file records keyed by the new path. */
export function parseDiff(diffText) {
  const files = new Map();
  if (typeof diffText !== 'string' || diffText === '') return files;
  const marker = /^diff --git a\/(.+?) b\/(.+)$/gm;
  const starts = [];
  let match;
  while ((match = marker.exec(diffText)) !== null) {
    starts.push({ start: match.index, path: match[2] });
  }
  for (let index = 0; index < starts.length; index += 1) {
    const from = starts[index].start;
    const to = index + 1 < starts.length ? starts[index + 1].start : diffText.length;
    const text = diffText.slice(from, to);
    const filePath = starts[index].path;
    let additions = 0;
    let deletions = 0;
    let binary = false;
    let hunkCount = 0;
    for (const line of text.split('\n')) {
      if (line.startsWith('@@')) hunkCount += 1;
      else if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
      else if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
      else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) binary = true;
    }
    files.set(filePath, { path: filePath, additions, deletions, binary, hunkCount, text });
  }
  return files;
}

const ENTRY_HINTS = [
  [/^src\/main\/index\.ts$/, 120],
  [/\/preload\.(cts|ts)$/, 110],
  [/^src\/main\/agent-runtime\//, 90],
  [/^src\/main\/ipc\//, 80],
  [/(^|\/)(index|main)\.(ts|tsx)$/, 70],
  [/\/App\.(tsx|ts)$/, 60],
  [/(router|routes?|handlers?|controller|gateway|middleware)/, 50],
  [/(store|repository|service|model|schema)/, 40],
  [/^src\/shared\//, 30],
  [/^src\/renderer\//, 10],
  [/(__tests__|\.test\.|\.spec\.)/, -60],
  [/^docs\//, -80],
  [/\.(md|json|ya?ml|lock)$/, -70],
];

/** Heuristic entry-first order used as the base when the model cannot rank. */
export function heuristicOrder(diffFiles, extraFiles) {
  const names = new Set([...diffFiles.keys()]);
  for (const file of extraFiles) names.add(file.path);
  const allText = [...diffFiles.values()].map((file) => file.text).join('\n');
  const scored = [];
  for (const name of names) {
    let score = 0;
    for (const [pattern, weight] of ENTRY_HINTS) if (pattern.test(name)) score += weight;
    const base = name.replace(/\.[^.]+$/, '');
    const mentions = allText.split(base).length - 1;
    score += Math.min(mentions, 15);
    const diff = diffFiles.get(name);
    if (diff !== undefined) {
      score += Math.min(diff.additions + diff.deletions, 400) / 40;
      if (diff.binary) score -= 20;
      score += Math.min(diff.hunkCount, 20) / 10;
    }
    scored.push({ path: name, score });
  }
  scored.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  return scored.map((entry) => entry.path);
}

/** Compact per-file text for prompts, honouring a total character budget. */
export function diffExcerpts(diffFiles, order, maxCharsPerFile, totalBudget) {
  const parts = [];
  let budget = totalBudget;
  for (const filePath of order) {
    const diff = diffFiles.get(filePath);
    if (diff === undefined) continue;
    const text = diff.binary ? '(二进制文件，无文本 diff)' : diff.text.slice(0, maxCharsPerFile);
    if (budget - text.length < 0) break;
    budget -= text.length;
    parts.push(`### ${filePath} (+${diff.additions} / -${diff.deletions}，${diff.hunkCount} 个 hunk)\n${text}`);
  }
  return parts.join('\n\n');
}

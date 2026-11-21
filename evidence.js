/**
 * Host-side executor for investigation queries.
 *
 * One query resolves to one numbered evidence block. The executor owns the ledger — ids,
 * dedupe cache, per-file and character budgets — so the loop only decides when to stop.
 */

import { queryKey } from './investigation.js';

const TEST_PATH = /(^|\/)(tests?|__tests__)\//;

export function createEvidenceExecutor(options) {
  const readFile = options.readFile;
  const diffFiles = options.diffFiles instanceof Map ? options.diffFiles : new Map();
  const workspace = typeof options.workspace === 'string' ? options.workspace : '';
  const runGit = typeof options.runGit === 'function' ? options.runGit : async () => null;
  const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : 4000;
  const maxFiles = Number.isFinite(options.maxFiles) ? options.maxFiles : 12;
  const maxTotalChars = Number.isFinite(options.maxTotalChars) ? options.maxTotalChars : 24000;

  const cache = new Map();
  const ids = new Set();
  const files = new Set();
  let count = 0;
  let usedChars = 0;
  const degraded = workspace === '';

  function reject(message) {
    return { id: '', block: `## 查询未执行\n\n${message}`, rejected: message };
  }

  function render(id, query, scope, body) {
    const header = [`${id} · ${query.op}`];
    if (scope !== '') header.push(scope);
    if (query.path !== '') header.push(query.path);
    if (query.symbol !== '') header.push(`symbol=${query.symbol}`);
    if (query.pattern !== '') header.push(`pattern=${query.pattern}`);
    return `## ${header.join(' · ')}\n\n${body}`;
  }

  function sliceText(content, query) {
    const capped = content.length > 200_000 ? content.slice(0, 200_000) : content;
    const lines = capped.split('\n');
    const total = lines.length;
    const capNote = content.length > 200_000 ? '（文件超过 200 KB，已截断读取）' : '';
    if (query.startLine > 0 || query.endLine > 0) {
      const start = Math.max(0, (query.startLine > 0 ? query.startLine : 1) - 1);
      const end = Math.min(total, query.endLine > 0 ? query.endLine : start + 200);
      return { text: lines.slice(start, end).join('\n'), note: `第 ${start + 1}–${end} 行（共 ${total} 行）${capNote}` };
    }
    if (query.symbol !== '') {
      const at = capped.indexOf(query.symbol);
      if (at === -1) {
        const end = Math.min(total, 200);
        return { text: lines.slice(0, end).join('\n'), note: `未找到 ${query.symbol}，显示前 ${end} 行（共 ${total} 行）${capNote}` };
      }
      const lineIndex = capped.slice(0, at).split('\n').length - 1;
      const start = Math.max(0, lineIndex - 40);
      const end = Math.min(total, lineIndex + 41);
      return { text: lines.slice(start, end).join('\n'), note: `第 ${start + 1}–${end} 行（共 ${total} 行）${capNote}` };
    }
    const end = Math.min(total, 200);
    return { text: lines.slice(0, end).join('\n'), note: `${total > 200 ? `前 200 行（共 ${total} 行）${capNote}` : capNote}` };
  }

  function parseGitGrep(stdout, query) {
    const rows = [];
    for (const line of String(stdout).split('\n')) {
      if (line === '') continue;
      const first = line.indexOf(':');
      if (first === -1) continue;
      const filePath = line.slice(0, first);
      if (query.scope === 'changed' && !diffFiles.has(filePath)) continue;
      if (query.scope === 'tests' && !TEST_PATH.test(filePath)) continue;
      rows.push(line);
      if (rows.length >= query.limit) break;
    }
    return rows;
  }

  async function searchWorkspace(query) {
    const args = query.op === 'grep'
      ? ['grep', '-n', '-E', '-e', query.pattern, ...(query.pathGlob === '' ? [] : ['--', query.pathGlob])]
      : ['grep', '-n', '-F', '-e', query.symbol];
    const stdout = await runGit(workspace, args);
    return stdout === null ? null : parseGitGrep(stdout, query);
  }

  function searchDiff(query) {
    let matches = (line) => line.includes(query.symbol);
    if (query.op === 'grep') {
      const pattern = new RegExp(query.pattern);
      matches = (line) => pattern.test(line);
    }
    const rows = [];
    for (const [filePath, diff] of diffFiles) {
      if (query.scope === 'tests' && !TEST_PATH.test(filePath)) continue;
      if (typeof diff?.text !== 'string') continue;
      const lines = diff.text.split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        if (!matches(lines[index])) continue;
        rows.push(`${filePath} — diff 第 ${index + 1} 行：${lines[index].trim().slice(0, 200)}`);
        if (rows.length >= query.limit) return rows;
      }
    }
    return rows;
  }

  async function resolve(query) {
    if (query.op === 'diff') {
      const diff = diffFiles.get(query.path);
      if (diff?.text === undefined) return { text: `该文件不在本次 diff 中：${query.path}` };
      return { text: diff.text, note: '完整 diff' };
    }
    if (query.op === 'read') {
      try {
        const content = await readFile(query.path);
        return sliceText(String(content ?? ''), query);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { text: `无法读取 ${query.path}：${reason}` };
      }
    }
    const rows = workspace === '' ? searchDiff(query) : await searchWorkspace(query);
    if (rows === null) return { text: '工作区搜索失败（git 不可用），本次查询没有结果。' };
    if (rows.length === 0) return { text: '（未找到匹配）' };
    return { text: rows.join('\n') };
  }

  async function execute(query) {
    const key = queryKey(query);
    const cached = cache.get(key);
    if (cached !== undefined) return { ...cached, cached: true };
    if (query.op === 'read' && !files.has(query.path) && files.size >= maxFiles) {
      return reject(`文件预算已用尽（${maxFiles} 个），未读取 ${query.path}。请用已有证据收口。`);
    }
    if (usedChars >= maxTotalChars) {
      return reject(`证据字符预算已用尽（${maxTotalChars}），不再执行新查询。请用已有证据收口。`);
    }
    const resolved = await resolve(query);
    let body = String(resolved.text ?? '');
    let truncated = false;
    if (body.length > maxChars) {
      body = `${body.slice(0, maxChars)}\n…（已按单块上限截断）`;
      truncated = true;
    }
    const remaining = maxTotalChars - usedChars;
    if (body.length > remaining) {
      body = `${body.slice(0, remaining)}\n…（总预算已用尽）`;
      truncated = true;
    }
    if (query.op === 'read') files.add(query.path);
    count += 1;
    const id = `E${count}`;
    ids.add(id);
    usedChars += body.length;
    const source = degraded ? 'diff-only' : `workspace:${query.scope}`;
    const scope = [source, truncated ? '已截断' : '', resolved.note ?? ''].filter((part) => part !== '').join('；');
    const result = { id, block: render(id, query, scope, body) };
    cache.set(key, result);
    return result;
  }

  return {
    execute,
    evidenceIds: () => [...ids],
    summary: () => ({ count, chars: usedChars, files: files.size, degraded }),
  };
}

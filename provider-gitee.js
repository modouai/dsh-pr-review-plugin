/**
 * Gitee-family adapter: Gitee, GitCode and AtomGit.
 *
 * These hosts expose the same GitHub-shaped v5 API (`/api/v5`), and GitCode /
 * AtomGit share one backend, so one adapter serves all three. Differences from
 * GitHub: the token is an `access_token` query parameter (never put it in a
 * message), pull-request comments live under `/pulls/:n/comments`, and the
 * changed-file endpoint already returns line counts and per-file patches.
 */

import { createHttp } from './provider-http.js';
import {
  encodePath,
  MAX_PULL_FILES,
  normalizeFileStatus,
  truncateContent,
  unifiedDiffFromFiles,
} from './provider-common.js';

/** Web root for comment links: strip the API suffix and the `api.` prefix. */
function webRoot(baseUrl) {
  return String(baseUrl ?? '')
    .replace(/\/api\/v5\/?$/, '')
    .replace('://api.', '://');
}

/** Gitee-family counters arrive as numbers or numeric strings depending on host. */
function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function createGiteeClient(config, provider, token) {
  const rawBase = String(provider.baseUrl ?? '').replace(/\/+$/, '');
  // Accept a web root (`https://gitee.com`) as well as the full API root.
  const base = rawBase.endsWith('/api/v5') ? rawBase : `${rawBase}/api/v5`;
  const web = webRoot(base);
  const repo = provider.repo;
  const http = createHttp({
    platform: provider.platform,
    baseUrl: base,
    query: { access_token: token },
  });

  /** Patches of the last pullFiles() call, reused by pullDiff(). */
  let lastFiles = { number: null, files: [] };

  function mapPull(pull) {
    return {
      number: pull.number,
      title: pull.title ?? '',
      author: pull.user?.login ?? pull.user?.name ?? '',
      updatedAt: pull.updated_at ?? '',
      createdAt: pull.created_at ?? '',
      headRef: pull.head?.ref ?? '',
      headSha: pull.head?.sha ?? '',
      baseRef: pull.base?.ref ?? '',
      additions: pull.additions ?? 0,
      deletions: pull.deletions ?? 0,
      changedFiles: pull.changed_files ?? 0,
      url: pull.html_url ?? '',
      platform: provider.platform,
    };
  }

  async function listOpenPulls(signal) {
    const raw = await http.getJson(
      `/repos/${repo}/pulls?state=open&sort=updated&direction=desc&per_page=21`,
      signal,
    );
    return (Array.isArray(raw) ? raw : []).map(mapPull);
  }

  async function pullDetail(number, signal) {
    const pull = await http.getJson(`/repos/${repo}/pulls/${number}`, signal);
    return {
      number: pull.number,
      title: pull.title ?? '',
      body: pull.body ?? '',
      author: pull.user?.login ?? pull.user?.name ?? '',
      state: pull.state ?? 'open',
      merged: pull.state === 'merged'
        || (typeof pull.merged_at === 'string' && pull.merged_at !== ''),
      additions: pull.additions ?? 0,
      deletions: pull.deletions ?? 0,
      changedFiles: pull.changed_files ?? 0,
      headRef: pull.head?.ref ?? '',
      headSha: pull.head?.sha ?? '',
      baseRef: pull.base?.ref ?? '',
      baseSha: pull.base?.sha ?? '',
      url: pull.html_url ?? '',
      platform: provider.platform,
      repo: provider.repo,
    };
  }

  async function fetchFiles(number, signal) {
    const raw = await http.getJson(`/repos/${repo}/pulls/${number}/files?per_page=100`, signal);
    const files = (Array.isArray(raw) ? raw : []).slice(0, MAX_PULL_FILES).map((file) => {
      const patch = typeof file.patch === 'string' ? file.patch : '';
      const additions = toNumber(file.additions);
      const deletions = toNumber(file.deletions);
      return {
        path: file.filename ?? '',
        previousPath: '',
        status: normalizeFileStatus(file.status),
        additions,
        deletions,
        changes: additions + deletions,
        patch,
      };
    });
    lastFiles = { number, files };
    return files.map(({ patch, ...rest }) => rest);
  }

  async function pullFiles(number, signal) {
    return fetchFiles(number, signal);
  }

  async function pullDiff(number, signal) {
    const files = lastFiles.number === number ? lastFiles.files : await fetchFiles(number, signal);
    return unifiedDiffFromFiles(files);
  }

  async function pullCommits(number, signal) {
    const raw = await http.getJson(`/repos/${repo}/pulls/${number}/commits?per_page=100`, signal);
    return (Array.isArray(raw) ? raw : []).map((commit) => ({
      sha: commit.sha ?? '',
      message: String(commit.commit?.message ?? '').split('\n')[0],
      author: commit.commit?.author?.name ?? '',
    }));
  }

  async function createComment(number, body, signal) {
    const comment = await http.postJson(`/repos/${repo}/pulls/${number}/comments`, { body }, signal);
    const id = typeof comment?.id === 'number' ? comment.id : 0;
    const url = typeof comment?.html_url === 'string' && comment.html_url !== ''
      ? comment.html_url
      : `${web}/${repo}/pulls/${number}#note_${id}`;
    return { id, url };
  }

  async function pullFileContent(path, ref, signal) {
    const query = ref === undefined || ref === '' ? '' : `?ref=${encodeURIComponent(ref)}`;
    const payload = await http.getJson(`/repos/${repo}/contents/${encodePath(path)}${query}`, signal);
    if (Array.isArray(payload)) throw new Error(`${path} 是目录，不是文件`);
    if (typeof payload?.content !== 'string' || payload.encoding !== 'base64') {
      throw new Error(`${path} 没有可读取的文本内容（二进制或超过接口上限）`);
    }
    const buffer = Buffer.from(payload.content, 'base64');
    return { path, ...truncateContent(buffer.toString('utf8')) };
  }

  async function listIssueComments(number, signal) {
    const raw = await http.getJson(
      `/repos/${repo}/pulls/${number}/comments?per_page=100&page=1`,
      signal,
    );
    return (Array.isArray(raw) ? raw : []).map((comment) => ({
      id: typeof comment?.id === 'number' ? comment.id : 0,
      author: typeof comment?.user?.login === 'string'
        ? comment.user.login
        : (typeof comment?.user?.name === 'string' ? comment.user.name : ''),
      createdAt: typeof comment?.created_at === 'string' ? comment.created_at : '',
      body: typeof comment?.body === 'string' ? comment.body : '',
    }));
  }

  return { listOpenPulls, pullDetail, pullFiles, pullDiff, pullCommits, createComment, pullFileContent, listIssueComments };
}

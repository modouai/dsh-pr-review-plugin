/**
 * GitHub and Gitea/Forgejo adapters.
 *
 * - GitHub: REST API v3 (`https://api.github.com`), Bearer token.
 * - Gitea-compatible hosts (Gitea / Forgejo / Codeberg): REST under `/api/v1`,
 *   `token` authorization. Forgejo is a hard fork of Gitea and keeps the same API.
 *
 * Behavior is unchanged from the original single-file implementation; the file
 * was split out so more platforms can live next to it.
 */

import { encodePath, MAX_PAGES } from './provider-common.js';

const MAX_FILE_CHARS = 400_000;

/** Create one authenticated client for a GitHub or Gitea-compatible host. */
export function createGithubGiteaClient(config, provider, token) {
  const repo = provider.repo;
  const base = provider.baseUrl;

  function apiUrl(pathname) {
    return provider.platform === 'github'
      ? `${base}/repos/${repo}${pathname}`
      : `${base}/api/v1/repos/${repo}${pathname}`;
  }

  function headers(extra) {
    const result = {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      'user-agent': 'dsh-pr-review-plugin',
      ...extra,
    };
    // Forgejo accepts the same scheme but documents `token <value>`.
    if (provider.platform === 'forgejo') result.authorization = `token ${token}`;
    return result;
  }

  async function getJson(pathname, signal) {
    const response = await fetch(apiUrl(pathname), { headers: headers(), signal });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`${provider.platform} ${pathname} 失败：HTTP ${response.status} ${text.slice(0, 300)}`);
    }
    return response.json();
  }

  async function getText(pathname, extraHeaders, signal) {
    const response = await fetch(apiUrl(pathname), { headers: headers(extraHeaders), signal });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`${provider.platform} ${pathname} 失败：HTTP ${response.status} ${text.slice(0, 300)}`);
    }
    return response.text();
  }

  async function listOpenPulls(signal) {
    // One extra entry: the host slices to its list cap and uses the overflow as a
    // "there are older PRs" signal, without a second request.
    const raw = await getJson('/pulls?state=open&sort=updated&per_page=21', signal);
    return raw.map((pull) => ({
      number: pull.number,
      title: pull.title ?? '',
      author: pull.user?.login ?? '',
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
    }));
  }

  async function pullDetail(number, signal) {
    const pull = await getJson(`/pulls/${number}`, signal);
    return {
      number: pull.number,
      title: pull.title ?? '',
      body: pull.body ?? '',
      author: pull.user?.login ?? '',
      state: pull.state ?? 'open',
      merged: pull.merged === true,
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

  async function pullFiles(number, signal) {
    const files = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const raw = await getJson(`/pulls/${number}/files?per_page=100&page=${page}`, signal);
      if (!Array.isArray(raw) || raw.length === 0) break;
      for (const file of raw) {
        files.push({
          path: file.filename ?? '',
          previousPath: file.previous_filename ?? '',
          status: file.status ?? 'changed',
          additions: file.additions ?? 0,
          deletions: file.deletions ?? 0,
          changes: file.changes ?? 0,
        });
      }
      if (raw.length < 100) break;
    }
    return files;
  }

  async function pullDiff(number, signal) {
    if (provider.platform === 'github') {
      return getText(`/pulls/${number}`, { accept: 'application/vnd.github.v3.diff' }, signal);
    }
    return getText(`/pulls/${number}.diff`, {}, signal);
  }

  /** JSON body request for write endpoints (comments). */
  async function requestJson(method, pathname, payload, signal) {
    const response = await fetch(apiUrl(pathname), {
      method,
      headers: headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(payload),
      signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`${provider.platform} ${pathname} 失败：HTTP ${response.status} ${text.slice(0, 300)}`);
    }
    return response.json();
  }

  /** Human-facing fallback link for a comment when the API omits html_url. */
  function commentUrl(number, commentId) {
    const host = provider.platform === 'github'
      ? `https://github.com/${repo}`
      : `${base}/${repo}`;
    const pathname = provider.platform === 'github' ? `/pull/${number}` : `/pulls/${number}`;
    return `${host}${pathname}#issuecomment-${commentId}`;
  }

  /** Create one issue comment on the pull request and return its id and link. */
  async function createComment(number, body, signal) {
    const comment = await requestJson('POST', `/issues/${number}/comments`, { body }, signal);
    const id = typeof comment?.id === 'number' ? comment.id : 0;
    const url = typeof comment?.html_url === 'string' && comment.html_url !== ''
      ? comment.html_url
      : commentUrl(number, id);
    return { id, url };
  }

  /**
   * Full text of one file at a given ref (the PR head by default). Uses the
   * contents API on both platforms, which returns base64; large files are
   * truncated so the browser half never receives an unbounded payload.
   */
  async function pullFileContent(path, ref, signal) {
    const query = ref === undefined || ref === '' ? '' : `?ref=${encodeURIComponent(ref)}`;
    const payload = await getJson(`/contents/${encodePath(path)}${query}`, signal);
    if (Array.isArray(payload)) throw new Error(`${path} 是目录，不是文件`);
    if (typeof payload?.content !== 'string' || payload.encoding !== 'base64') {
      throw new Error(`${path} 没有可读取的文本内容（二进制或超过接口上限）`);
    }
    const buffer = Buffer.from(payload.content, 'base64');
    const text = buffer.toString('utf8');
    const truncated = text.length > MAX_FILE_CHARS;
    return {
      path,
      content: truncated ? text.slice(0, MAX_FILE_CHARS) : text,
      truncated,
      size: typeof payload.size === 'number' ? payload.size : buffer.length,
    };
  }

  /** Issue-style comments on the pull request, oldest first (our review comment lives here). */
  async function listIssueComments(number, signal) {
    const raw = await getJson(`/issues/${number}/comments?per_page=100`, signal);
    return (Array.isArray(raw) ? raw : []).map((comment) => ({
      id: typeof comment?.id === 'number' ? comment.id : 0,
      author: typeof comment?.user?.login === 'string' ? comment.user.login : '',
      createdAt: typeof comment?.created_at === 'string' ? comment.created_at : '',
      body: typeof comment?.body === 'string' ? comment.body : '',
    }));
  }

  async function pullCommits(number, signal) {
    const raw = await getJson(`/pulls/${number}/commits?per_page=100`, signal);
    return raw.map((commit) => ({
      sha: commit.sha ?? '',
      message: String(commit.commit?.message ?? '').split('\n')[0],
      author: commit.commit?.author?.name ?? '',
    }));
  }

  return { listOpenPulls, pullDetail, pullFiles, pullDiff, pullCommits, createComment, pullFileContent, listIssueComments };
}

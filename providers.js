/**
 * Platform adapters for the PR review plugin.
 *
 * Two hosts are supported behind one shape:
 * - Forgejo (self-hosted, REST under /api/v1, tea CLI login as token fallback)
 * - GitHub (API v3, gh CLI login as token fallback)
 *
 * Callers only see the normalized pull records produced here.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const PLATFORMS = new Set(['forgejo', 'github']);

/** Normalize user config into one effective provider description. */
export function resolveProviderConfig(config) {
  const platform = PLATFORMS.has(config.platform) ? config.platform : 'forgejo';
  const rawBase = typeof config.baseUrl === 'string' && config.baseUrl.trim() !== ''
    ? config.baseUrl.trim().replace(/\/+$/, '')
    : platform === 'github'
      ? 'https://api.github.com'
      : '';
  const repo = typeof config.repo === 'string' ? config.repo.trim() : '';
  return {
    platform,
    baseUrl: rawBase,
    repo,
    label: platform === 'github' ? `GitHub ${repo}` : `Forgejo ${repo}`,
  };
}

/** Parse the token for a host out of the tea CLI config file. */
function tokenFromTeaConfig(text, host) {
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- name:')) {
      if (current !== null && current.url.includes(host) && current.token !== '') return current.token;
      current = { url: '', token: '' };
      continue;
    }
    if (current === null) continue;
    if (trimmed.startsWith('url:')) current.url = trimmed.slice(4).trim().replace(/^["']|["']$/g, '');
    else if (trimmed.startsWith('token:')) current.token = trimmed.slice(6).trim().replace(/^["']|["']$/g, '');
  }
  if (current !== null && current.url.includes(host) && current.token !== '') return current.token;
  return null;
}

/** The owner segment of an `owner/name` repository slug. */
function repoOwner(repo) {
  const slash = repo.indexOf('/');
  return slash === -1 ? '' : repo.slice(0, slash);
}

/** Parse a GitHub token out of the gh CLI hosts file for one host. */
function tokenFromGhHosts(text, host) {
  let currentHost = '';
  for (const line of text.split(/\r?\n/)) {
    if (line === '') continue;
    if (!line.startsWith(' ') && line.endsWith(':')) {
      currentHost = line.slice(0, -1).trim();
      continue;
    }
    if (currentHost !== host) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith('oauth_token:')) return trimmed.slice('oauth_token:'.length).trim();
    if (trimmed.startsWith('token:')) return trimmed.slice('token:'.length).trim();
  }
  return null;
}

/** Ask the gh CLI for a token, preferring the login of the repository owner. */
async function ghCliToken(apiHost, owner) {
  const host = apiHost.startsWith('api.') ? apiHost.slice(4) : apiHost;
  const attempts = [];
  if (owner !== '') attempts.push(['auth', 'token', '--hostname', host, '--user', owner]);
  attempts.push(['auth', 'token', '--hostname', host]);
  attempts.push(['auth', 'token']);
  for (const args of attempts) {
    try {
      const { stdout } = await execFileAsync('gh', args, { timeout: 8000, env: process.env });
      const token = stdout.trim();
      if (token !== '') return token;
    } catch {
      // gh absent, logged out, or without that user: try the next attempt.
    }
  }
  return null;
}

/** Resolve a token: explicit config, then platform env vars, then the CLI login of that platform. */
export async function resolveToken(config, provider) {
  if (typeof config.token === 'string' && config.token.trim() !== '') return config.token.trim();
  const envNames = provider.platform === 'github'
    ? ['GITHUB_TOKEN', 'GH_TOKEN']
    : ['FORGEJO_TOKEN', 'PR_REVIEW_TOKEN'];
  for (const name of envNames) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  const host = new URL(provider.baseUrl).host;
  try {
    if (provider.platform === 'github') {
      try {
        const text = await readFile(path.join(homedir(), '.config', 'gh', 'hosts.yml'), 'utf8');
        const token = tokenFromGhHosts(text, host);
        if (token !== null) return token;
      } catch {
        // hosts.yml absent: fall through to the CLI token.
      }
      return ghCliToken(host, repoOwner(provider.repo));
    }
    const teaPath = process.platform === 'darwin'
      ? path.join(homedir(), 'Library', 'Application Support', 'tea', 'config.yml')
      : path.join(homedir(), '.config', 'tea', 'config.yml');
    const text = await readFile(teaPath, 'utf8');
    return tokenFromTeaConfig(text, host);
  } catch {
    // No CLI login on this machine: the caller reports the missing token instead.
    return null;
  }
}

const MAX_PAGES = 4;

/** Changed files fetched per pull request (100 per page); callers flag a full page. */
export const MAX_PULL_FILES = MAX_PAGES * 100;

/** Encode one repository file path for the contents endpoint (slashes stay). */
function encodePath(path) {
  return String(path).split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

/** Create one authenticated client for the configured provider. */
export function createClient(config, provider, token) {
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
    const limit = 400_000;
    const truncated = text.length > limit;
    return {
      path,
      content: truncated ? text.slice(0, limit) : text,
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

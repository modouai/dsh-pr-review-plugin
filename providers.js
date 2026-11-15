/**
 * Platform dispatch for the PR review plugin.
 *
 * One normalized provider description feeds one of the adapters:
 * - GitHub (REST v3)
 * - Gitea-compatible hosts: Gitea / Forgejo / Codeberg (`/api/v1`)
 * - GitLab (REST v4)
 * - Gitee-family: Gitee / GitCode / AtomGit (`/api/v5`, GitHub-shaped)
 * - Alibaba Cloud Codeup (云效 OpenAPI)
 *
 * Callers only see the normalized pull records produced by the adapters.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { MAX_PULL_FILES } from './provider-common.js';
import { createGithubGiteaClient } from './provider-github-gitea.js';
import { createGitLabClient } from './provider-gitlab.js';
import { createGiteeClient } from './provider-gitee.js';
import { createCodeupClient } from './provider-codeup.js';

const execFileAsync = promisify(execFile);

export { MAX_PULL_FILES };

/** Accepted `platform` values; `gitea` is an alias of `forgejo`. */
const PLATFORMS = new Set(['github', 'gitea', 'forgejo', 'gitlab', 'gitee', 'gitcode', 'atomgit', 'codeup']);

/** Default API base per platform (empty means "resolve from the workspace origin"). */
const PLATFORM_DEFAULTS = {
  github: { baseUrl: 'https://api.github.com', label: 'GitHub' },
  forgejo: { baseUrl: '', label: 'Gitea/Forgejo' },
  gitlab: { baseUrl: 'https://gitlab.com', label: 'GitLab' },
  gitee: { baseUrl: 'https://gitee.com/api/v5', label: 'Gitee' },
  gitcode: { baseUrl: 'https://api.gitcode.com/api/v5', label: 'GitCode' },
  atomgit: { baseUrl: 'https://api.atomgit.com/api/v5', label: 'AtomGit' },
  codeup: { baseUrl: 'https://openapi-rdc.aliyuncs.com', label: 'Codeup' },
};

/** Normalize user config into one effective provider description. */
export function resolveProviderConfig(config) {
  const configured = PLATFORMS.has(config.platform) ? config.platform : 'forgejo';
  // `gitea` is an alias: keep the historical `forgejo` slug so per-platform
  // caches written before the alias existed stay readable.
  const platform = configured === 'gitea' ? 'forgejo' : configured;
  const defaults = PLATFORM_DEFAULTS[platform];
  const rawBase = typeof config.baseUrl === 'string' && config.baseUrl.trim() !== ''
    ? config.baseUrl.trim().replace(/\/+$/, '')
    : defaults.baseUrl;
  const repo = typeof config.repo === 'string' ? config.repo.trim() : '';
  const provider = {
    platform,
    baseUrl: rawBase,
    repo,
    label: `${defaults.label} ${repo}`.trim(),
  };
  if (platform === 'codeup') {
    // Codeup needs the organization (first origin segment) and the repository path;
    // both can be overridden in config. A three-segment remote (`org/group/repo`)
    // always carries its origin organization in the first segment.
    let organizationId = typeof config.organizationId === 'string' ? config.organizationId.trim() : '';
    const segments = repo.split('/');
    let repoPath = repo;
    if (segments.length >= 3) {
      const originOrganization = segments[0];
      repoPath = segments.slice(1).join('/');
      if (organizationId === '') organizationId = originOrganization;
    } else if (segments.length === 2 && organizationId === '') {
      organizationId = segments[0];
      repoPath = segments[1];
    }
    provider.organizationId = organizationId;
    provider.repoPath = repoPath;
    provider.projectId = typeof config.projectId === 'string' ? config.projectId.trim() : '';
  }
  return provider;
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

/**
 * gh CLI locations tried in order. A desktop app launches with the minimal
 * `/usr/bin:/bin:/usr/sbin:/sbin` PATH, so a Homebrew or user-local install is
 * invisible to a plain `execFile('gh')`.
 */
export const GH_BINARIES = Object.freeze([
  'gh',
  '/opt/homebrew/bin/gh',
  '/usr/local/bin/gh',
  '/usr/bin/gh',
]);

/** Ask the gh CLI for a token, preferring the login of the repository owner. */
async function ghCliToken(apiHost, owner) {
  const host = apiHost.startsWith('api.') ? apiHost.slice(4) : apiHost;
  const attempts = [];
  if (owner !== '') attempts.push(['auth', 'token', '--hostname', host, '--user', owner]);
  attempts.push(['auth', 'token', '--hostname', host]);
  attempts.push(['auth', 'token']);
  for (const binary of GH_BINARIES) {
    for (const args of attempts) {
      try {
        const { stdout } = await execFileAsync(binary, args, { timeout: 8000, env: process.env });
        const token = stdout.trim();
        if (token !== '') return token;
      } catch {
        // Binary absent, logged out, or without that user: try the next binary/attempt.
      }
    }
  }
  return null;
}

/** Environment variables tried per platform, in order. */
const ENV_TOKENS = {
  github: ['GITHUB_TOKEN', 'GH_TOKEN'],
  forgejo: ['GITEA_TOKEN', 'FORGEJO_TOKEN', 'PR_REVIEW_TOKEN'],
  gitlab: ['GITLAB_TOKEN', 'PR_REVIEW_TOKEN'],
  gitee: ['GITEE_TOKEN', 'PR_REVIEW_TOKEN'],
  gitcode: ['GITCODE_TOKEN', 'GITEE_TOKEN', 'PR_REVIEW_TOKEN'],
  atomgit: ['ATOMGIT_TOKEN', 'GITEE_TOKEN', 'PR_REVIEW_TOKEN'],
  codeup: ['CODEUP_TOKEN', 'YUNXIAO_TOKEN', 'PR_REVIEW_TOKEN'],
};

/** Resolve a token: explicit config, then platform env vars, then the CLI login of that platform. */
export async function resolveToken(config, provider) {
  if (typeof config.token === 'string' && config.token.trim() !== '') return config.token.trim();
  for (const name of ENV_TOKENS[provider.platform] ?? []) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  if (provider.platform !== 'github' && provider.platform !== 'forgejo') return null;
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

/** Create one authenticated client for the configured provider. */
export function createClient(config, provider, token) {
  switch (provider.platform) {
    case 'github':
    case 'forgejo':
      return createGithubGiteaClient(config, provider, token);
    case 'gitlab':
      return createGitLabClient(config, provider, token);
    case 'gitee':
    case 'gitcode':
    case 'atomgit':
      return createGiteeClient(config, provider, token);
    case 'codeup':
      return createCodeupClient(config, provider, token);
    default:
      throw new Error(`不支持的平台：${provider.platform}`);
  }
}

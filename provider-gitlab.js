/**
 * GitLab adapter (REST API v4).
 *
 * Project identity is the URL-encoded `namespace/project` path, so forks and
 * subgroups work without a numeric id. GitLab's diffs endpoint returns file
 * entries with a bare hunk body and no line counts: the adapter counts lines and
 * rebuilds one unified diff so the shared review pipeline can parse it.
 */

import { createHttp } from './provider-http.js';
import {
  countDiffLines,
  MAX_PAGES,
  MAX_PULL_FILES,
  normalizeFileStatus,
  truncateContent,
  unifiedDiffFromFiles,
} from './provider-common.js';

export function createGitLabClient(config, provider, token) {
  const base = String(provider.baseUrl ?? '').replace(/\/+$/, '');
  const apiBase = base.endsWith('/api/v4') ? base : `${base}/api/v4`;
  const project = encodeURIComponent(provider.repo);
  const http = createHttp({ platform: 'gitlab', baseUrl: apiBase, headers: { 'PRIVATE-TOKEN': token } });

  /** Patches of the last pullFiles() call, reused by pullDiff(). */
  let lastFiles = { number: null, files: [] };

  function mapPull(pull) {
    return {
      number: pull.iid,
      title: pull.title ?? '',
      author: pull.author?.username ?? '',
      updatedAt: pull.updated_at ?? '',
      createdAt: pull.created_at ?? '',
      headRef: pull.source_branch ?? '',
      headSha: pull.diff_refs?.head_sha ?? pull.sha ?? '',
      baseRef: pull.target_branch ?? '',
      additions: 0,
      deletions: 0,
      changedFiles: Number(pull.changes_count) || 0,
      url: pull.web_url ?? '',
      platform: 'gitlab',
    };
  }

  async function listOpenPulls(signal) {
    const raw = await http.getJson(
      `/projects/${project}/merge_requests?state=opened&order_by=updated_at&sort=desc&per_page=21`,
      signal,
    );
    return (Array.isArray(raw) ? raw : []).map(mapPull);
  }

  async function pullDetail(number, signal) {
    const pull = await http.getJson(`/projects/${project}/merge_requests/${number}`, signal);
    return {
      number: pull.iid,
      title: pull.title ?? '',
      body: pull.description ?? '',
      author: pull.author?.username ?? '',
      state: pull.state ?? 'opened',
      merged: pull.state === 'merged',
      additions: 0,
      deletions: 0,
      changedFiles: Number(pull.changes_count) || 0,
      headRef: pull.source_branch ?? '',
      headSha: pull.diff_refs?.head_sha ?? pull.sha ?? '',
      baseRef: pull.target_branch ?? '',
      baseSha: pull.diff_refs?.base_sha ?? '',
      url: pull.web_url ?? '',
      platform: 'gitlab',
      repo: provider.repo,
    };
  }

  async function fetchFiles(number, signal) {
    const files = [];
    const limit = Math.ceil(MAX_PULL_FILES / 100);
    for (let page = 1; page <= Math.min(MAX_PAGES, limit); page += 1) {
      const raw = await http.getJson(
        `/projects/${project}/merge_requests/${number}/diffs?per_page=100&page=${page}`,
        signal,
      );
      if (!Array.isArray(raw) || raw.length === 0) break;
      for (const file of raw) {
        const patch = typeof file.diff === 'string' ? file.diff : '';
        const { additions, deletions } = countDiffLines(patch);
        files.push({
          path: file.new_path ?? file.old_path ?? '',
          previousPath: file.renamed_file === true ? (file.old_path ?? '') : '',
          status: normalizeFileStatus(
            file.new_file === true ? 'added' : file.deleted_file === true ? 'removed' : file.renamed_file === true ? 'renamed' : 'modified',
          ),
          additions,
          deletions,
          changes: additions + deletions,
          patch,
        });
      }
      if (raw.length < 100) break;
    }
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
    const raw = await http.getJson(`/projects/${project}/merge_requests/${number}/commits?per_page=100`, signal);
    return (Array.isArray(raw) ? raw : []).map((commit) => ({
      sha: commit.id ?? '',
      message: String(commit.title ?? commit.message ?? '').split('\n')[0],
      author: commit.author_name ?? '',
    }));
  }

  async function createComment(number, body, signal) {
    const comment = await http.postJson(`/projects/${project}/merge_requests/${number}/notes`, { body }, signal);
    const id = typeof comment?.id === 'number' ? comment.id : 0;
    const url = typeof comment?.web_url === 'string' && comment.web_url !== ''
      ? comment.web_url
      : `${base}/${provider.repo}/-/merge_requests/${number}#note_${id}`;
    return { id, url };
  }

  async function pullFileContent(path, ref, signal) {
    const query = ref === undefined || ref === '' ? '' : `?ref=${encodeURIComponent(ref)}`;
    // GitLab wants the whole file path encoded as one segment (%2F included).
    const text = await http.getText(
      `/projects/${project}/repository/files/${encodeURIComponent(path)}/raw${query}`,
      'text/plain',
      signal,
    );
    return { path, ...truncateContent(text) };
  }

  async function listIssueComments(number, signal) {
    const raw = await http.getJson(
      `/projects/${project}/merge_requests/${number}/notes?per_page=100&sort=asc&order_by=created_at`,
      signal,
    );
    return (Array.isArray(raw) ? raw : [])
      .filter((note) => note?.system !== true)
      .map((note) => ({
        id: typeof note?.id === 'number' ? note.id : 0,
        author: typeof note?.author?.username === 'string' ? note.author.username : '',
        createdAt: typeof note?.created_at === 'string' ? note.created_at : '',
        body: typeof note?.body === 'string' ? note.body : '',
      }));
  }

  return { listOpenPulls, pullDetail, pullFiles, pullDiff, pullCommits, createComment, pullFileContent, listIssueComments };
}

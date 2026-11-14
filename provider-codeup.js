/**
 * Alibaba Cloud Codeup (云效代码管理) adapter.
 *
 * Codeup keeps two API generations side by side:
 * - legacy OpenAPI under `/repository/...` with `accessToken` as a query parameter
 *   (used here only to map a repository path to its numeric `projectId`);
 * - a GitLab-shaped `/api/v4/projects/...` surface with `x-yunxiao-token`.
 * Every response is wrapped in `{ success, errorCode, errorMessage, result }`.
 * A merge request is versioned by patch sets; posting a comment must carry the
 * current `patchSetBizId`, so the adapter resolves the latest patch set first.
 */

import { HarnessError } from '@deepseek-ai/dsh-llm';

import { createHttp } from './provider-http.js';
import {
  countDiffLines,
  MAX_PULL_FILES,
  normalizeFileStatus,
  truncateContent,
  unifiedDiffFromFiles,
} from './provider-common.js';

export function createCodeupClient(config, provider, token) {
  const base = String(provider.baseUrl ?? '').replace(/\/+$/, '');
  const organizationId = provider.organizationId ?? '';
  const repoPath = provider.repoPath ?? provider.repo;
  const http = createHttp({
    platform: 'codeup',
    baseUrl: base,
    headers: { 'x-yunxiao-token': token },
  });

  let projectIdPromise = provider.projectId === undefined || provider.projectId === ''
    ? null
    : Promise.resolve(provider.projectId);
  let lastFiles = { number: null, files: [] };
  let lastPatchSet = { number: null, patchSet: null };

  /** Unwrap the Codeup response envelope; failures keep the platform error code. */
  function unwrap(pathname, payload) {
    if (payload !== null && typeof payload === 'object' && payload.success === true) return payload.result;
    const code = typeof payload?.errorCode === 'string' && payload.errorCode !== ''
      ? payload.errorCode
      : 'CODEUP_API_ERROR';
    const message = typeof payload?.errorMessage === 'string' && payload.errorMessage !== ''
      ? payload.errorMessage
      : `${pathname} 调用失败`;
    throw new HarnessError(`codeup ${pathname}: ${message}`, code);
  }

  async function requestJson(pathname, signal) {
    return unwrap(pathname, await http.getJson(pathname, signal));
  }

  async function resolveProjectId(signal) {
    if (projectIdPromise === null) {
      projectIdPromise = (async () => {
        const query = new URLSearchParams({
          organizationId,
          identity: repoPath,
          accessToken: token,
        });
        const result = await requestJson(`/repository/get?${query.toString()}`, signal);
        const id = result?.id ?? result?.repositoryId;
        if (id === undefined || id === null || id === '') {
          throw new HarnessError('codeup: 无法解析 repositoryId，请在插件配置里填写 projectId', 'INVALID_ARGS');
        }
        return id;
      })();
    }
    return projectIdPromise;
  }

  function projectQuery(extra = {}) {
    const params = new URLSearchParams({ organizationId, ...extra });
    return params.toString();
  }

  /** Pick the newest patch set from the list, tolerating version field names. */
  function newestPatchSet(list) {
    const entries = Array.isArray(list) ? [...list] : [];
    if (entries.length === 0) return null;
    entries.sort((left, right) => {
      const leftVersion = Number(left?.patchSetVersion ?? left?.version ?? left?.patchSetBizId ?? 0);
      const rightVersion = Number(right?.patchSetVersion ?? right?.version ?? right?.patchSetBizId ?? 0);
      if (Number.isFinite(leftVersion) && Number.isFinite(rightVersion) && leftVersion !== rightVersion) {
        return leftVersion - rightVersion;
      }
      return 0;
    });
    return entries[entries.length - 1];
  }

  function patchSetIdOf(patchSet) {
    return patchSet?.patchSetBizId ?? patchSet?.patchsetBizId ?? patchSet?.bizId ?? patchSet?.id ?? '';
  }

  function patchSetShaOf(patchSet) {
    return patchSet?.commitSha ?? patchSet?.headSha ?? patchSet?.sourceCommitSha ?? patchSet?.sha ?? '';
  }

  async function latestPatchSet(number, signal) {
    if (lastPatchSet.number === number && lastPatchSet.patchSet !== null) return lastPatchSet.patchSet;
    const projectId = await resolveProjectId(signal);
    const query = new URLSearchParams({
      organizationId,
      projectId: String(projectId),
      localId: String(number),
    });
    const result = await requestJson(`/api/v4/projects/merge_requests/diffs/list_patchsets?${query.toString()}`, signal);
    const patchSet = newestPatchSet(result);
    if (patchSet === null) {
      throw new HarnessError(`codeup: 合并请求 #${number} 没有可用的版本（patch set）`, 'NOT_FOUND');
    }
    lastPatchSet = { number, patchSet };
    return patchSet;
  }

  function mapPull(pull) {
    return {
      number: pull.localId,
      title: pull.title ?? '',
      author: pull.author?.name ?? pull.author?.username ?? '',
      updatedAt: pull.updateTime ?? '',
      createdAt: pull.createTime ?? '',
      headRef: pull.sourceBranch ?? '',
      headSha: pull.sourceCommitSha ?? pull.headSha ?? pull.commitSha ?? '',
      baseRef: pull.targetBranch ?? '',
      additions: pull.additions ?? 0,
      deletions: pull.deletions ?? 0,
      changedFiles: pull.changedFiles ?? 0,
      url: pull.webUrl ?? '',
      platform: 'codeup',
    };
  }

  async function listOpenPulls(signal) {
    const projectId = await resolveProjectId(signal);
    const query = projectQuery({
      projectIds: String(projectId),
      state: 'opened',
      orderBy: 'updated_at',
      pageSize: '21',
      page: '1',
    });
    const result = await requestJson(`/api/v4/projects/merge_requests/advanced_search?${query}`, signal);
    const list = Array.isArray(result)
      ? result
      : (result?.list ?? result?.items ?? result?.result ?? []);
    return (Array.isArray(list) ? list : []).map(mapPull);
  }

  async function pullDetail(number, signal) {
    const projectId = await resolveProjectId(signal);
    const query = projectQuery();
    const result = await requestJson(
      `/api/v4/projects/${projectId}/merge_requests/${number}/detail?${query}`,
      signal,
    );
    let headSha = result?.sourceCommitSha ?? result?.headSha ?? result?.commitSha ?? '';
    if (headSha === '') {
      try {
        headSha = patchSetShaOf(await latestPatchSet(number, signal));
      } catch {
        // No patch set readable: auto-review will not trigger, but the panel still opens.
      }
    }
    return {
      number: result?.localId ?? number,
      title: result?.title ?? '',
      body: result?.description ?? '',
      author: result?.author?.name ?? result?.author?.username ?? '',
      state: result?.status ?? 'opened',
      merged: String(result?.status ?? '').toUpperCase() === 'MERGED',
      additions: result?.additions ?? 0,
      deletions: result?.deletions ?? 0,
      changedFiles: result?.changedFiles ?? 0,
      headRef: result?.sourceBranch ?? '',
      headSha,
      baseRef: result?.targetBranch ?? '',
      baseSha: result?.targetCommitSha ?? '',
      url: result?.webUrl ?? '',
      platform: 'codeup',
      repo: provider.repo,
    };
  }

  function normalizeTree(result) {
    if (Array.isArray(result)) return result;
    for (const key of ['changedFiles', 'changeTree', 'list', 'files', 'items']) {
      if (Array.isArray(result?.[key])) return result[key];
    }
    return [];
  }

  async function fetchFiles(number, signal) {
    const projectId = await resolveProjectId(signal);
    const query = new URLSearchParams({
      organizationId,
      projectId: String(projectId),
      localId: String(number),
    });
    const result = await requestJson(`/api/v4/projects/merge_requests/diffs/change_tree?${query.toString()}`, signal);
    const files = normalizeTree(result).slice(0, MAX_PULL_FILES).map((item) => {
      const patch = typeof item?.patch === 'string' ? item.patch : (typeof item?.diff === 'string' ? item.diff : '');
      const counted = countDiffLines(patch);
      return {
        path: item?.path ?? item?.newPath ?? item?.filePath ?? '',
        previousPath: item?.oldPath ?? '',
        status: normalizeFileStatus(item?.status ?? item?.changeType),
        additions: typeof item?.additions === 'number' ? item.additions : counted.additions,
        deletions: typeof item?.deletions === 'number' ? item.deletions : counted.deletions,
        changes: (typeof item?.additions === 'number' ? item.additions : counted.additions)
          + (typeof item?.deletions === 'number' ? item.deletions : counted.deletions),
        patch,
      };
    }).filter((file) => file.path !== '');
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

  async function pullCommits() {
    // Codeup documents no per-request commit list for our flow; the review never reads it.
    return [];
  }

  async function pullFileContent(path, ref, signal) {
    const projectId = await resolveProjectId(signal);
    const query = new URLSearchParams({ organizationId, path, ref: ref ?? '' });
    const result = await requestJson(`/repository/${projectId}/files/blobs?${query.toString()}`, signal);
    if (typeof result === 'string') return { path, ...truncateContent(result) };
    if (typeof result?.content === 'string') {
      const text = result.encoding === 'base64'
        ? Buffer.from(result.content, 'base64').toString('utf8')
        : result.content;
      return { path, ...truncateContent(text) };
    }
    throw new Error(`codeup: ${path} 没有可读取的文本内容`);
  }

  function normalizeComments(result) {
    if (Array.isArray(result)) return result;
    for (const key of ['list', 'comments', 'items']) {
      if (Array.isArray(result?.[key])) return result[key];
    }
    return [];
  }

  async function listIssueComments(number, signal) {
    const projectId = await resolveProjectId(signal);
    const result = await http.postJson(
      '/api/v4/projects/merge_requests/comments/list_comments',
      { organizationId, projectId, localId: number, page: 1, pageSize: 100 },
      signal,
    );
    const payload = unwrap('comments/list_comments', result);
    return normalizeComments(payload).map((comment) => ({
      id: comment?.commentBizId ?? comment?.id ?? 0,
      author: comment?.author?.name ?? comment?.author?.username ?? '',
      createdAt: comment?.createTime ?? comment?.createdAt ?? '',
      body: comment?.content ?? comment?.body ?? '',
    }));
  }

  async function createComment(number, body, signal) {
    const projectId = await resolveProjectId(signal);
    const patchSet = await latestPatchSet(number, signal);
    const patchSetBizId = patchSetIdOf(patchSet);
    if (patchSetBizId === '') {
      throw new HarnessError(`codeup: 合并请求 #${number} 取不到 patchSetBizId，无法发布评论`, 'NOT_FOUND');
    }
    const result = await http.postJson(
      '/api/v4/projects/code_reviews/comments/create_comment',
      {
        organizationId,
        projectId,
        localId: number,
        patchSetBizId,
        commentType: 'GLOBAL_COMMENT',
        content: body,
        draft: false,
        resolved: false,
      },
      signal,
    );
    const payload = unwrap('comments/create_comment', result);
    const id = payload?.commentBizId ?? payload?.id ?? 0;
    const url = typeof payload?.webUrl === 'string' ? payload.webUrl : '';
    return { id, url };
  }

  return { listOpenPulls, pullDetail, pullFiles, pullDiff, pullCommits, createComment, pullFileContent, listIssueComments };
}

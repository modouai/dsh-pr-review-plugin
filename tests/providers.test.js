/**
 * Platform adapter tests: request shape, authentication, pagination, field
 * mapping and error envelopes. No network: `fetch` is faked per test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';

import { GH_BINARIES, resolveProviderConfig, resolveToken, createClient } from '../providers.js';
import { countDiffLines, unifiedDiffFromFiles } from '../provider-common.js';
import { redactUrl } from '../provider-http.js';

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    },
  };
}

function textResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return JSON.parse(body);
    },
    async text() {
      return body;
    },
  };
}

const fetchState = { calls: [], handler: null };

globalThis.fetch = async (url, options = {}) => {
  fetchState.calls.push({ url: String(url), options });
  if (fetchState.handler === null) throw new Error(`unexpected fetch: ${url}`);
  return fetchState.handler(String(url), options);
};

function reset(handler) {
  fetchState.calls = [];
  fetchState.handler = handler;
}

test('provider-common: counts lines and rebuilds a unified diff', () => {
  assert.deepEqual(countDiffLines('@@ -1,2 +1,3 @@\n context\n-old\n+new\n+more'), { additions: 2, deletions: 1 });
  const diff = unifiedDiffFromFiles([
    { path: 'src/a.js', previousPath: '', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' },
    { path: 'src/new.js', previousPath: '', status: 'added', patch: '@@ -0,0 +1 @@\n+hello' },
    { path: 'src/old.js', previousPath: 'src/old.js', status: 'removed', patch: '' },
  ]);
  assert.match(diff, /diff --git a\/src\/a\.js b\/src\/a\.js/);
  assert.match(diff, /--- \/dev\/null/);
  assert.match(diff, /\+\+\+ b\/src\/new\.js/);
  assert.match(diff, /\+\+\+ \/dev\/null/);
});

test('provider-http: redacts credentials from messages', () => {
  assert.equal(
    redactUrl('/pulls?state=open&access_token=secret-token'),
    '/pulls?state=open&access_token=***',
  );
  assert.equal(redactUrl('/repository/get?identity=x&accessToken=abc'), '/repository/get?identity=x&accessToken=***');
});

test('resolveProviderConfig: defaults and platform labels', () => {
  assert.equal(resolveProviderConfig({}).platform, 'forgejo');
  assert.equal(resolveProviderConfig({ platform: 'gitea' }).platform, 'forgejo');
  assert.equal(resolveProviderConfig({ platform: 'github' }).baseUrl, 'https://api.github.com');
  assert.equal(resolveProviderConfig({ platform: 'gitlab', repo: 'g/p' }).baseUrl, 'https://gitlab.com');
  assert.equal(resolveProviderConfig({ platform: 'gitee', repo: 'a/b' }).baseUrl, 'https://gitee.com/api/v5');
  assert.equal(resolveProviderConfig({ platform: 'gitcode', repo: 'a/b' }).baseUrl, 'https://api.gitcode.com/api/v5');
  assert.equal(resolveProviderConfig({ platform: 'atomgit', repo: 'a/b' }).baseUrl, 'https://api.atomgit.com/api/v5');
  assert.equal(resolveProviderConfig({ platform: 'codeup', repo: 'a/b' }).baseUrl, 'https://openapi-rdc.aliyuncs.com');
  assert.equal(resolveProviderConfig({ platform: 'gitlab', repo: 'g/p' }).label, 'GitLab g/p');
  assert.equal(resolveProviderConfig({ platform: 'gitee', repo: 'a/b' }).label, 'Gitee a/b');
});

test('resolveProviderConfig: Codeup splits organization and repository path', () => {
  const parsed = resolveProviderConfig({ platform: 'codeup', repo: 'org-1/group/repo' });
  assert.equal(parsed.organizationId, 'org-1');
  assert.equal(parsed.repoPath, 'group/repo');
  const overridden = resolveProviderConfig({
    platform: 'codeup',
    repo: 'org-1/group/repo',
    organizationId: 'org-2',
    projectId: '99',
  });
  assert.equal(overridden.organizationId, 'org-2');
  assert.equal(overridden.repoPath, 'group/repo');
  assert.equal(overridden.projectId, '99');
});

test('resolveToken: platform environment variables in order', async () => {
  const names = ['GITLAB_TOKEN', 'GITEE_TOKEN', 'GITCODE_TOKEN', 'ATOMGIT_TOKEN', 'CODEUP_TOKEN', 'YUNXIAO_TOKEN', 'PR_REVIEW_TOKEN'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  try {
    const providerOf = (platform) => resolveProviderConfig({ platform, repo: 'a/b' });
    for (const name of names) process.env[name] = `${name.toLowerCase()}-value`;
    assert.equal(await resolveToken({}, providerOf('gitlab')), 'gitlab_token-value');
    assert.equal(await resolveToken({}, providerOf('gitee')), 'gitee_token-value');
    assert.equal(await resolveToken({}, providerOf('gitcode')), 'gitcode_token-value');
    assert.equal(await resolveToken({}, providerOf('atomgit')), 'atomgit_token-value');
    assert.equal(await resolveToken({}, providerOf('codeup')), 'codeup_token-value');
    assert.equal(await resolveToken({ token: 'explicit' }, providerOf('codeup')), 'explicit');
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test('resolveToken: gh fallback includes absolute paths for desktop launches', () => {
  assert.equal(GH_BINARIES[0], 'gh');
  assert.ok(GH_BINARIES.includes('/opt/homebrew/bin/gh'));
  assert.ok(GH_BINARIES.includes('/usr/local/bin/gh'));
});

test('resolveToken: finds gh outside the desktop app PATH', {
  skip: process.platform === 'win32' ? 'POSIX shell fixture' : false,
}, async () => {
  const root = await mkdtemp(nodePath.join(tmpdir(), 'pr-review-gh-'));
  const bin = nodePath.join(root, 'bin');
  const home = nodePath.join(root, 'home');
  await mkdir(bin);
  await mkdir(home);
  const gh = nodePath.join(bin, 'gh');
  await writeFile(gh, '#!/bin/sh\necho fake-gh-token\n');
  await chmod(gh, 0o755);
  const saved = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    GH_TOKEN: process.env.GH_TOKEN,
  };
  try {
    process.env.PATH = bin;
    process.env.HOME = home;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    const provider = resolveProviderConfig({ platform: 'github', repo: 'owner/repo' });
    assert.equal(await resolveToken({}, provider), 'fake-gh-token');
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('GitLab adapter: list, detail, diffs, comments and publish', async () => {
  const provider = resolveProviderConfig({ platform: 'gitlab', repo: 'group/project' });
  const client = createClient({}, provider, 'glpat-test');
  reset(async (url) => {
    if (url.includes('/merge_requests?state=opened')) {
      return jsonResponse(200, [{
        iid: 7,
        title: 'MR',
        author: { username: 'dev' },
        updated_at: '2026-01-01',
        created_at: '2025-12-31',
        source_branch: 'feat',
        target_branch: 'main',
        sha: 'abc',
        diff_refs: { head_sha: 'head1', base_sha: 'base1' },
        changes_count: '3',
        web_url: 'https://gitlab.com/group/project/-/merge_requests/7',
      }]);
    }
    if (url.includes('/merge_requests/7/diffs?per_page=100&page=1')) {
      return jsonResponse(200, [{
        old_path: 'src/a.js',
        new_path: 'src/a.js',
        new_file: false,
        deleted_file: false,
        renamed_file: false,
        diff: '@@ -1 +1,2 @@\n-old\n+new\n+more',
      }]);
    }
    if (url.includes('/merge_requests/7/diffs?per_page=100&page=2')) return jsonResponse(200, []);
    if (url.includes('/merge_requests/7/notes?per_page=100&sort=asc')) {
      return jsonResponse(200, [
        { id: 1, system: true, body: 'added commit', author: { username: 'gitlab' }, created_at: 't0' },
        { id: 2, system: false, body: 'LGTM?', author: { username: 'dev' }, created_at: 't1' },
      ]);
    }
    if (url.endsWith('/merge_requests/7/notes') && url.includes('/projects/')) {
      return jsonResponse(201, { id: 55, web_url: 'https://gitlab.com/note/55' });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  const list = await client.listOpenPulls();
  assert.equal(list[0].number, 7);
  assert.equal(list[0].headSha, 'head1');
  assert.equal(list[0].changedFiles, 3);
  assert.equal(list[0].platform, 'gitlab');

  const files = await client.pullFiles(7);
  assert.equal(files.length, 1);
  assert.deepEqual({ additions: files[0].additions, deletions: files[0].deletions }, { additions: 2, deletions: 1 });

  const diff = await client.pullDiff(7);
  assert.match(diff, /diff --git a\/src\/a\.js b\/src\/a\.js/);

  const comments = await client.listIssueComments(7);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].body, 'LGTM?');

  const published = await client.createComment(7, 'body');
  assert.deepEqual(published, { id: 55, url: 'https://gitlab.com/note/55' });

  // The token never travels in the URL.
  for (const call of fetchState.calls) assert.equal(call.url.includes('glpat-test'), false);
  assert.equal(fetchState.calls[0].options.headers['PRIVATE-TOKEN'], 'glpat-test');
});

test('GitLab adapter: file content uses the encoded full path', async () => {
  const provider = resolveProviderConfig({ platform: 'gitlab', repo: 'group/project' });
  const client = createClient({}, provider, 't');
  reset(async (url) => {
    assert.match(url, /\/repository\/files\/src%2Fa\.js\/raw\?ref=head1$/);
    return textResponse(200, 'line\n');
  });
  const file = await client.pullFileContent('src/a.js', 'head1');
  assert.equal(file.content, 'line\n');
});

test('Gitee-family adapter: list, files, diff, comments and publish', async () => {
  const provider = resolveProviderConfig({ platform: 'gitee', repo: 'owner/repo' });
  const client = createClient({}, provider, 'gitee-token');
  reset(async (url, options = {}) => {
    if (url.includes('/repos/owner/repo/pulls?state=open')) {
      return jsonResponse(200, [{
        number: 5,
        title: 'PR',
        user: { login: 'dev' },
        head: { ref: 'feat', sha: 'sha5' },
        base: { ref: 'master' },
        updated_at: '2026-01-01',
        created_at: '2025-12-31',
        html_url: 'https://gitee.com/owner/repo/pulls/5',
      }]);
    }
    if (url.includes('/pulls/5/files')) {
      return jsonResponse(200, [{
        filename: 'src/a.js',
        status: 'modified',
        additions: 2,
        deletions: 1,
        patch: '@@ -1 +1,2 @@\n-old\n+new\n+more',
      }]);
    }
    if (url.includes('/pulls/5/comments') && url.includes('per_page')) {
      return jsonResponse(200, [{ id: 9, body: 'ok', user: { login: 'dev' }, created_at: 't' }]);
    }
    if (url.includes('/pulls/5/comments') && options.method === 'POST') {
      return jsonResponse(201, { id: 10, html_url: 'https://gitee.com/note/10' });
    }
    if (url.includes('/contents/src/a.js')) {
      return jsonResponse(200, { content: Buffer.from('hello').toString('base64'), encoding: 'base64', size: 5 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  const list = await client.listOpenPulls();
  assert.equal(list[0].number, 5);
  assert.equal(list[0].headSha, 'sha5');

  const files = await client.pullFiles(5);
  assert.equal(files[0].additions, 2);
  const diff = await client.pullDiff(5);
  assert.match(diff, /diff --git a\/src\/a\.js b\/src\/a\.js/);

  const comments = await client.listIssueComments(5);
  assert.equal(comments[0].id, 9);
  const published = await client.createComment(5, 'body');
  assert.equal(published.id, 10);

  const content = await client.pullFileContent('src/a.js', 'sha5');
  assert.equal(content.content, 'hello');

  // The token rides in the query string, never in an error message.
  assert.equal(fetchState.calls[0].url.includes('access_token=gitee-token'), true);
  assert.equal(redactUrl(fetchState.calls[0].url).includes('gitee-token'), false);
});

test('Gitee-family adapter: GitCode and AtomGit reuse the same client', async () => {
  for (const platform of ['gitcode', 'atomgit']) {
    const provider = resolveProviderConfig({ platform, repo: 'owner/repo' });
    const client = createClient({}, provider, 'token');
    reset(async () => jsonResponse(200, []));
    assert.deepEqual(await client.listOpenPulls(), []);
    assert.equal(fetchState.calls[0].url.startsWith(provider.baseUrl), true);
  }
});

test('Codeup adapter: resolves projectId, maps envelope, publishes with patchSetBizId', async () => {
  const provider = resolveProviderConfig({ platform: 'codeup', repo: 'org-1/group/repo' });
  const client = createClient({}, provider, 'pt-test');
  reset(async (url, options = {}) => {
    if (url.includes('/repository/get?')) {
      return jsonResponse(200, { success: true, result: { id: 42, path: 'group/repo' } });
    }
    if (url.includes('/advanced_search?')) {
      return jsonResponse(200, {
        success: true,
        result: [{
          localId: 3,
          title: 'MR',
          sourceBranch: 'feat',
          targetBranch: 'master',
          sourceCommitSha: 'sha3',
          createTime: '2026-01-01T00:00:00Z',
          updateTime: '2026-01-02T00:00:00Z',
          webUrl: 'https://codeup.aliyun.com/org-1/group/repo/change/3',
        }],
      });
    }
    if (url.includes('/diffs/list_patchsets?')) {
      return jsonResponse(200, {
        success: true,
        result: [
          { patchSetBizId: 'ps-1', patchSetVersion: 1, commitSha: 'sha1' },
          { patchSetBizId: 'ps-2', patchSetVersion: 2, commitSha: 'sha3' },
        ],
      });
    }
    if (url.includes('/diffs/change_tree?')) {
      return jsonResponse(200, {
        success: true,
        result: [{ path: 'src/a.js', status: 'MODIFIED', patch: '@@ -1 +1 @@\n-a\n+b' }],
      });
    }
    if (url.includes('/comments/list_comments')) {
      return jsonResponse(200, {
        success: true,
        result: [{ commentBizId: 'c-1', content: 'reply', author: { name: 'dev' }, createTime: 't' }],
      });
    }
    if (url.includes('/comments/create_comment')) {
      const body = JSON.parse(options.body);
      assert.equal(body.patchSetBizId, 'ps-2');
      assert.equal(body.commentType, 'GLOBAL_COMMENT');
      assert.equal(body.content, 'review body');
      return jsonResponse(200, { success: true, result: { commentBizId: 'c-2' } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });

  const list = await client.listOpenPulls();
  assert.equal(list[0].number, 3);
  assert.equal(list[0].headSha, 'sha3');
  assert.equal(list[0].platform, 'codeup');

  const files = await client.pullFiles(3);
  assert.equal(files[0].path, 'src/a.js');
  assert.equal(files[0].additions, 1);
  assert.equal(files[0].deletions, 1);

  const comments = await client.listIssueComments(3);
  assert.equal(comments[0].id, 'c-1');

  const published = await client.createComment(3, 'review body');
  assert.equal(published.id, 'c-2');

  for (const call of fetchState.calls) {
    assert.equal(call.options.headers['x-yunxiao-token'], 'pt-test');
    if (call.url.includes('/repository/get')) {
      // The legacy repository lookup documents a query token; the shared redactor hides it.
      assert.equal(redactUrl(call.url).includes('pt-test'), false);
    } else {
      assert.equal(call.url.includes('pt-test'), false, 'token must not leak into URLs');
    }
  }
});

test('Codeup adapter: success=false surfaces the platform error code', async () => {
  const provider = resolveProviderConfig({ platform: 'codeup', repo: 'org-1/group/repo', projectId: '42' });
  const client = createClient({}, provider, 'pt-test');
  reset(async () => jsonResponse(200, { success: false, errorCode: 'Forbidden', errorMessage: 'denied' }));
  await assert.rejects(client.listOpenPulls(), (error) => {
    assert.equal(error.code, 'Forbidden');
    assert.match(error.message, /denied/);
    return true;
  });
});

test('Gitee-family adapter: live shape quirks (string counts, deleted status, empty merged_at)', async () => {
  const provider = resolveProviderConfig({ platform: 'gitee', repo: 'owner/repo' });
  const client = createClient({}, provider, 't');
  reset(async (url) => {
    if (url.includes('/pulls/6/files')) {
      return jsonResponse(200, [
        { filename: 'a.js', status: 'deleted', additions: '2', deletions: '0', patch: '@@ -1 +1 @@\n-a\n+b' },
        { filename: 'b.js', status: null, additions: 3, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+b' },
      ]);
    }
    if (url.includes('/repos/owner/repo/pulls/6')) {
      return jsonResponse(200, { number: 6, state: 'open', merged_at: '', head: { sha: 's' } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  const files = await client.pullFiles(6);
  assert.equal(files[0].status, 'removed');
  assert.equal(files[0].additions, 2, 'numeric strings are coerced');
  assert.equal(files[1].status, 'modified');
  const detail = await client.pullDetail(6);
  assert.equal(detail.merged, false, 'an empty merged_at is not a merge');
});

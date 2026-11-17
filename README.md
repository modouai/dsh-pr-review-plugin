# dsh-pr-review-plugin

[English](README.md) | [简体中文](README.zh-CN.md)

AI-assisted pull request review for the DeepSeek Harness Web UI. The plugin watches a GitHub, GitLab, Gitea-compatible (Gitea / Forgejo / Codeberg), Gitee-compatible (Gitee / GitCode / AtomGit) or Alibaba Cloud Codeup repository for open pull requests, reviews new commits with the model behind your Harness session, and shows the whole review — report, per-file analysis, rounds, and final conclusion — in a panel docked next to the chat. Finished reviews are published as regular pull request comments, and follow-up discussion happens in the main conversation.

![Review panel: overview, per-file findings, and the review entry next to the chat](docs/images/panel-overview.en.png)

![Review panel: diff with per-segment analysis](docs/images/panel-diff.en.png)

## Features

- **Workspace aware**: each session's workspace `git origin` selects the repository and platform (GitHub; GitLab; Gitea / Forgejo / Codeberg; Gitee / GitCode / AtomGit; Codeup); the panel only shows pull requests from that repository, and switching workspaces switches reviews with it.
- **Automatic rounds**: the plugin polls for open pull requests and starts a new review round whenever new commits land (`autoReview` can be turned off).
- **Batch analysis**: every finished round analyzes all changed files in the background, one file at a time, so a round costs one model call per changed file (`autoAnalyze` can be turned off). With it off, a file is analyzed when you open it, or all at once with **Analyze all** in the file column.
- **Review panel**: a right-sidebar panel inside the session — overview / changed files / conclusion three-page navigation. The overview shows the conversation state (author replies with cross-round comparison), a changes summary, the single review findings list, and review completeness; click a file to enter the diff with per-file analysis; the conclusion page carries the final conclusion, publish composing, and published records. Columns are resizable.
- **Final conclusion**: generated in the background with visible stages and cancel support; carries review coverage (X of Y files analyzed) and a version number, and flags itself for regeneration when outdated (automatic with `autoReconclude`). It is the only decision surface in the panel — the overview no longer shows a preliminary verdict.
- **Version history**: every conclusion version is kept, and each review round gets its own tab, so older rounds and versions stay readable.
- **Reviewer feedback loop**: replies left by the implementer after the previous review comment are parsed into fixed / rejected / acknowledged states, marked on individual findings, and compared across rounds (resolved vs. still open).
- **Publishing**: check "include in publish" directly on conclusion-page items, and the comment preview regenerates live from the selection; the publish dialog only does the final confirmation (full text and conflict notices). Comments are appended (never overwritten), tagged with the reviewed commit, round, conclusion version, and coverage.
- **Chat integration**: the main conversation can read and update review data through the `review_*` tools, and the panel refreshes live — ask "risk 1 doesn't hold" or "rewrite suggestion 2" and the review updates in place.

### Chat tools

Read: `review_list_prs`, `review_get`, `review_get_report`, `review_list_files`, `review_get_analysis`, `review_get_diff`, `review_get_file`, `review_list_rounds`, `review_get_round`, `review_get_comments`

Write: `review_update_analysis`, `review_update_report`, `review_update_overview`, `review_update_conclusion` (optimistic-lock guarded), plus the panel actions `review_conclude`, `review_publish`, `review_get_links`.

## Requirements

- A DeepSeek Harness (DSH) installation with the Web UI, 0.2.2-rc.1 or later in the 0.2 line (declared as `engines.dsh`; incompatible versions are rejected at install/start). The plugin runs as a Cordis function plugin and uses the Harness `llm` service for model calls (no separate API key — it uses your Harness model, or the `provider` / `model` you configure).
- The `git` CLI, so the plugin can resolve a workspace's `origin` remote.
- A supported code host (see [Supported code hosts](#supported-code-hosts)). Gogs, Bitbucket and SVN are **not** supported.
- A code host token with permission to read pull requests and post comments.

## Supported code hosts

The plugin talks to one code host per workspace. The workspace `git origin` selects it; the `platform` / `baseUrl` / `repo` settings set the host's default target (see [Repository selection](#repository-selection)).

| Host | `platform` | Origin hosts | `baseUrl` when empty | Repository | Token sources | CLI login |
|---|---|---|---|---|---|---|
| GitHub | `github` | `github.com` | `https://api.github.com` | `owner/name` | `token`, `GITHUB_TOKEN`, `GH_TOKEN` | `gh` |
| GitLab | `gitlab` | `gitlab.com` only; a self-hosted origin falls back to Gitea | `https://gitlab.com` (adapter appends `/api/v4`) | `group/subgroup/project` | `token`, `GITLAB_TOKEN`, `PR_REVIEW_TOKEN` | — |
| Gitea / Forgejo / Codeberg | `forgejo` (alias `gitea`) | self-hosted Gitea / Forgejo hosts, `codeberg.org` | site root without `/api/v1` (adapter appends it; derived from the workspace origin when empty) | `owner/name` | `token`, `GITEA_TOKEN`, `FORGEJO_TOKEN`, `PR_REVIEW_TOKEN` | `tea` |
| Gitee | `gitee` | `gitee.com` | `https://gitee.com/api/v5` (a web root is also accepted) | `owner/name` | `token`, `GITEE_TOKEN`, `PR_REVIEW_TOKEN` | — |
| GitCode | `gitcode` | `gitcode.com`, `gitcode.net` | `https://api.gitcode.com/api/v5` (a web root is also accepted) | `owner/name` | `token`, `GITCODE_TOKEN`, `GITEE_TOKEN`, `PR_REVIEW_TOKEN` | — |
| AtomGit | `atomgit` | `atomgit.com` | `https://api.atomgit.com/api/v5` (a web root is also accepted) | `owner/name` | `token`, `ATOMGIT_TOKEN`, `GITEE_TOKEN`, `PR_REVIEW_TOKEN` | — |
| Codeup | `codeup` | `codeup.aliyun.com` | `https://openapi-rdc.aliyuncs.com` | `org/group/repo` | `token`, `CODEUP_TOKEN`, `YUNXIAO_TOKEN`, `PR_REVIEW_TOKEN` | — |

- The `baseUrl` setting itself defaults to empty; the table shows the value the adapter uses when it is empty (Gitea/Forgejo takes it from the workspace origin).
- `gitea` and `forgejo` are aliases for the same Gitea API and share one cache file.
- GitCode and AtomGit accept `GITEE_TOKEN` because they share the Gitee v5 API family.
- `tea` login works for any Gitea-compatible host, including Codeberg.
- Codeup also needs `organizationId` (the first segment of `repo` when empty) and, optionally, `projectId` (resolved through the API when empty).
- Self-hosted Gitea / Forgejo hosts are detected from the origin. Any unrecognized host falls back to the Gitea adapter, including self-hosted GitLab and GitHub Enterprise; the panel uses Gitea endpoints for them, and `platform: gitlab` in the default config is overridden once a workspace origin is recognized.
- With `platform: forgejo` and an empty `baseUrl`, the host has no address until a workspace origin supplies one, so it does not poll.
- This table and the platform map in `providers.js` are maintained together; update both when a platform changes.
- A token needs permission to read pull requests and post comments; for private repositories it needs repository read access.

## Install

The plugin is a DSH bundle. Install it into a profile with the official CLI:

```sh
dsh plugin --profile <name> add github:modouai/dsh-pr-review-plugin
```

Point the install at a tag or commit (`…#<tag-or-sha>`) to pin what actually runs. The package is also published to npm, so `dsh plugin --profile <name> add @modouai/dsh-pr-review` works by name. To install a local checkout instead, pass its path: `dsh plugin --profile <name> add ./dsh-pr-review-plugin` (run `pnpm install` inside the checkout first — a linked checkout keeps its own `node_modules`).

Before starting Harness, provide a token for your host: an environment variable, `token` in the config, or the CLI login for GitHub / Gitea (see [Supported code hosts](#supported-code-hosts)). GitLab, the Gitee family and Codeup take `token` or environment variables; they have no CLI login. In a git workspace no repository setting is needed; the workspace `origin` selects the repository and platform.

Verify the layer, then start Harness:

```sh
dsh --profile <name> --dump-config   # shows a "# == @modouai/dsh-pr-review" layer
dsh --profile <name>
```

On startup the host logs a `[pr-review] ready: …` line with the active host and API base. The bundle ships its default configuration in [`cordis.patch.yml`](cordis.patch.yml); see [Configuration](#configuration) for the default target and the remaining keys.

## Configuration

### Where settings live

The plugin is one row in the DSH loader tree. Its defaults ship in [`cordis.patch.yml`](cordis.patch.yml) and in the plugin's `Config` schema. The loader validates values against the schema and fills missing keys before the plugin starts; a value outside the schema (for example `pollSeconds: 5` or `platform: svn`) is rejected at load.

To change settings, edit the patch layer of the profile you installed into (default location):

```text
~/.dsh/profiles/<name>/cordis.patch.yml
```

The file is a top-level YAML array. Keep one entry for this row; `dsh plugin add` writes it for you:

```yaml
- id: pr-review
  name: '@modouai/dsh-pr-review'
  config:
    platform: forgejo
    baseUrl: ''
    repo: ''
    token: ''
    organizationId: ''
    projectId: ''
    pollSeconds: 60
    autoReview: true
    autoAnalyze: true
    autoReconclude: false
    evidenceVerify: true
    evidenceMaxFiles: 6
    evidenceMaxChars: 6000
    commentLanguage: zh
    provider: ''
    model: ''
    reasoningEffort: 'off'
    maxDiffCharsPerFile: 14000
```

A patch entry replaces the row's **whole** `config` object. Omitted keys fall back to the schema defaults (the values above), not to a merge with the bundle row. Start from the full block and change only what you need.

Restart Harness after editing: the host half (`index.js`, `providers.js`, `llm.js`) does not hot-reload. Check the merged layer before starting:

```sh
dsh --profile <name> --dump-config
```

### Repository selection

Repository selection is workspace-first:

- When the session workspace is a git repository with an `origin` remote, that remote selects the repository and platform. The host mapping is in [Supported code hosts](#supported-code-hosts); an unrecognized host falls back to the Gitea API.
- Switching workspaces switches the active repository, its pull request list, and its cache.
- `platform`, `baseUrl`, and `repo` are used only before a workspace resolves a repository: when set, the host polls that target in the background. Once a workspace attaches, its origin wins and the panel follows it.

A workspace that is not a git repository activates no repository: the panel shows the workspace error and does not fall back to the default target. Self-hosted GitLab and GitHub Enterprise origins are not recognized as their own platform; see [Supported code hosts](#supported-code-hosts).

### Connection settings

| Key | Accepted values | Default | Effect |
|---|---|---|---|
| `platform` | `github`, `gitea`, `forgejo`, `gitlab`, `gitee`, `gitcode`, `atomgit`, `codeup` | `forgejo` | API family for the default target. `gitea` and `forgejo` are aliases for the same Gitea API; `gitee`, `gitcode` and `atomgit` share one adapter. |
| `baseUrl` | URL, or empty | empty | Default target host. Empty uses the platform value listed in [Supported code hosts](#supported-code-hosts); for Gitea/Forgejo that value is the workspace origin. |
| `repo` | `owner/name`, or empty | empty | Default target repository. GitLab subgroups (`group/subgroup/project`) are supported; Codeup uses `org/group/repo`. Empty means "derive from the workspace origin". |
| `organizationId` | string, or empty | empty | Codeup only. Empty takes the first segment of `repo` (the origin path when the workspace supplies it). |
| `projectId` | string, or empty | empty | Codeup only. Numeric project id. Empty resolves it from `organizationId` + repository path through the Codeup API. |
| `token` | token string, or empty | empty | Explicit API token. Empty falls back to environment variables; GitHub and Gitea/Forgejo also try their CLI login (see below). |

### Review behavior

| Key | Accepted values | Default | Effect |
|---|---|---|---|
| `pollSeconds` | number ≥ 15 | `60` | How often the plugin polls for open pull requests. It also bounds how quickly new commits are noticed; the minimum is 15 seconds. |
| `autoReview` | boolean | `true` | Start a round automatically when a pull request first appears or its head SHA changes. Set `false` to review only when you click **Review now**. A failed round is retried after 5 minutes. |
| `autoAnalyze` | boolean | `true` | Analyze every changed file of a finished round in the background, one model call per file, so a round costs one call per changed file (100 files, 100 calls). Set `false` to analyze a file only when you open it, or on demand with **Analyze all**. The automatic pass does not retry failed files; **Analyze all** does, costing about one call per unfinished or failed file. Starting a new round cancels a batch still running from the previous one. A failed file shows its error in the file panel and stays out of the analyzed coverage until it succeeds. |
| `autoReconclude` | boolean | `false` | Regenerate the conclusion when the report or per-file analysis changes after it. Runs at most once every 5 minutes, never during a running round, and only while the conclusion is stale. |
| `evidenceVerify` | boolean | `true` | Two-pass review: the first pass only proposes concerns and the evidence they need, the host fetches callers, definitions and tests, and a verifier scores each concern against that evidence (80+ becomes a finding, 25-79 becomes an unverified note, below 25 is dropped). No concerns still costs one call; with concerns each file costs one extra verifier call. Set `false` to fall back to the single pass, where concerns become findings directly. |
| `commentLanguage` | `zh`, `en` | `zh` | Language of the published comment (labels, headings, appendix, footer) and the language the built-in prompts ask the model to write in: per-file analysis, conclusion, discussion answers and feedback parsing. It defaults to `zh`, so an English repository needs `commentLanguage: en` explicitly. The setting applies when text is generated; content generated earlier is not rewritten. |

### Model and limits

| Key | Accepted values | Default | Effect |
|---|---|---|---|
| `provider` / `model` | strings, or empty | empty | Both must be set to take effect. Otherwise the plugin uses the current Harness default model. Setting only one falls back to the default. |
| `reasoningEffort` | `off`, `low`, `high`, `max` | `off` | Reasoning effort for report, per-file, and conclusion calls. If the selected model rejects the level, the plugin retries the call without it. |
| `evidenceMaxFiles` | number, 1-20 | `6` | Most files the verifier may read; overflow is reported as unverified. |
| `evidenceMaxChars` | number ≥ 500 | `6000` | Character cap per evidence file, truncated at line boundaries. |
| `maxDiffCharsPerFile` | number ≥ 1000 | `14000` | Maximum diff characters per file sent to the model. The report call uses at most 2,200 characters per file and 120,000 characters of excerpts in total. |

### Token resolution

The first non-empty value wins:

| Platform | Resolution order |
|---|---|
| `github` | `config.token` → `GITHUB_TOKEN` → `GH_TOKEN` → `gh auth login` |
| `gitea` / `forgejo` | `config.token` → `GITEA_TOKEN` → `FORGEJO_TOKEN` → `PR_REVIEW_TOKEN` → `tea` login |
| `gitlab` | `config.token` → `GITLAB_TOKEN` → `PR_REVIEW_TOKEN` |
| `gitee` | `config.token` → `GITEE_TOKEN` → `PR_REVIEW_TOKEN` |
| `gitcode` | `config.token` → `GITCODE_TOKEN` → `GITEE_TOKEN` → `PR_REVIEW_TOKEN` |
| `atomgit` | `config.token` → `ATOMGIT_TOKEN` → `GITEE_TOKEN` → `PR_REVIEW_TOKEN` |
| `codeup` | `config.token` → `CODEUP_TOKEN` → `YUNXIAO_TOKEN` → `PR_REVIEW_TOKEN` |

The token needs permission to read pull requests and post comments. For private repositories it needs repository read access.

The CLI fallback applies to GitHub (`gh`) and Gitea/Forgejo (`tea`) only. GitLab, Gitee, GitCode, AtomGit and Codeup read the token from `config.token` or their environment variable.

Prefer an environment variable or CLI login over storing the token in `cordis.patch.yml`: the file is plaintext. The plugin never writes the token to the review cache.

### Example setups

**Follow the workspace (default).** Leave the repository keys empty and provide the token through the environment:

```sh
export GITEA_TOKEN=...     # Gitea / Forgejo
export GITHUB_TOKEN=...    # GitHub
export GITLAB_TOKEN=...    # GitLab
export GITEE_TOKEN=...     # Gitee, and the fallback for GitCode / AtomGit
export GITCODE_TOKEN=...   # GitCode (optional override)
export ATOMGIT_TOKEN=...   # AtomGit (optional override)
export CODEUP_TOKEN=...    # Codeup (YUNXIAO_TOKEN works too)
```

**Start on a fixed Gitea/Forgejo repository.** Use this for polling before a workspace is attached; a git workspace still switches the panel to its own origin:

```yaml
- id: pr-review
  name: '@modouai/dsh-pr-review'
  config:
    platform: forgejo
    baseUrl: https://git.example.com
    repo: acme/portal
    token: ''
    pollSeconds: 60
    autoReview: true
    autoAnalyze: true
    autoReconclude: false
    evidenceVerify: true
    evidenceMaxFiles: 6
    evidenceMaxChars: 6000
    commentLanguage: zh
    provider: ''
    model: ''
    reasoningEffort: 'off'
    maxDiffCharsPerFile: 14000
```

**Start on a fixed GitHub repository.** Use `platform: github` and the GitHub API root:

```yaml
- id: pr-review
  name: '@modouai/dsh-pr-review'
  config:
    platform: github
    baseUrl: https://api.github.com
    repo: acme/portal
    token: ''
    pollSeconds: 60
    autoReview: true
    autoAnalyze: true
    autoReconclude: false
    commentLanguage: en
    provider: ''
    model: ''
    reasoningEffort: 'off'
    maxDiffCharsPerFile: 14000
```

**Start on a fixed GitLab repository.** Use the instance root as `baseUrl`; subgroups stay in `repo`:

```yaml
- id: pr-review
  name: '@modouai/dsh-pr-review'
  config:
    platform: gitlab
    baseUrl: https://gitlab.com
    repo: group/subgroup/project
    token: ''
    pollSeconds: 60
    autoReview: true
    autoAnalyze: true
    autoReconclude: false
    commentLanguage: en
    provider: ''
    model: ''
    reasoningEffort: 'off'
    maxDiffCharsPerFile: 14000
```

This example targets `gitlab.com`; a self-hosted GitLab origin is not detected and falls back to the Gitea adapter. Do not rely on `platform: gitlab` to override it: a workspace origin replaces it once recognized.

**Start on a fixed Codeup repository.** Set `repo` to `org/group/repo`; leave `organizationId` empty to take the first segment, and `projectId` empty to resolve it through the Codeup API:

```yaml
- id: pr-review
  name: '@modouai/dsh-pr-review'
  config:
    platform: codeup
    baseUrl: https://openapi-rdc.aliyuncs.com
    repo: <organizationId>/<group>/<repo>
    organizationId: ''
    projectId: ''
    token: ''
    pollSeconds: 60
    autoReview: true
    autoAnalyze: true
    autoReconclude: false
    evidenceVerify: true
    evidenceMaxFiles: 6
    evidenceMaxChars: 6000
    commentLanguage: zh
    provider: ''
    model: ''
    reasoningEffort: 'off'
    maxDiffCharsPerFile: 14000
```

With the `org/group/repo` form, a non-empty `organizationId` overrides the first segment; the rest is the repository path.

**Start on a fixed Gitee-family repository.** Use `platform: gitee`, `gitcode`, or `atomgit`; `baseUrl` can be the web root or the matching API root; `repo` stays `owner/name`.

**Keep cost and latency down.** Poll less often, review only on demand, and send less diff text. These keys go inside the row's `config:` block:

```yaml
    pollSeconds: 180
    autoReview: false
    autoAnalyze: false
    reasoningEffort: 'off'
    maxDiffCharsPerFile: 8000
```

**Favor thorough reviews.** Spend more reasoning on the report and the conclusion, and keep the conclusion in sync automatically:

```yaml
    reasoningEffort: high
    autoReconclude: true
    maxDiffCharsPerFile: 24000
```

The last two snippets are partial on purpose: unlisted keys keep their defaults. If you are editing the full row, merge these keys into the full block instead.

## Usage

1. In a session, click the **Review PRs** button in the session header (or the card under the composer in an empty session).
2. Pick a pull request at the top; with `autoReview` on, the first review starts in the background (otherwise click **Review now**).
3. On the overview page, read the changes summary, review findings, and completeness; click a file in the left column to enter the detail page with its diff and per-file analysis; with `autoAnalyze` on, files are analyzed in the background as the batch progresses, so a file you open early may still be waiting; with it off, opening a file starts its analysis. Click a hunk for the per-segment walkthrough; switch to the full file when needed.
4. Discuss in the main conversation — for example "risk 1 doesn't hold" or "turn suggestion 2 into a blocker" — and the review data updates directly.
5. Use the "Conclusion" entry in the left column to open the conclusion page, then click **Conclude review**; when generation finishes, the panel switches to the conclusion page automatically (reading the detail page is not interrupted). If the report changes afterwards, the panel offers **Regenerate conclusion**.
6. Check "include in publish" on the conclusion items, expand the comment preview to confirm the Markdown, then click **Publish**. Each round appends a new comment; history is never overwritten.
7. Use the round tabs at the top to revisit earlier rounds and conclusion versions (read-only).
8. After the implementer replies under the previous review comment, click **Check developer feedback** (the panel also checks automatically every 2 minutes) to see per-finding states and the resolved-vs-still-open comparison. New commits start the next round.

## Data

Review results are cached per repository under `~/.dsh/pr-review/<platform>-<repo>.json` (`gitea` uses the `forgejo` slug, so both names read the same cache). All conclusion versions and round history live in that cache and survive restarts; diffs and file contents are re-fetched on demand.

## Notes

- Upgrading the plugin: the browser side (`client.js` and its `client.<area>.js` chunks) hot-reloads; the host side (`index.js` / `providers.js` / `llm.js`) requires restarting Harness. After editing a chunk, run `pnpm stamp` before testing (see [Development](#development)).
- The pull request list shows the 20 most recently updated open pull requests; the panel says so when older ones exist.
- Cache writes are atomic (temp file + rename). If the cache cannot be read, the plugin moves it aside as `<name>.corrupt-<timestamp>` instead of overwriting it, and shows a warning in the panel.
- Published comments carry a footer identifying the plugin; the language follows `commentLanguage`, as does the model-written text.
- Comments are truncated gracefully if they exceed the platform's 60,000-character limit: the appendix shrinks first, then entries are omitted, and the truncation points to the review panel for details.

## Development

The browser half is a thin entry (`client.js`) plus area chunks (`client.<area>.js`). The Harness client loader resolves one module per package and gives every `require.async('./client.<area>.js')` script its own scope, so the areas are real modules — there is no bundler and no build step:

| File | Contents |
|---|---|
| `client.js` | registration, chunk loading, composition, slot registration |
| `client.i18n.js` | interface strings and locale plumbing |
| `client.core.js` | host API, review-record helpers, render primitives, styles, shared singletons |
| `client.components.js` | top bar, round strip, version controls, lists |
| `client.conclusion.js` | conclusion/feedback/coverage rendering, markdown |
| `client.preview.js` | publish preview dialog |
| `client.hooks.js` | stateful workspace hooks |
| `client.views.js` | file list, diff views, overview, diff column |
| `client.workspace.js` | workspace container, layout, dock, overlays |
| `client.sidebar.js` | right-sidebar tab |
| `client.entries.js` | session-header and hero entry pills |

The Host derives a package's revision from the entry file alone, and every chunk URL carries that revision, so `pnpm stamp` folds the chunks' content hash into a comment in `client.js` — otherwise a cached chunk could outlive its edit. `pnpm test` fails while that stamp is stale, and its message points at `pnpm stamp`.

Run these from the repository root after `pnpm install`:

```sh
pnpm test    # chunk contract + stamp check + unit tests
pnpm stamp   # rewrite the entry's chunk stamp after editing a chunk, then commit client.js
```

## License

[MIT](LICENSE)

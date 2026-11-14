# dsh-pr-review-plugin

[English](README.md) | [简体中文](README.zh-CN.md)

AI-assisted pull request review for the DeepSeek Harness Web UI. The plugin watches a GitHub or Gitea-compatible repository for open pull requests, reviews new commits with the model behind your Harness session, and shows the whole review — report, per-file analysis, rounds, and final conclusion — in a panel docked next to the chat. Finished reviews are published as regular pull request comments, and follow-up discussion happens in the main conversation.

## Features

- **Workspace aware**: each session's workspace `git origin` selects the repository and platform (GitHub, or Gitea-compatible hosts: Gitea / Forgejo / Codeberg); the panel only shows pull requests from that repository, and switching workspaces switches reviews with it.
- **Automatic rounds**: the plugin polls for open pull requests and starts a new review round whenever new commits land (`autoReview` can be turned off).
- **Review panel**: a right-sidebar panel inside the session — changed files, diff, and per-file analysis in three resizable columns; click any hunk in the diff for its per-segment analysis, or switch to the full file (with added lines highlighted).
- **Final conclusion**: generated in the background with visible stages and cancel support; carries review coverage (X of Y files analyzed) and a version number. When the report or file analysis changes afterwards, the panel flags the outdated conclusion and offers regeneration (automatic with `autoReconclude`).
- **Version history**: every conclusion version is kept, and each review round gets its own tab, so older rounds and versions stay readable.
- **Reviewer feedback loop**: replies left by the implementer after the previous review comment are parsed into fixed / rejected / acknowledged states, marked on individual findings, and compared across rounds (resolved vs. still open).
- **Publishing**: preview the Markdown before posting, and choose which findings to include; comments are appended (never overwritten), tagged with the reviewed commit, round, conclusion version, and coverage.
- **Chat integration**: the main conversation can read and update review data through the `review_*` tools, and the panel refreshes live — ask "risk 1 doesn't hold" or "rewrite suggestion 2" and the review updates in place.

### Chat tools

Read: `review_list_prs`, `review_get`, `review_get_report`, `review_list_files`, `review_get_analysis`, `review_get_diff`, `review_get_file`, `review_list_rounds`, `review_get_round`, `review_get_comments`

Write: `review_update_analysis`, `review_update_report`, `review_update_overview`, `review_update_conclusion` (optimistic-lock guarded), plus the panel actions `review_conclude`, `review_publish`, `review_get_links`.

## Requirements

- A DeepSeek Harness (DSH) installation with the Web UI, 0.2.2-rc.1 or later in the 0.2 line (declared as `engines.dsh`; incompatible versions are rejected at install/start). The plugin runs as a Cordis function plugin and uses the Harness `llm` service for model calls (no separate API key — it uses your Harness model, or the `provider` / `model` you configure).
- The `git` CLI, so the plugin can resolve a workspace's `origin` remote.
- A supported code host. GitHub uses the REST API v3. Gitea, Forgejo and Codeberg share the Gitea API (`/api/v1`), so one adapter covers them; Forgejo is a hard fork of Gitea and keeps that API. Gogs and GitLab expose different APIs and are **not** supported.
- A code host token with permission to read pull requests and post comments (see below).

## Install

The plugin is a DSH bundle. Install it into a profile with the official CLI:

```sh
dsh plugin --profile <name> add github:modouai/dsh-pr-review-plugin
```

Point the install at a tag or commit (`…#<tag-or-sha>`) to pin what actually runs. To install a local checkout instead, pass its path: `dsh plugin --profile <name> add ./dsh-pr-review-plugin` (run `pnpm install` inside the checkout first — a linked checkout keeps its own `node_modules`).

Verify the layer before starting, then restart Harness:

```sh
dsh --profile <name> --dump-config   # shows a "# == @modouai/dsh-pr-review" layer
dsh --profile <name>
```

The bundle ships its default configuration in [`cordis.patch.yml`](cordis.patch.yml). Defaults are also declared in the plugin's `Config` schema, so the loader validates values and fills anything omitted. To change values, override the row in your profile's `cordis.patch.yml` — a patch replaces the **whole** `config` object for that row, so restate every key you need, not just the changed one.

## Configuration

| Key | Default | Description |
|---|---|---|
| `platform` | `forgejo` | `github`, or `gitea` / `forgejo` (the two are aliases for the same Gitea API; `gitea` is accepted for readers coming from upstream) |
| `baseUrl` | empty | Gitea/Forgejo site root; leave empty to resolve from the workspace `origin`. For GitHub use `https://api.github.com` |
| `repo` | empty | `owner/name`; leave empty to resolve from the workspace `origin` |
| `token` | empty | Leave empty to fall back to environment variables, then the platform CLI login. Posting comments requires a token with comment permission |
| `pollSeconds` | `60` | Polling interval, minimum 15 seconds |
| `autoReview` | `true` | Start a new review round automatically on new commits |
| `autoReconclude` | `false` | Regenerate the conclusion automatically when the report or file analysis changes after it (at most once per 5 minutes) |
| `commentLanguage` | `zh` | Pull request comment language: `zh` / `en` |
| `provider` / `model` | empty | Use the current Harness default model when empty |
| `reasoningEffort` | `off` | Reasoning effort for review tasks: `off` / `low` / `high` / `max` |
| `maxDiffCharsPerFile` | `14000` | Maximum diff characters sent to the model per file |
| `maxFilesPerReview` | `60` | Maximum number of files included per review |

Token resolution order: `platform=github` → `GITHUB_TOKEN` / `GH_TOKEN` / `gh auth login`; `platform=gitea` or `forgejo` → `GITEA_TOKEN` / `FORGEJO_TOKEN` / `PR_REVIEW_TOKEN` / `tea` login.

## Usage

1. In a session, click the **Review PR** pill in the session header (or the card under the composer in an empty session).
2. Pick a pull request at the top; the first review starts automatically in the background (or click **Review now**).
3. Click a file in the left column to read its diff and analysis; click a hunk for the per-segment walkthrough; switch to the full file when needed.
4. Discuss in the main conversation — for example "risk 1 doesn't hold" or "turn suggestion 2 into a blocker" — and the review data updates directly.
5. Click **Generate conclusion**; if the report changes afterwards, the panel offers **Regenerate conclusion**.
6. Click **Publish** to preview the Markdown, select the findings to include, and append the comment. Each round appends a new comment; history is never overwritten.
7. Use the round tabs at the top to revisit earlier rounds and conclusion versions (read-only).
8. After the implementer replies under the previous review comment, click **Check reviewer feedback** (the panel also checks automatically every 2 minutes) to see per-finding states and the resolved-vs-still-open comparison. New commits start the next round.

## Data

Review results are cached per repository under `~/.dsh/pr-review/<platform>-<repo>.json` (`gitea` uses the `forgejo` slug, so both names read the same cache). All conclusion versions and round history live in that cache and survive restarts; diffs and file contents are re-fetched on demand.

## Notes

- Upgrading the plugin: the browser side (`client.js`) hot-reloads; the host side (`index.js` / `providers.js` / `llm.js`) requires restarting Harness.
- The pull request list shows the 20 most recently updated open pull requests; the panel says so when older ones exist.
- Cache writes are atomic (temp file + rename). If the cache cannot be read, the plugin moves it aside as `<name>.corrupt-<timestamp>` instead of overwriting it, and shows a warning in the panel.
- Published comments carry a footer identifying the plugin; the language follows `commentLanguage`.
- Comments are truncated gracefully if they exceed the platform's 60,000-character limit: the appendix shrinks first, then entries are omitted, and the truncation points to the review panel for details.

## License

[MIT](LICENSE)

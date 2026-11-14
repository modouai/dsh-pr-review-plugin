# dsh-pr-review-plugin

[English](README.md) | [简体中文](README.zh-CN.md)

面向 DeepSeek Harness Web UI 的 AI 拉取请求审查插件。插件监视 GitHub 或 Gitea 系（Gitea / Forgejo / Codeberg）仓库的 open PR，用当前 Harness 会话背后的模型审查新提交，并在主对话旁边的面板里呈现完整审查结果：报告、逐文件分析、多轮审查与最终结论。审查结论以普通 PR 评论发布，后续讨论在主对话里进行。

## 功能

- **按工作区识别仓库**：每个会话工作区的 git `origin` 决定仓库与平台（GitHub，或 Gitea 系：Gitea / Forgejo / Codeberg）；面板只显示该仓库的 PR，切换工作区即切换对应的审查数据。
- **自动轮次**：插件后台轮询 open PR，出现新提交（head sha 变化）即自动开始新一轮审查（可用 `autoReview` 关闭）。
- **审查面板**：会话内右侧边栏面板——变更文件、diff、逐文件分析三列布局，列宽可拖动；点击 diff 中的 hunk 查看逐段分析，也可切换到完整文件视图（新增行高亮）。
- **最终结论**：后台生成，展示阶段进度、可随时取消；结论带审查覆盖率（已分析 X/Y 文件）与版本号。报告或文件分析在结论之后又更新时，面板提示结论已过期并可重新生成（`autoReconclude` 可改为自动）。
- **版本历史**：每个结论版本都保留，每轮审查有独立页签，历史轮次与旧版本随时可回看（只读）。
- **实现者反馈闭环**：自动读取实现者在上一轮审查评论后的回复，解析为「已修复 / 不认可 / 已认可 / 有疑问」并标注到对应意见上，跨轮对比「已修复 / 仍未解决」。
- **发布**：发布前预览 Markdown 并勾选要纳入的条目；评论只追加、不覆盖，并标注被审 commit、轮次、结论版本与覆盖率。
- **对话集成**：主对话通过 `review_*` 工具读取和修改审查数据，面板实时刷新——说「第 1 条风险不成立」「把第 2 条建议改成阻塞项」，审查数据直接更新。

### 对话工具

读取：`review_list_prs`、`review_get`、`review_get_report`、`review_list_files`、`review_get_analysis`、`review_get_diff`、`review_get_file`、`review_list_rounds`、`review_get_round`、`review_get_comments`

写入：`review_update_analysis`、`review_update_report`、`review_update_overview`、`review_update_conclusion`（乐观锁保护），以及对应面板动作的 `review_conclude`、`review_publish`、`review_get_links`。

## 环境要求

- 已安装 DeepSeek Harness（DSH）Web UI，版本 0.2.2-rc.1 起、0.2 线内（见 `engines.dsh`；不满足时安装/启动会拒绝）。插件以 Cordis function-plugin 形式运行，模型调用走 Harness 的 `llm` 服务（无需单独 API key，默认用 Harness 当前模型，也可通过 `provider` / `model` 指定）。
- 本机装有 `git` 命令行，用于解析工作区的 `origin` remote。
- 受支持的代码平台：GitHub 走 REST API v3；Gitea、Forgejo、Codeberg 共用 Gitea API（`/api/v1`），一个适配器即可覆盖（Forgejo 是 Gitea 的硬分叉，保持 API 兼容）。Gogs 与 GitLab 的 API 不同，**不支持**。
- 代码平台的 token，需有读取 PR 与发布评论的权限（见下）。

## 安装

本插件是一个 DSH 组合包，用官方 CLI 安装进 profile：

```sh
dsh plugin --profile <name> add github:modouai/dsh-pr-review-plugin
```

需要锁定实际运行的代码时，在地址后加 tag 或 commit（`…#<tag-or-sha>`）。安装本地 checkout 则传路径：`dsh plugin --profile <name> add ./dsh-pr-review-plugin`（先在 checkout 里执行 `pnpm install`，链接安装保留各自独立的 `node_modules`）。

启动前先验证层，再重启 Harness：

```sh
dsh --profile <name> --dump-config   # 应出现 "# == @modouai/dsh-pr-review" 层
dsh --profile <name>
```

包自带默认配置（[`cordis.patch.yml`](cordis.patch.yml)），插件同时导出 `Config` schema，加载器会校验取值并补齐缺省字段。要改配置，在 profile 的 `cordis.patch.yml` 覆盖对应行——patch 会**整体替换**该行的 `config`，必须把需要的键全部重述，只写改动项会丢默认值。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `platform` | `forgejo` | `github`；或 `gitea` / `forgejo`（同属 Gitea API，两个值等价，`gitea` 更贴近上游叫法） |
| `baseUrl` | 空 | Gitea/Forgejo 站点根；留空按工作区 `origin` 自动识别。GitHub 填 `https://api.github.com` |
| `repo` | 空 | `owner/name`；留空按工作区 `origin` 自动识别 |
| `token` | 空 | 留空依次回退：环境变量、平台 CLI 登录。写 PR 评论需要该 token 有评论权限 |
| `pollSeconds` | `60` | 轮询间隔，最小 15 秒 |
| `autoReview` | `true` | 新提交自动开始新一轮审查 |
| `autoReconclude` | `false` | 报告/文件分析在结论之后更新时自动重新生成结论（5 分钟内最多一次） |
| `commentLanguage` | `zh` | PR 评论语言：`zh` / `en` |
| `provider` / `model` | 空 | 留空用 Harness 当前默认模型 |
| `reasoningEffort` | `off` | 审查任务的思考档位：`off` / `low` / `high` / `max` |
| `maxDiffCharsPerFile` | `14000` | 单个文件送入模型的最大 diff 字符数 |
| `maxFilesPerReview` | `60` | 每次审查纳入的文件上限 |

token 回退顺序：`platform=github` → `GITHUB_TOKEN` / `GH_TOKEN` / `gh auth login`；`platform=gitea` 或 `forgejo` → `GITEA_TOKEN` / `FORGEJO_TOKEN` / `PR_REVIEW_TOKEN` / `tea` 登录。

## 使用

1. 在会话里点头部「审查 PR」药丸（空会话点输入框下方的「审查 PR」卡片）。
2. 顶部选择 PR；首轮审查在后台自动开始（也可点「立即审查」）。
3. 左栏点文件查看 diff 与分析；点 hunk 看逐段讲解；需要时切换完整文件视图。
4. 在主对话里继续讨论——例如「第 1 条风险不成立」「把第 2 条建议改成阻塞项」——审查数据直接更新。
5. 点「生成最终结论」；报告有更新时面板会提示「重新生成结论」。
6. 点「发布」预览 Markdown、勾选要纳入的条目后追加评论。每轮追加一条新评论，不覆盖历史。
7. 顶部轮次页签可回看历史轮次与旧版结论（只读）。
8. 实现者在上一轮审查评论下回复后，点「检查实现者反馈」（面板打开时每 2 分钟也会自动检查一次），查看逐条状态与「已修复 / 仍未解决」对比；新提交会开启下一轮。

## 数据位置

审查结果按仓库缓存在 `~/.dsh/pr-review/<platform>-<repo>.json`（`gitea` 与 `forgejo` 共用 `forgejo` 前缀，两个名字读同一份缓存）。所有结论版本与轮次历史都在缓存里，重启后仍可查看；diff 与文件内容按需重新拉取。

## 说明

- 升级插件：浏览器侧（`client.js`）热加载；host 侧（`index.js` / `providers.js` / `llm.js`）需重启 Harness 生效。
- PR 列表只显示最近更新的 20 个 open PR；更早的存在时面板会明确提示。
- 缓存采用「临时文件 + 改名」原子写入。缓存读取失败时，插件把原文件另存为 `<文件名>.corrupt-<时间戳>` 而不是覆盖，并在面板提示。
- 发布的评论带插件署名 footer，语言跟随 `commentLanguage`。
- 评论超出平台 60000 字符上限时依次收缩：先精简附录、再省略条目，截断处会指向审查面板查看完整内容。

## License

[MIT](LICENSE)

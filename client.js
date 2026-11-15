window.__ModuleLoader__.load({
  id: '@modouai/dsh-pr-review',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Panel strings; the active locale decides which table renders. */
    const DICT = {
      zh: {
        openSidebar: '打开审查侧栏',
        sidebarDiff: '代码变更',
        sidebarAnalysis: '分析',
        discussInChat: '在对话中提问',
        panelCrash: '审查面板渲染出错，数据没有丢失。',
        panelRetry: '重试渲染',
        discussHint: '讨论在主对话进行',
        resizeFiles: '拖动调整文件列表宽度（双击恢复默认）',
        resizeDetail: '拖动调整分析栏宽度（双击恢复默认）',
        askContextWhole: '关于 PR #{number}（第 {round} 轮）总览：',
        askContextFile: '关于 PR #{number}（第 {round} 轮）{file}：',
        title: 'PR 审查',
        refresh: '刷新列表',
        refreshing: '刷新中…',
        review: '立即审查',
        reviewing: '审查中…',
        roundNone: '未审查',
        roundReviewing: '第 {round} 轮 · 审查中…',
        roundError: '第 {round} 轮 · 审查失败',
        roundInterrupted: '第 {round} 轮 · 审查已中断',
        roundNewCommits: '第 {round} 轮 · 有新提交待复审',
        roundReportReady: '第 {round} 轮 · 报告已生成，待结论',
        roundDone: '第 {round} 轮 · 已审查',
        roundDoneAt: '第 {round} 轮 · 已审查 {time}',
        reviewNextRound: '开始第 {round} 轮审查',
        reviewNextHint: '基于最新提交开启下一轮审查：会重新生成报告并清空当前结论与逐文件分析，之后需要重新生成结论并追加评论。',
        reviewFirstHint: '开始第 1 轮审查。',
        refreshHint: '刷新 PR 列表 · {time}',
        overview: '总览',
        fileDetail: '文件详情',
        files: '变更文件',
        fileUnit: '个文件',
        verdictBlock: '阻塞',
        verdictSuggest: '建议',
        verdictPass: '通过',
        verdictUnknown: '未审查',
        statusReviewing: '审查中',
        statusError: '审查失败',
        statusIdle: '未审查',
        summary: '总体评价',
        risks: '风险',
        initialRisks: '总体初筛风险',
        fileFindings: '逐文件审查发现',
        explainedOf: '已分析',
        coverageIncomplete: '还有文件未分析，以上汇总可能不完整。',
        noFileFindings: '还没有逐文件审查发现。',
        suggestionTag: '建议',
        suggestionUpdated: '已按讨论更新改进建议',
        order: '审查顺序',
        conclusion: '最终结论',
        conclude: '生成最终结论',
        concluding: '汇总中…',
        blockers: '阻塞项',
        suggestions: '修改建议',
        nextSteps: '下一步',
        logic: '代码逻辑',
        walkthrough: '逐段分析',
        walkSegment: '逐段分析',
        walkHint: '点击 diff 里的 hunk 标题查看逐段分析',
        close: '关闭',
        changes: '具体改动',
        issues: '审查意见',
        fileSuggestions: '改进建议',
        explaining: '正在分析…',
        reExplain: '重新分析',
        emptyPr: '没有打开的 PR',
        emptyReview: '该 PR 尚未审查，点「立即审查」开始。',
        emptyFile: '选择左侧文件查看变更与审查详情。',
        noFiles: '还没有变更文件。',
        tokenMissing: '缺少代码平台 token：请在插件配置或环境变量里填写；GitHub / Gitea（Forgejo）也可先用 gh / tea 登录。',
        truncatedList: '仅列出最近更新的 20 个 PR；更早的 PR 未显示。',
        filesTruncated: '该 PR 的变更文件过多，仅纳入了前 400 个；未纳入的文件不在本页。',
        detailTitle: '审查详情',
        wrapOn: '自动换行',
        fullFile: '完整文件',
        diffOnly: '仅变更',
        fullFileLoading: '加载完整文件…',
        fullFileNote: '完整文件为 PR head 版本，已按新增侧行号显示；红删行不在其中，可在「仅变更」查看。',
        fullFileTruncated: '文件过大，仅显示前一部分',
        fullFileUnavailable: '该文件完整内容不可用（已删除、二进制或超过接口上限）',
        expandFunction: '展开完整函数/类',
        expandContext: '展开上下文',
        collapseContext: '收起',
        wrapOff: '不换行',
        publishComment: '发布',
        publishedTitle: '已发布的审查评论',
        feedbackTitle: '实现者反馈',
        feedbackCheck: '检查实现者反馈',
        feedbackChecking: '检查中…',
        feedbackEmpty: '上一轮的审查评论下还没有实现者回复。',
        feedbackNoBaseline: '上一轮还没有发布审查评论，暂无可读取的实现者反馈。',
        fbFixedClaimed: '称已修复',
        fbDisputed: '不认可',
        fbAccepted: '已认可',
        fbQuestion: '有疑问',
        deltaTitle: '复审对比',
        deltaResolved: '已修复',
        deltaStillOpen: '仍未解决',
        updateComment: '更新 PR 评论',
        publishing: '发布中…',
        commentLink: '查看评论',
        noExplanation: '这个文件还没有分析。',
        truncated: 'diff 已截断，仅显示前一部分',
        loading: '加载中…',
        retry: '重试',
        lastPoll: '上次轮询',
        neverPolled: '尚未轮询',
        added: '新增',
        modified: '修改',
        removed: '删除',
        renamed: '重命名',
        wholePr: '整个 PR',
        contextChecking: '正在识别当前工作区的代码仓库…',
        contextNoSession: '请在工作区的会话中打开审查页签（当前没有工作区路径）。',
        contextUnsupported: '当前工作区无法识别代码仓库：不是 git 仓库，或没有配置 origin remote。',
        contextOutdated: '审查服务版本过旧：请重启 Harness 应用后再打开审查页签。',
        contextHostNotReady: '审查服务还在启动：稍候会自动重试，也可以点重试立即重连。',
        contextNotGit: '当前工作区目录不是 git 仓库（找不到 .git）。',
        contextNoOrigin: '当前工作区的 git 仓库没有配置 origin remote。',
        contextBadRemote: '当前工作区的 origin remote 不是可识别的仓库地址。',
        contextGitMissing: '没有找到 git 命令，无法识别工作区仓库。',
        contextRepo: '仓库',
        heroEntry: '审查 PR',
        heroConnecting: '正在连接审查服务…（就绪后自动出现 PR 数）',
        heroRetryHint: '审查服务连接失败，点此重试',
        heroEntryHint: '{count} 个待审查的 PR',
        overlayClose: '关闭',
        panelNoWorkspace: '请打开某个工作区的会话，在空态点击「审查 PR」进入；面板会记住最近的工作区仓库。',
        composerTitle: '讨论并修改审查内容',
        composerHint: '只作用于当前审查数据，不会发到主对话。',
        composerPlaceholder: '讨论并修改总览/文件建议…',
        composerSending: '处理中…',
        overviewUpdated: '已按讨论更新总览',
        conclusionStale: '对话或文件建议已有新改动，建议重新生成最终结论。',
        send: '发送',
        openPlatform: '在代码平台打开',
        openFile: '打开文件',
        reportPending: '正在生成总体报告…',
        noReport: '还没有总体报告。',
        severityLine: '行',
        prMeta: '作者',
        roundTabsLabel: '轮次',
        roundLatestTag: '最新',
        roundHistoryDone: '第 {round} 轮 · 已审查 {time}',
        roundHistoryNoConclusion: '第 {round} 轮 · 无结论',
        unpublishedTag: '未发布',
        unpublishedHint: '结论尚未发布到 PR 评论',
        roundMetaRound: '第 {round} 轮',
        roundMetaHead: 'head {sha}',
        roundMetaStarted: '开始 {time}',
        roundMetaFinished: '结束 {time}',
        versionPickerTitle: '切换结论版本',
        versionOption: 'v{version}',
        versionLatestTag: '（最新）',
        versionSourceModel: '模型生成',
        versionSourceHuman: '人工修改',
        versionReadOnly: '旧版本只读',
        metaRound: '第 {round} 轮',
        metaGeneratedAt: '生成于 {time}',
        metaCoverage: '覆盖 {analyzed}/{total} 文件',
        metaHumanEdited: '人工修订',
        metaPublished: '已发布',
        historyNoConclusion: '该轮还没有结论。',
        historyReadOnly: '历史轮只读：不能在此生成结论、检查反馈或发布评论。',
        staleSummary: '结论之后有更新的文件（{count} 处）',
        staleReport: '总体报告已更新',
        staleMore: '还有 {count} 个文件',
        reconclude: '重新生成结论',
        autoReconcludeOn: '已开启自动重生成：空闲时会自动重新生成结论。',
        stageCollect: '收集资料',
        stageModel: '请求模型',
        stageParse: '解析结果',
        stageWrite: '写回',
        concludingStage: '正在生成结论：{stage}',
        cancel: '取消',
        cancelBusy: '取消中…',
        previewTitle: '发布预览',
        previewRound: '第 {round} 轮',
        previewRoundMeta: '第 {round} 轮 · v{version}',
        previewLanguageZh: '语言：中文（zh）',
        previewLanguageEn: '语言：English（en）',
        previewLanguageNote: '语言由插件配置 commentLanguage 决定；发布会在该 PR 追加一条新评论。',
        previewLoading: '正在生成预览…',
        previewConfirm: '确认发布',
        previewSelectNoneHint: '没有勾选任何条目：请至少选中一条再发布。',
        publishOlderHint: '当前显示的是旧版本结论；切到最新版本后才能发布。',
        previewConfirmAppend: '仍然追加',
        alreadyPublished: '当前轮次与版本已经发布过同一结论。可以仍然追加一条新评论。',
        publishingBusy: '另一个发布任务正在进行，请稍候重试。',
        previewFailed: '预览生成失败',
        publishedVersion: 'v{version}',
        historyDiscussionDisabled: '历史轮次只读，讨论已禁用。',
        historyDiscussionLockedHint: '切回最新轮后可继续讨论并修改。',
        previewItems: '评论条目',
        previewItemsCount: '已选 {selected}/{total}',
        selectAll: '全选',
        selectNone: '全不选',
        previewItemsHint: '取消勾选的条目不会写进评论。',
        previewRefreshing: '正在刷新预览…',
        previewFullFallback: '无法按条目选择，将发布完整评论。',
      },
      en: {
        openSidebar: 'Open the review sidebar',
        sidebarDiff: 'Changes',
        sidebarAnalysis: 'Analysis',
        discussInChat: 'Ask in the conversation',
        panelCrash: 'The review panel failed to render; no data was lost.',
        panelRetry: 'Retry',
        discussHint: 'Discussion happens in the main conversation',
        resizeFiles: 'Drag to resize the file list (double-click to reset)',
        resizeDetail: 'Drag to resize the analysis column (double-click to reset)',
        askContextWhole: 'About PR #{number} (round {round}), overview: ',
        askContextFile: 'About PR #{number} (round {round}), {file}: ',
        title: 'PR review',
        refresh: 'Refresh',
        refreshing: 'Refreshing…',
        review: 'Review now',
        reviewing: 'Reviewing…',
        roundNone: 'Not reviewed',
        roundReviewing: 'Round {round} · reviewing…',
        roundError: 'Round {round} · failed',
        roundInterrupted: 'Round {round} · interrupted',
        roundNewCommits: 'Round {round} · new commits pending',
        roundReportReady: 'Round {round} · report ready, conclusion pending',
        roundDone: 'Round {round} · reviewed',
        roundDoneAt: 'Round {round} · reviewed {time}',
        reviewNextRound: 'Start round {round}',
        reviewNextHint: 'Start the next round from the latest commits: the report is regenerated and the current conclusion and per-file analyses are cleared, so conclude and append a comment again.',
        reviewFirstHint: 'Start round 1 review.',
        refreshHint: 'Refresh the pull list · {time}',
        overview: 'Overview',
        fileDetail: 'File detail',
        files: 'Changed files',
        fileUnit: 'files',
        verdictBlock: 'Block',
        verdictSuggest: 'Suggest',
        verdictPass: 'Pass',
        verdictUnknown: 'Not reviewed',
        statusReviewing: 'Reviewing',
        statusError: 'Failed',
        statusIdle: 'Not reviewed',
        summary: 'Summary',
        risks: 'Risks',
        initialRisks: 'Initial screen risks',
        fileFindings: 'Per-file findings',
        explainedOf: 'Analyzed',
        coverageIncomplete: 'Some files have not been analyzed; this digest may be incomplete.',
        noFileFindings: 'No per-file findings yet.',
        suggestionTag: 'Suggestion',
        suggestionUpdated: 'Suggestions updated from the discussion',
        order: 'Reading order',
        conclusion: 'Final conclusion',
        conclude: 'Conclude review',
        concluding: 'Concluding…',
        blockers: 'Blockers',
        suggestions: 'Suggestions',
        nextSteps: 'Next steps',
        logic: 'Code logic',
        walkthrough: 'Per-segment analysis',
        walkSegment: 'Analysis',
        walkHint: 'Click a hunk header in the diff to open its per-segment analysis',
        close: 'Close',
        changes: 'What changed',
        issues: 'Findings',
        fileSuggestions: 'Suggestions',
        explaining: 'Analyzing…',
        reExplain: 'Analyze again',
        emptyPr: 'No open pull requests',
        emptyReview: 'This pull request has no review yet. Start one with Review now.',
        emptyFile: 'Pick a file on the left to see its diff and review.',
        noFiles: 'No changed files loaded yet.',
        tokenMissing: 'Code host token missing. Add it to the plugin config or an environment variable; GitHub and Gitea/Forgejo can also use the gh / tea CLI login.',
        truncatedList: 'Only the 20 most recently updated pull requests are listed; older ones are hidden.',
        filesTruncated: 'This pull request has more files than the page cap; only the first 400 are included.',
        detailTitle: 'Review detail',
        wrapOn: 'Wrap lines',
        fullFile: 'Full file',
        diffOnly: 'Diff only',
        fullFileLoading: 'Loading full file…',
        fullFileNote: 'Full file is the PR head version, numbered on the new side. Deleted lines are only in Diff only mode.',
        fullFileTruncated: 'File too large; only the beginning is shown',
        fullFileUnavailable: 'Full file unavailable (deleted, binary, or above the API limit)',
        expandFunction: 'Show whole function/class',
        expandContext: 'Show context',
        collapseContext: 'Collapse',
        wrapOff: 'No wrap',
        publishComment: 'Publish',
        publishedTitle: 'Published review comments',
        feedbackTitle: 'Developer feedback',
        feedbackCheck: 'Check developer feedback',
        feedbackChecking: 'Checking…',
        feedbackEmpty: 'The implementer has not replied to the previous review comment yet.',
        feedbackNoBaseline: 'The previous round was not published, so there is no developer feedback to read.',
        fbFixedClaimed: 'claims fixed',
        fbDisputed: 'disagrees',
        fbAccepted: 'acknowledged',
        fbQuestion: 'question',
        deltaTitle: 'Round comparison',
        deltaResolved: 'resolved',
        deltaStillOpen: 'still open',
        updateComment: 'Update PR comment',
        publishing: 'Posting…',
        commentLink: 'View comment',
        noExplanation: 'This file has not been analyzed yet.',
        truncated: 'Diff truncated; only the first part is shown',
        loading: 'Loading…',
        retry: 'Retry',
        lastPoll: 'Last poll',
        neverPolled: 'never',
        added: 'added',
        modified: 'modified',
        removed: 'removed',
        renamed: 'renamed',
        wholePr: 'Whole PR',
        contextChecking: 'Detecting the workspace repository…',
        contextNoSession: 'Open the review tab from a session that belongs to a workspace.',
        contextUnsupported: 'This workspace is not a git repository with an origin remote.',
        contextOutdated: 'The review service is outdated: restart the Harness app and reopen the review tab.',
        contextNotGit: 'This workspace is not a git repository (no .git).',
        contextNoOrigin: 'The repository has no origin remote.',
        contextBadRemote: 'The origin remote is not a recognizable repository URL.',
        contextGitMissing: 'git was not found, so the workspace repository cannot be detected.',
        contextRepo: 'Repo',
        heroEntry: 'Review PRs',
        heroEntryHint: '{count} open pull requests',
        overlayClose: 'Close',
        panelNoWorkspace: 'Open a workspace conversation and use the “Review PRs” card; the panel remembers its repository.',
        composerTitle: 'Discuss and edit the review',
        composerHint: 'Applies to the review only; never sent to the main conversation.',
        composerPlaceholder: 'Discuss or edit the overview / file suggestions…',
        composerSending: 'Working…',
        overviewUpdated: 'Overview updated from the discussion',
        conclusionStale: 'Discussion or file suggestions changed after this conclusion. Regenerate it.',
        send: 'Send',
        openPlatform: 'Open on host',
        openFile: 'Open file',
        reportPending: 'Generating the overall report…',
        noReport: 'No overall report yet.',
        severityLine: 'line',
        prMeta: 'author',
        roundTabsLabel: 'Rounds',
        roundLatestTag: 'latest',
        roundHistoryDone: 'Round {round} · reviewed {time}',
        roundHistoryNoConclusion: 'Round {round} · no conclusion',
        unpublishedTag: 'Unpublished',
        unpublishedHint: 'Conclusion not published to the PR yet',
        roundMetaRound: 'Round {round}',
        roundMetaHead: 'head {sha}',
        roundMetaStarted: 'started {time}',
        roundMetaFinished: 'finished {time}',
        versionPickerTitle: 'Switch conclusion version',
        versionOption: 'v{version}',
        versionLatestTag: ' (latest)',
        versionSourceModel: 'model-generated',
        versionSourceHuman: 'human-edited',
        versionReadOnly: 'older version, read-only',
        metaRound: 'Round {round}',
        metaGeneratedAt: 'generated {time}',
        metaCoverage: 'covers {analyzed}/{total} files',
        metaHumanEdited: 'human-edited',
        metaPublished: 'published',
        historyNoConclusion: 'This round has no conclusion yet.',
        historyReadOnly: 'Past rounds are read-only: no conclusion, feedback check, or publish here.',
        staleSummary: 'Files updated after this conclusion ({count})',
        staleReport: 'Overall report updated',
        staleMore: 'and {count} more files',
        reconclude: 'Regenerate conclusion',
        autoReconcludeOn: 'Auto-regeneration is on: the conclusion regenerates automatically when idle.',
        stageCollect: 'Collecting context',
        stageModel: 'Calling model',
        stageParse: 'Parsing result',
        stageWrite: 'Writing back',
        concludingStage: 'Generating conclusion: {stage}',
        cancel: 'Cancel',
        cancelBusy: 'Cancelling…',
        previewTitle: 'Publish preview',
        previewRound: 'Round {round}',
        previewRoundMeta: 'Round {round} · v{version}',
        previewLanguageZh: 'Language: Chinese (zh)',
        previewLanguageEn: 'Language: English (en)',
        previewLanguageNote: 'The language comes from the commentLanguage setting; publishing appends a new comment to this pull request.',
        previewLoading: 'Building preview…',
        previewConfirm: 'Publish',
        previewSelectNoneHint: 'Nothing is selected: pick at least one item before publishing.',
        publishOlderHint: 'This is an older conclusion version; switch to the latest version to publish.',
        previewConfirmAppend: 'Append anyway',
        alreadyPublished: 'This round and version were already published. You can still append another comment.',
        publishingBusy: 'Another publish is in progress; try again shortly.',
        previewFailed: 'Preview failed',
        publishedVersion: 'v{version}',
        historyDiscussionDisabled: 'Past rounds are read-only; discussion is disabled.',
        historyDiscussionLockedHint: 'Switch back to the latest round to discuss and edit.',
        previewItems: 'Comment items',
        previewItemsCount: '{selected}/{total} selected',
        selectAll: 'Select all',
        selectNone: 'Select none',
        previewItemsHint: 'Unchecked items are left out of the comment.',
        previewRefreshing: 'Refreshing preview…',
        previewFullFallback: 'Item selection unavailable; the full comment will be published.',
      },
    };

    /** Read the locale preference snapshot and subscribe to its changes. */
    function useLocaleId(ctx) {
      const locale = ctx.get('locale');
      const read = () => {
        try {
          const snapshot = locale?.getSnapshot?.();
          return snapshot?.active ?? snapshot?.id ?? 'en';
        } catch {
          return 'en';
        }
      };
      const [id, setId] = React.useState(read);
      React.useEffect(() => {
        if (locale?.subscribe === undefined) return undefined;
        return locale.subscribe(() => setId(read()));
      }, [locale]);
      return id;
    }

    function localeTableFor(ctx) {
      let id = 'en';
      try {
        const snapshot = ctx.get('locale')?.getSnapshot?.();
        id = snapshot?.active ?? snapshot?.id ?? 'en';
      } catch {
        id = 'en';
      }
      return String(id).startsWith('zh') ? DICT.zh : DICT.en;
    }

    function makeT(localeId) {
      const table = String(localeId).startsWith('zh') ? DICT.zh : DICT.en;
      return (key) => table[key] ?? DICT.en[key] ?? key;
    }

    /** JSON request against this plugin's Host routes. */
    async function api(pathname, init) {
      const response = await window.fetch(pathname, init);
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      if (!response.ok || payload === null || payload.ok === false) {
        const error = new Error(payload?.error?.message ?? `HTTP ${response.status}`);
        error.status = response.status;
        error.code = typeof payload?.error?.code === 'string' ? payload.error.code : '';
        throw error;
      }
      return payload;
    }

    function postJson(pathname, body) {
      return api(pathname, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    function formatClock(ts) {
      if (typeof ts !== 'number' || ts <= 0) return '';
      try {
        return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      } catch {
        return '';
      }
    }

    /** Day + time for round metadata; historical rounds may be days old. */
    function formatStamp(ts) {
      if (typeof ts !== 'number' || ts <= 0) return '';
      try {
        return new Date(ts).toLocaleString(undefined, {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        });
      } catch {
        return '';
      }
    }

    /** Fill `{name}` placeholders in one localized template. */
    function fill(template, vars) {
      let output = String(template ?? '');
      for (const key of Object.keys(vars ?? {})) output = output.split(`{${key}}`).join(String(vars[key] ?? ''));
      return output;
    }

    /** Starter text the review panel inserts into the main composer ("ask in conversation"). */
    function reviewAskContext(t, number, round, filePath) {
      const values = {
        number: String(number === undefined || number === null ? '' : number),
        round: String(round === undefined || round === null ? 1 : round),
        file: typeof filePath === 'string' ? filePath : '',
      };
      return values.file !== ''
        ? fill(t('askContextFile'), values)
        : fill(t('askContextWhole'), values);
    }

    /** Short commit hash for the round metadata line. */
    function shortSha(value) {
      const sha = typeof value === 'string' ? value : '';
      return sha === '' ? '—' : sha.slice(0, 7);
    }

    /**
     * Rounds for a review, ascending. Records written before the history existed
     * (no `roundHistory`) are treated as a single round so the UI still works.
     */
    function roundsOf(review) {
      const history = Array.isArray(review?.roundHistory) ? review.roundHistory : [];
      const list = history.filter(
        (entry) => entry !== null && entry !== undefined && typeof entry.round === 'number',
      );
      if (list.length > 0) return list.slice().sort((a, b) => a.round - b.round);
      const round = typeof review?.round === 'number' ? review.round : 1;
      return [{
        round,
        headSha: text(review?.headSha),
        startedAt: review?.startedAt ?? 0,
        finishedAt: review?.finishedAt ?? 0,
        conclusions: [],
        delta: review?.delta ?? null,
        feedback: review?.feedback ?? null,
        publishedIds: [],
      }];
    }

    /**
     * State transition for picking a round: the latest one keeps following (null) while a
     * historical round is pinned; either way the overview becomes the visible pane.
     */
    function applyRoundSelection(round, latestRoundNumber) {
      return {
        roundPick: round === latestRoundNumber ? null : round,
        mode: 'overview',
      };
    }

    /** All versions of one round's conclusion, ascending; falls back to the top-level conclusion. */
    function versionsOf(review, roundEntry, isCurrent) {
      const raw = Array.isArray(roundEntry?.conclusions) ? roundEntry.conclusions : [];
      const list = raw.filter(
        (entry) => entry !== null && entry !== undefined && typeof entry.version === 'number',
      );
      if (list.length > 0) return list.slice().sort((a, b) => a.version - b.version);
      if (isCurrent === true && review?.conclusion !== null && review?.conclusion !== undefined) {
        return [{
          version: 1,
          createdAt: typeof review.conclusionAt === 'number' ? review.conclusionAt : 0,
          source: 'model',
          conclusion: review.conclusion,
          coverage: review.coverage ?? null,
        }];
      }
      return [];
    }

    /** Published comments that belong to one round (older records may lack `entry.round`). */
    function publishedOfRound(review, roundNumber) {
      const list = Array.isArray(review?.published) ? review.published : [];
      return list.filter(
        (entry) => entry !== null && entry !== undefined
          && (typeof entry.round !== 'number' || entry.round === roundNumber),
      );
    }

    /**
     * Changes that landed after the latest conclusion: per-file updates (and the report),
     * used for the actionable stale notice and the regenerate button label.
     */
    function staleInfoOf(review, versions) {
      if (review === null || review === undefined) return null;
      const latest = Array.isArray(versions) && versions.length > 0 ? versions[versions.length - 1] : null;
      const rawCreated = latest === null ? review.conclusionAt : (latest.createdAt ?? review.conclusionAt);
      const createdAt = typeof rawCreated === 'number' ? rawCreated : 0;
      if (createdAt <= 0) return null;
      const reportNewer = (review.reportUpdatedAt ?? 0) > createdAt;
      const files = [];
      for (const entry of review.explanations ?? []) {
        if ((entry.updatedAt ?? 0) > createdAt && typeof entry.file === 'string' && entry.file !== '') {
          files.push(entry.file);
        }
      }
      files.sort((a, b) => a.localeCompare(b));
      if (!reportNewer && files.length === 0) return null;
      return { createdAt, files, reportNewer, count: files.length + (reportNewer ? 1 : 0) };
    }

    /** Model/parse stages reported by the host while a conclusion is being generated. */
    const STAGE_KEY = {
      collect: 'stageCollect',
      model: 'stageModel',
      parse: 'stageParse',
      write: 'stageWrite',
    };

    /**
     * Scroll a rendered diff to the new-side line of a clicked conclusion item.
     * Missing container/row means the line is outside the displayed hunks: stay silent.
     */
    function scrollToNewLine(container, line) {
      if (container === null || container === undefined) return false;
      if (typeof container.querySelector !== 'function') return false;
      if (!Number.isFinite(line) || line <= 0) return false;
      const target = container.querySelector(`[data-new-line="${Math.floor(line)}"]`);
      if (target === null || target === undefined || typeof target.scrollIntoView !== 'function') {
        return false;
      }
      target.scrollIntoView({ block: 'center' });
      return true;
    }

    /** `path:line` for conclusion/preview items (plain path when the line is unknown). */
    function fileLineLabel(file, line) {
      const path = text(file);
      if (path === '') return '';
      return Number.isFinite(line) && line > 0 ? `${path}:${Math.floor(line)}` : path;
    }

    /** Normalize one conclusion item for the publish-selection UI. */
    function previewItemOf(raw, kind) {
      return {
        id: typeof raw?.id === 'string' ? raw.id : '',
        kind: kind === 'suggestion' ? 'suggestion' : 'blocker',
        file: text(raw?.file),
        point: text(raw?.point),
        line: Number.isFinite(raw?.line) && raw.line > 0 ? Math.floor(raw.line) : 0,
      };
    }

    /**
     * Items shown in the publish preview: the host's `items` win; hosts that do not return
     * them yet fall back to the current conclusion so selection keeps working.
     */
    function previewItemsOf(hostItems, conclusion) {
      if (Array.isArray(hostItems)) {
        return hostItems
          .filter((item) => item !== null && item !== undefined)
          .map((item) => previewItemOf(item, item?.kind));
      }
      if (conclusion === null || conclusion === undefined) return [];
      const blockers = (Array.isArray(conclusion.blockers) ? conclusion.blockers : [])
        .map((item) => previewItemOf(item, 'blocker'));
      const suggestions = (Array.isArray(conclusion.suggestions) ? conclusion.suggestions : [])
        .map((item) => previewItemOf(item, 'suggestion'));
      return [...blockers, ...suggestions].filter((item) => item.point !== '' || item.file !== '');
    }

    /** Selection can only be honoured when every preview item carries a stable host id. */
    function previewSelectionSupported(items) {
      return Array.isArray(items) && items.length > 0 && items.every((item) => item.id !== '');
    }

    /** Publish `includeIds`: only a dialog selection the host can honour is sent. */
    function selectionIncludeIds(preview) {
      if (preview === null || preview === undefined) return null;
      if (preview.selectionSupported !== true) return null;
      if (!Array.isArray(preview.selectedIds)) return null;
      return preview.selectedIds.slice();
    }

    /** `/comment/preview` body: `includeIds` only when a real selection exists. */
    function buildPreviewBody(number, includeIds) {
      const body = { number };
      if (Array.isArray(includeIds)) body.includeIds = includeIds.slice();
      return body;
    }

    /** `/comment` body: the same selection also follows the force ("仍然追加") path. */
    function buildPublishBody(number, force, includeIds) {
      const body = { number, force: force === true };
      if (Array.isArray(includeIds)) body.includeIds = includeIds.slice();
      return body;
    }

    function text(value) {
      return typeof value === 'string' ? value : '';
    }

    const VERDICT_KEY = {
      block: 'verdictBlock',
      suggest: 'verdictSuggest',
      pass: 'verdictPass',
    };

    /** Severity → localized label. */
    function severityLabel(severity, t) {
      return t(VERDICT_KEY[severity] ?? 'verdictUnknown');
    }

    const STATUS_KEY = {
      added: 'added',
      modified: 'modified',
      removed: 'removed',
      renamed: 'renamed',
      changed: 'modified',
    };

    /** Display-safe walkthrough title: drop model-authored hunk/segment numbers. */
    function cleanStepTitle(title) {
      return String(title ?? '')
        .replace(/[（(]\s*hunk\s*#?\d+\s*[)）]/gi, '')
        .replace(/\bhunk\s*#?\d+\b[:：]?/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
    }

    /** Minimal unified-diff parser: old/new line numbers, hunk headers, add/del rows. */
    function parseUnifiedDiff(diffText, rowLimit) {
      const source = String(diffText ?? '').split('\n');
      const rows = [];
      let oldNo = 0;
      let newNo = 0;
      let dropped = 0;
      let hunkCount = 0;
      for (let index = 0; index < source.length; index += 1) {
        const line = source[index];
        if (line === '' && index === source.length - 1) continue;
        if (line.startsWith('@@')) {
          const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
          if (match !== null) {
            oldNo = Number(match[1]);
            newNo = Number(match[2]);
          }
          hunkCount += 1;
          if (rows.length < rowLimit) rows.push({ kind: 'hunk', oldNo: 0, newNo: 0, code: line, hunk: hunkCount });
          else dropped += 1;
          continue;
        }
        if (
          line.startsWith('diff ') ||
          line.startsWith('index ') ||
          line.startsWith('--- ') ||
          line.startsWith('+++ ') ||
          line.startsWith('new file') ||
          line.startsWith('deleted file') ||
          line.startsWith('similarity index') ||
          line.startsWith('rename from') ||
          line.startsWith('rename to') ||
          line.startsWith('Binary files') ||
          line.startsWith('GIT binary patch') ||
          line.startsWith('\\ No newline')
        ) {
          if (rows.length < rowLimit) rows.push({ kind: 'meta', oldNo: 0, newNo: 0, code: line });
          else dropped += 1;
          continue;
        }
        if (line.startsWith('+')) {
          if (rows.length < rowLimit) rows.push({ kind: 'add', oldNo: 0, newNo, code: line.slice(1) });
          else dropped += 1;
          newNo += 1;
          continue;
        }
        if (line.startsWith('-')) {
          if (rows.length < rowLimit) rows.push({ kind: 'del', oldNo, newNo: 0, code: line.slice(1) });
          else dropped += 1;
          oldNo += 1;
          continue;
        }
        const code = line.startsWith(' ') ? line.slice(1) : line;
        if (rows.length < rowLimit) rows.push({ kind: 'ctx', oldNo, newNo, code });
        else dropped += 1;
        oldNo += 1;
        newNo += 1;
      }
      return { rows, dropped, hunkCount };
    }

    const CSS = `
.prr-root{display:flex;flex-direction:column;flex:1 1 auto;width:100%;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;min-height:0;height:calc(var(--dsh-conversation-viewport-height,100%) - var(--dsh-composer-height,0px))}
.prr-top{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:7px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.prr-title{flex:0 0 auto;font-weight:600;font-size:13px}
.prr-select{height:28px;max-width:460px;min-width:280px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:12.5px/1 inherit;outline:none}
.prr-select:focus{border-color:var(--dsw-alias-brand-primary)}
.prr-round{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11.5px;font-weight:600;white-space:nowrap}
.prr-round[data-tone="done"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 72%,var(--dsw-alias-label-primary))}
.prr-round[data-tone="pending"]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 70%,var(--dsw-alias-label-primary))}
.prr-round[data-tone="error"]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 72%,var(--dsw-alias-label-primary))}
.prr-round[data-tone="reviewing"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);color:color-mix(in srgb,var(--dsw-alias-brand-primary) 68%,var(--dsw-alias-label-primary))}
.prr-btn{height:28px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:12.5px/1 inherit;cursor:pointer;white-space:nowrap}
.prr-btn:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover)}
.prr-btn[disabled]{opacity:.5;cursor:default}
.prr-btn-sm{height:24px;padding:0 8px;font-size:12px;border-radius:7px}
.prr-btn-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff;font-weight:600}
.prr-btn-primary:hover:not([disabled]){background:color-mix(in srgb,var(--dsw-alias-brand-primary) 86%,#000)}
.prr-banner{flex:0 0 auto;margin:8px 14px 0;padding:7px 10px;border-radius:8px;font-size:12.5px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 13%,transparent);color:var(--dsw-alias-state-error-primary);word-break:break-word}
.prr-body{flex:1;min-height:0;display:flex;overflow:hidden}
.prr-files{flex:0 1 246px;min-width:158px;display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.prr-pane-head{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:8px 12px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}
.prr-count{margin-left:auto;font-weight:500}
.prr-filelist{flex:1;min-height:0;overflow:auto;padding:4px 0}
.prr-frow{display:flex;align-items:center;gap:6px;width:100%;padding:5px 10px;border:0;background:transparent;color:inherit;text-align:left;font:12px/1.45 inherit;cursor:pointer}
.prr-frow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.prr-frow[data-active="true"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 15%,transparent)}
.prr-ford{flex:0 0 15px;text-align:right;color:var(--dsw-alias-label-secondary);font-size:10.5px;font-variant-numeric:tabular-nums}
.prr-fpath{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px}
.prr-fstat{flex:0 0 auto;display:flex;gap:4px;font-size:10.5px;font-variant-numeric:tabular-nums}
.prr-addn{color:var(--dsw-alias-state-success-primary)}
.prr-deln{color:var(--dsw-alias-state-error-primary)}
.prr-sev{flex:0 0 auto;width:6px;height:6px;border-radius:3px}
.prr-sev[data-sev="block"]{background:var(--dsw-alias-state-error-primary)}
.prr-sev[data-sev="suggest"]{background:var(--dsw-alias-state-warn-primary)}
.prr-diffcol{flex:1 1 320px;min-width:240px;display:flex;flex-direction:column;min-height:0;background:var(--dsw-alias-bg-base)}
.prr-diff-head{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);min-width:0}
.prr-diff-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;font-weight:600}
.prr-diff-stat{flex:0 0 auto;display:flex;gap:5px;font-size:11px;font-variant-numeric:tabular-nums}
.prr-fullfile{flex:1;min-height:0;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.5;padding:4px 0 24px}
.prr-fullfile-note{position:sticky;top:0;z-index:1;padding:4px 12px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.prr-hunkmark{color:var(--dsw-alias-brand-primary);opacity:.75}
.prr-row[data-kind="ext"]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}
.prr-row[data-kind="ext"] .prr-ln{opacity:.45}
.prr-ctxcap{display:flex;align-items:center;gap:8px;padding:3px 10px;background:var(--dsw-alias-bg-layer-2);border-top:1px dashed var(--dsw-alias-border-l1);border-bottom:1px dashed var(--dsw-alias-border-l1);font-size:11px;color:var(--dsw-alias-label-secondary)}
.prr-ctxcap-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.prr-ctxcap-btn{flex:0 0 auto;height:20px;padding:0 7px;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);font:11px/1 inherit;cursor:pointer}
.prr-ctxcap-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.prr-float-actions{margin-top:12px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l1);display:flex;gap:8px;justify-content:flex-end}
.prr-diff{flex:1;min-height:0;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.5;padding:4px 0 24px}
.prr-row{display:flex;min-width:max-content}
.prr-ln{flex:0 0 40px;width:40px;padding:0 6px 0 0;text-align:right;color:var(--dsw-alias-label-secondary);opacity:.72;user-select:none;font-variant-numeric:tabular-nums}
.prr-code{flex:1;white-space:pre;padding-right:18px}
.prr-row[data-kind="add"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 13%,transparent)}
.prr-row[data-kind="del"]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}
.prr-row[data-kind="add"] .prr-ln{color:var(--dsw-alias-state-success-primary);opacity:1}
.prr-row[data-kind="del"] .prr-ln{color:var(--dsw-alias-state-error-primary);opacity:1}
.prr-row[data-kind="hunk"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary)}
.prr-row[data-kind="hunk"] .prr-code{padding-top:2px;padding-bottom:2px}
.prr-row[data-kind="meta"]{color:var(--dsw-alias-label-secondary)}
.prr-wrap .prr-row{min-width:0}
.prr-wrap .prr-code{white-space:pre-wrap;word-break:break-word}
.prr-overview-pane{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0;background:var(--dsw-alias-bg-base)}
.prr-overview-scroll{flex:1;min-height:0;overflow:auto;padding:16px 28px 24px}
.prr-overview-inner{width:100%;max-width:920px;margin:0 auto}
.prr-overview-chat{margin-top:16px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.prr-overview-chat .prr-chat{border-top:0;max-height:280px;min-height:96px;background:transparent}
.prr-detail{flex:0 1 372px;min-width:268px;display:flex;flex-direction:column;min-height:0;border-left:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.prr-detail-head{flex:0 0 auto;display:flex;align-items:center;gap:6px;min-width:0;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.prr-detail-title{flex:0 0 auto;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.prr-navrow{display:flex;align-items:center;gap:8px;width:100%;flex:0 0 auto;padding:8px 10px;border:0;border-bottom:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);font:12.5px/1.4 inherit;cursor:pointer;text-align:left}
.prr-navrow:hover{background:var(--dsw-alias-interactive-bg-hover)}
.prr-navrow[data-active="true"]{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);color:var(--dsw-alias-brand-primary);font-weight:600}
.prr-navrow-mark{width:6px;height:6px;border-radius:2px;background:currentColor;opacity:.5;flex:0 0 auto}
.prr-navrow[data-active="true"] .prr-navrow-mark{opacity:1}
.prr-detail-body{flex:1;min-height:0;overflow:auto;padding:12px 12px 18px}
.prr-card{border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:var(--dsw-alias-bg-base);padding:10px 12px;margin-bottom:10px}
.prr-h2{font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.02em;margin:14px 0 6px}
.prr-h2:first-child{margin-top:0}
.prr-pill{display:inline-flex;align-items:center;height:19px;padding:0 7px;border-radius:9px;font-size:11px;font-weight:600;flex:0 0 auto}
.prr-pill[data-tone="block"]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 16%,transparent);color:var(--dsw-alias-state-error-primary)}
.prr-pill[data-tone="suggest"]{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 18%,transparent);color:var(--dsw-alias-state-warn-primary)}
.prr-pill[data-tone="pass"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 16%,transparent);color:var(--dsw-alias-state-success-primary)}
.prr-pill[data-tone="idle"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.prr-text{white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}
.prr-muted{color:var(--dsw-alias-label-secondary)}
.prr-filetag{font:11.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-secondary);word-break:break-all}
.prr-linklike{display:block;width:100%;padding:0;border:0;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;text-align:left;cursor:pointer;word-break:break-all}
.prr-linklike:hover{text-decoration:underline}
.prr-rowitem{display:flex;gap:8px;align-items:flex-start;padding:7px 0;border-bottom:1px dashed var(--dsw-alias-border-l1)}
.prr-rowitem:last-child{border-bottom:0;padding-bottom:0}
.prr-rowitem:first-child{padding-top:0}
.prr-rowmain{flex:1;min-width:0}
.prr-zero{padding:16px 12px;color:var(--dsw-alias-label-secondary);font-size:12.5px}
.prr-verdictline{display:flex;align-items:center;gap:8px;margin-bottom:8px;min-width:0}
.prr-verdictline .prr-meta2{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:12px}
.prr-chat{flex:0 0 auto;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;max-height:46%;min-height:64px}
.prr-composer{width:min(calc(100% - 32px),920px);margin:0 auto;display:flex;flex-direction:column;gap:6px;padding:9px 10px 9px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 8px 24px rgba(0,0,0,.14)}
.prr-composer-head{display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--dsw-alias-label-secondary);min-width:0}
.prr-composer-scope{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-brand-primary);font-weight:600}
.prr-composer-hint{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.prr-composer-input{width:100%;box-sizing:border-box;min-height:22px;max-height:140px;resize:none;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:13px/1.5 inherit;outline:none}
.prr-composer-row{display:flex;align-items:center;gap:8px}
.prr-composer-error{margin-left:auto;color:var(--dsw-alias-state-error-primary);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.prr-chat-noticeline{padding:0 0 6px;font-size:11.5px;color:var(--dsw-alias-state-success-primary)}
.prr-chat-list{flex:1;min-height:0;overflow:auto;padding:6px 12px;display:flex;flex-direction:column;gap:6px}
.prr-msg{padding:6px 9px;border-radius:8px;max-width:94%;white-space:pre-wrap;word-break:break-word;font-size:12.5px}
.prr-msg[data-role="user"]{align-self:flex-end;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent)}
.prr-msg[data-role="assistant"]{align-self:flex-start;background:var(--dsw-alias-bg-layer-2)}
.prr-inputbar{flex:0 0 auto;display:flex;gap:6px;padding:8px 10px;border-top:1px solid var(--dsw-alias-border-l1)}
.prr-input{flex:1;min-width:0;height:28px;padding:0 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:12.5px/1 inherit;outline:none}
.prr-input:focus{border-color:var(--dsw-alias-brand-primary)}
.prr-walk{border-left:2px solid var(--dsw-alias-border-l2);padding-left:9px;margin:7px 0}
.prr-finding-file{padding:8px 0;border-bottom:1px dashed var(--dsw-alias-border-l1)}
.prr-finding-file:last-child{border-bottom:0;padding-bottom:0}
.prr-finding-file:first-child{padding-top:0}
.prr-dnum{flex:0 0 16px;text-align:right;color:var(--dsw-alias-label-secondary);font-size:11px;font-variant-numeric:tabular-nums}
.prr-tag{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:10.5px;font-weight:600;flex:0 0 auto}
.prr-hero-entry[data-busy="true"]{cursor:progress;opacity:.72}
.prr-entry-status{display:inline-flex;align-items:center;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.prr-entry-status[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary)}
.prr-hero-entry[data-tone="warn"]{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 42%,transparent);color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 80%,var(--dsw-alias-label-primary))}
.prr-hero-entry{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:12px/1 inherit;cursor:pointer;white-space:nowrap}
.prr-hero-entry:hover{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-hover)}
.prr-hero-entry-title{font-size:12px;font-weight:500}
.prr-hero-count{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary-contrast,#fff);font-size:10.5px;font-weight:600;line-height:1}
.prr-drawer-footer{flex:0 0 auto;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base)}
.prr-drawer-footer .prr-dock{padding:8px 0 0}
.prr-drawer-composer{flex:0 0 auto;display:flex;gap:8px;align-items:center;padding:9px 14px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.prr-fb-pill{display:inline-flex;align-items:center;height:17px;padding:0 6px;border-radius:9px;font-size:10.5px;font-weight:600;flex:0 0 auto;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.prr-fb-pill[data-status="fixed-claimed"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 16%,transparent);color:var(--dsw-alias-state-success-primary)}
.prr-fb-pill[data-status="disputed"]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent);color:var(--dsw-alias-state-error-primary)}
.prr-fb-pill[data-status="accepted"]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 16%,transparent);color:var(--dsw-alias-state-business-primary)}
.prr-fb-reason{font-size:11px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.prr-fb-comment{padding:7px 0;border-bottom:1px dashed var(--dsw-alias-border-l1);font-size:12px}
.prr-fb-comment:last-child{border-bottom:0}
.prr-fb-meta{color:var(--dsw-alias-label-secondary);font-size:11px;margin-bottom:3px}
.prr-fb-body{white-space:pre-wrap;word-break:break-word}
.prr-md{display:flex;flex-direction:column;gap:6px;white-space:normal}
.prr-md p,.prr-md blockquote,.prr-md ul,.prr-md ol,.prr-md pre,.prr-md hr{margin:0}
.prr-md .prr-md-h{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary)}
.prr-md .prr-md-list{padding-left:18px;display:flex;flex-direction:column;gap:2px}
.prr-md code{padding:1px 4px;border-radius:4px;background:var(--dsw-alias-bg-layer-2);font:11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
.prr-md pre{padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font:11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word;overflow:auto}
.prr-md blockquote{padding:2px 0 2px 10px;border-left:2px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.prr-md a{color:var(--dsw-alias-brand-primary);text-decoration:none;word-break:break-all}
.prr-md a:hover{text-decoration:underline}
.prr-md hr{border:0;border-top:1px solid var(--dsw-alias-border-l1)}
.prr-delta-list{margin:2px 0 0;padding-left:16px;color:var(--dsw-alias-label-secondary);font-size:12px}
.prr-notice{margin:0 0 10px;padding:6px 9px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent);color:var(--dsw-alias-state-success-primary);font-size:12px}
.prr-walk-title{font-weight:600;font-size:12px}
.prr-subtle{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.prr-spacer{flex:1}
.prr-row[data-walk="true"]{cursor:pointer}
.prr-row[data-kind="hunk"][data-walk="true"]:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,var(--dsw-alias-bg-layer-2))}
.prr-row[data-active-hunk="true"]{outline:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent);outline-offset:-1px}
.prr-hunktag{flex:0 0 auto;align-self:center;margin:0 10px;height:16px;padding:0 6px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent);color:var(--dsw-alias-brand-primary);font:600 10.5px/16px inherit;white-space:nowrap}
.prr-float-backdrop{position:fixed;inset:0;z-index:95}
.prr-float{position:fixed;z-index:96;display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 18px 44px rgba(0,0,0,.3);overflow:hidden}
.prr-float-head{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:8px 10px 8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.prr-float-title{flex:1;min-width:0;font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.prr-float-close{flex:0 0 auto;width:22px;height:22px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;line-height:1}
.prr-float-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.prr-float-body{flex:1;min-height:0;overflow:auto;padding:10px 14px 14px}
.prr-float-step{padding:8px 0;border-bottom:1px dashed var(--dsw-alias-border-l1)}
.prr-float-step:first-child{padding-top:0}
.prr-float-step:last-child{border-bottom:0;padding-bottom:0}
.prr-float-step-title{font-weight:600;font-size:12.5px;margin-bottom:4px}
.prr-hit{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px dashed var(--dsw-alias-border-l1);min-width:0}
.prr-hit:last-child{border-bottom:0}
.prr-dotline{width:5px;height:5px;border-radius:3px;background:var(--dsw-alias-label-secondary);flex:0 0 auto}
.prr-roundpills{flex:0 1 auto;min-width:0;display:flex;align-items:center;overflow:hidden}
.prr-roundpills-scroll{display:flex;align-items:center;gap:6px;min-width:0;padding:1px 2px;scroll-padding-inline:6px;overflow-x:auto;overflow-y:hidden;white-space:nowrap;scrollbar-width:none;-ms-overflow-style:none}
.prr-roundpills-scroll::-webkit-scrollbar{display:none}
.prr-roundpill{flex:0 0 auto;gap:5px;border:1px solid transparent;font-family:inherit;cursor:pointer;transition:background-color 140ms ease,color 140ms ease,border-color 140ms ease,box-shadow 140ms ease}
.prr-roundpill:hover:not([data-active="true"]){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1)}
.prr-roundpill[data-active="true"]{font-weight:700;box-shadow:0 1px 2px rgba(0,0,0,.10)}
.prr-roundpill[data-active="true"]:hover{box-shadow:0 1px 2px rgba(0,0,0,.10),inset 0 0 0 100px rgba(0,0,0,.04)}
.prr-roundpill:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.prr-round[data-tone="done"][data-active="true"]{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 38%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 20%,transparent)}
.prr-round[data-tone="pending"][data-active="true"]{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 42%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 22%,transparent)}
.prr-round[data-tone="error"][data-active="true"]{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 38%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 20%,transparent)}
.prr-round[data-tone="reviewing"][data-active="true"]{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 26%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 20%,transparent)}
.prr-round[data-tone="idle"][data-active="true"]{border-color:var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.prr-roundtab-tag{display:inline-flex;align-items:center;height:15px;padding:0 4px;border-radius:6px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent);color:var(--dsw-alias-brand-primary);font-size:10px;font-weight:600}
.prr-roundtab-tag.prr-roundtag-unpublished{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 16%,transparent);color:var(--dsw-alias-state-warn-primary)}
.prr-roundmeta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 10px;padding:6px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:11.5px}
.prr-roundmeta code{font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-primary)}
.prr-select-sm{height:24px;min-width:0;max-width:240px;padding:0 6px;border-radius:7px;font-size:12px}
.prr-conclusion-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:14px 0 6px}
.prr-conclusion-head .prr-h2{margin:0}
.prr-conclusion-meta{margin-top:8px;color:var(--dsw-alias-label-secondary);font-size:11px;font-variant-numeric:tabular-nums}
.prr-dock-panel{width:100%;border:1px solid color-mix(in srgb,var(--dsw-alias-state-warn-primary) 34%,transparent);border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 78%,var(--dsw-alias-label-primary));font-size:12px;overflow:hidden;word-break:break-word}
.prr-dock-toggle{display:flex;align-items:center;gap:8px;width:100%;padding:6px 10px;border:0;background:transparent;color:inherit;font:inherit;font-weight:600;cursor:pointer;text-align:left}
.prr-dock-toggle:hover{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 8%,transparent)}
.prr-dock-toggle:focus-visible{outline:2px solid var(--dsw-alias-state-warn-primary);outline-offset:-2px}
.prr-dock-caret{flex:0 0 auto;width:10px;font-size:10px;opacity:.85}
.prr-dock-detail{display:flex;flex-direction:column;gap:4px;padding:0 10px 8px 28px;color:var(--dsw-alias-label-secondary)}
.prr-dock-detail ul{margin:0;padding-left:16px;font-size:11.5px;word-break:break-all;display:flex;flex-direction:column;gap:2px}
.prr-dock-tip{font-size:11px;color:var(--dsw-alias-label-secondary)}
.prr-actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;align-items:center}
.prr-composer-shell{position:relative;display:block;width:100%;background:var(--dsw-alias-bg-base)}
.prr-composer-shell::before{content:'';position:absolute;left:0;right:0;top:-28px;height:28px;background:linear-gradient(180deg,transparent,var(--dsw-alias-bg-base));pointer-events:none}
.prr-composer-shell .prr-dock{padding-top:2px}
.prr-dock{width:min(calc(100% - 32px),920px);margin:0 auto 6px;display:flex;align-items:flex-end;justify-content:space-between;gap:6px 12px;flex-wrap:wrap;min-width:0}
.prr-dock .prr-actions{flex:0 0 auto;margin:0 0 0 auto;justify-content:flex-end}
.prr-dock-notice{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:4px}
.prr-dock-note{display:inline-flex;align-items:center;gap:6px;align-self:flex-start;padding:3px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:11.5px}
.prr-dock-note[data-tone="warn"]{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 38%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 78%,var(--dsw-alias-label-primary))}
.prr-dock-note::before{content:'';width:5px;height:5px;border-radius:3px;background:currentColor;opacity:.45;flex:0 0 auto}
.prr-progress{display:inline-flex;align-items:center;gap:8px;min-height:28px;padding:0 10px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-brand-primary);font-size:12px;font-weight:600}
.prr-spinner{width:10px;height:10px;border-radius:50%;border:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 30%,transparent);border-top-color:var(--dsw-alias-brand-primary);animation:prr-spin .8s linear infinite;flex:0 0 auto}
@keyframes prr-spin{to{transform:rotate(360deg)}}
.prr-modal-backdrop{position:fixed;inset:0;z-index:120;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.45)}
.prr-modal{display:flex;flex-direction:column;width:min(760px,100%);max-height:min(84vh,780px);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 24px 60px rgba(0,0,0,.42);overflow:hidden}
.prr-modal-head{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:9px 12px 9px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.prr-modal-title{flex:1;min-width:0;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.prr-modal-body{flex:1;min-height:0;overflow:auto;padding:12px 16px}
.prr-modal-note{margin-bottom:8px;color:var(--dsw-alias-label-secondary);font-size:11.5px}
.prr-modal-warn{margin-top:8px;padding:6px 9px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 13%,transparent);color:var(--dsw-alias-state-warn-primary);font-size:12px}
.prr-modal-error{margin-top:8px;padding:6px 9px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 13%,transparent);color:var(--dsw-alias-state-error-primary);font-size:12px;word-break:break-word}
.prr-modal-foot{flex:0 0 auto;display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:10px 16px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.prr-markdown{margin:0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word;max-height:48vh;overflow:auto}
.prr-composer-warn{margin-left:auto;color:var(--dsw-alias-state-warn-primary);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.prr-conclude-note{margin-top:10px;padding:6px 9px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary);font-size:12px;word-break:break-word}
.prr-preview-items{margin:10px 0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);overflow:auto;max-height:240px}
.prr-preview-items-head{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11.5px}
.prr-preview-items-title{font-weight:600;margin-right:auto;white-space:nowrap}
.prr-preview-item{display:flex;align-items:flex-start;gap:8px;padding:6px 10px;border-bottom:1px dashed var(--dsw-alias-border-l1);font-size:12px;cursor:pointer}
.prr-preview-item:last-child{border-bottom:0}
.prr-preview-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.prr-preview-item input{margin:2px 0 0;flex:0 0 auto}
.prr-preview-item-body{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.prr-preview-item-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.prr-preview-item-text{white-space:pre-wrap;word-break:break-word}
.prr-preview-refreshing{margin:0 0 8px;color:var(--dsw-alias-label-secondary);font-size:11px}
.prr-resizer{flex:0 0 5px;align-self:stretch;cursor:col-resize;background:transparent;position:relative;z-index:2;touch-action:none}
.prr-resizer::after{content:'';position:absolute;top:0;bottom:0;left:2px;width:1px;background:var(--dsw-alias-border-l1)}
.prr-resizer:hover::after{background:var(--dsw-alias-brand-primary)}
.prr-panel-footer{flex:0 0 auto;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);padding:8px 10px}
.prr-panel-footer .prr-dock{width:100%;margin:0;padding:0}
.prr-panel-footer .prr-dock .prr-actions{margin-left:auto}
.prr-panel-footer-extra{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:6px}
.prr-sidebar .prr-files{flex:0 0 146px;min-width:104px}
.prr-sidebar .prr-detail{flex:0 0 224px;min-width:176px}
.prr-sidebar .prr-diffcol{min-width:176px}
.prr-sidebar .prr-top{padding:6px 8px;gap:6px}
.prr-sidebar .prr-select{min-width:110px;max-width:220px}
.prr-subseg{flex:0 0 auto;display:flex;gap:2px;padding:2px;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.prr-subseg-btn{height:22px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:12px/1 inherit;cursor:pointer;white-space:nowrap}
.prr-subseg-btn[data-active="true"]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-weight:600}
.prr-sidebar .prr-top{flex-wrap:wrap;row-gap:6px}
.prr-sidebar .prr-overview-scroll{padding:12px 14px 18px}
.prr-sidebar .prr-detail-head{padding:6px 8px;gap:6px}
.prr-sidebar .prr-detail-body{padding:10px 12px 16px}
.prr-sidebar .prr-diffcol{flex:1 1 auto}
`;

    function Pill(props) {
      return h('span', { className: 'prr-pill', 'data-tone': props.tone }, props.label);
    }

    /** Same comparable key the host uses for published items. */
    function findingKey(kind, file, point) {
      return `${kind ?? ''}|${file ?? ''}|${String(point ?? '').replace(/\s+/g, ' ').trim().toLowerCase()}`;
    }

    const FEEDBACK_LABEL_KEYS = {
      'fixed-claimed': 'fbFixedClaimed',
      disputed: 'fbDisputed',
      accepted: 'fbAccepted',
      question: 'fbQuestion',
    };

    function VerdictPill(props) {
      const { verdict, t } = props;
      const tone = verdict === 'block' || verdict === 'suggest' || verdict === 'pass' ? verdict : 'idle';
      return h(Pill, { tone, label: severityLabel(verdict, t) });
    }

    function Btn(props) {
      const className = ['prr-btn', props.small ? 'prr-btn-sm' : '', props.primary ? 'prr-btn-primary' : '']
        .filter((item) => item !== '')
        .join(' ');
      return h(
        'button',
        {
          type: 'button',
          className,
          title: props.title,
          disabled: props.disabled === true,
          onClick: props.onClick,
        },
        props.label,
      );
    }

    /** One file row in the left column: order number, severity dot, path, stats. */
    function FileRow(props) {
      const item = props.item;
      return h(
        'button',
        {
          type: 'button',
          className: 'prr-frow',
          'data-active': props.active ? 'true' : 'false',
          title: item.path + (item.reason === '' ? '' : `\n${item.reason}`),
          onClick: () => props.onOpen(item.path),
        },
        h('span', { className: 'prr-ford' }, item.order),
        item.severity === '' ? null : h('span', { className: 'prr-sev', 'data-sev': item.severity }),
        h('span', { className: 'prr-fpath' }, item.path),
        h(
          'span',
          { className: 'prr-fstat' },
          h('span', { className: 'prr-addn' }, `+${item.additions}`),
          h('span', { className: 'prr-deln' }, `-${item.deletions}`),
        ),
      );
    }

    /**
     * Left column: the overview entry, the changed-file header, then the file list. The review
     * detail area switches between the overview and a file; that entry lives here so it stays
     * in one place instead of moving with the pane headers.
     */
    function FilesPane(props) {
      const { t, overviewMode, onSelectOverview, files, filePath, review, onOpenFile } = props;
      const width = typeof props.width === 'number' && props.width > 0 ? props.width : 0;
      const style = width === 0 ? undefined : { flex: `0 0 ${width}px`, minWidth: `${width}px` };
      return h(
        'aside',
        { className: 'prr-files', style },
        h(
          'button',
          {
            type: 'button',
            className: 'prr-navrow',
            'data-active': overviewMode === true ? 'true' : 'false',
            onClick: () => onSelectOverview(),
          },
          h('span', { className: 'prr-navrow-mark' }),
          t('overview'),
        ),
        h(
          'div',
          { className: 'prr-pane-head' },
          `${t('files')}`,
          h('span', { className: 'prr-count' }, `${files.length} ${t('fileUnit')}`),
        ),
        h(
          'div',
          { className: 'prr-filelist' },
          files.length === 0
            ? h('div', { className: 'prr-zero' }, review === null ? t('emptyReview') : t('noFiles'))
            : files.map((item) =>
                h(FileRow, {
                  key: item.path,
                  item,
                  active: item.path === filePath,
                  onOpen: onOpenFile,
                }),
              ),
        ),
      );
    }

    /** Unified diff rows with old/new line numbers. */
    /**
     * Bind walkthrough entries to diff hunks. The model reports a hunk index when it
     * can; entries without one fall back to their order so old cached explanations
     * still answer a click.
     */
    /** Code identifiers mentioned by a walkthrough step (title first, then detail). */
    function stepTokens(step) {
      const tokens = new Set();
      for (const source of [step?.title, step?.detail]) {
        if (typeof source !== 'string') continue;
        for (const token of source.split(/[^A-Za-z0-9_$./-]+/)) {
          const value = token.replace(/^[./-]+|[./-]+$/g, '');
          if (value.length >= 4) tokens.add(value.toLowerCase());
        }
      }
      return [...tokens];
    }

    /** Best-effort hunk for a step without a model-provided index: score its identifiers against each hunk. */
    function guessHunkForStep(step, hunkTexts) {
      const tokens = stepTokens(step);
      if (tokens.length === 0) return 0;
      let best = 0;
      let bestScore = 0;
      hunkTexts.forEach((hunkText, index) => {
        const haystack = String(hunkText ?? '').toLowerCase();
        let score = 0;
        for (const token of tokens) if (haystack.includes(token)) score += 1;
        if (score > bestScore) {
          bestScore = score;
          best = index + 1;
        }
      });
      return best;
    }

    /**
     * Bind walkthrough entries to diff hunks. Model-provided `hunk` wins; legacy
     * explanations (cached before that field existed) fall back to matching the
     * step's identifiers against each hunk, which keeps the per-hunk entries
     * reachable without the arbitrary one-step-per-hunk assignment.
     */
    function mapWalkthroughToHunks(walkthrough, hunkTexts) {
      const result = new Map();
      const list = Array.isArray(walkthrough) ? walkthrough : [];
      const hunkCount = hunkTexts.length;
      const hasExplicit = list.some((step) => typeof step.hunk === 'number' && step.hunk > 0);
      const attach = (hunk, step) => {
        if (hunk < 1 || (hunkCount > 0 && hunk > hunkCount)) return;
        const existing = result.get(hunk) ?? [];
        existing.push(step);
        result.set(hunk, existing);
      };
      for (const step of list) {
        if (hasExplicit) {
          const hunk = typeof step.hunk === 'number' ? step.hunk : 0;
          if (hunk > 0) attach(hunk, step);
          continue;
        }
        const guessed = guessHunkForStep(step, hunkTexts);
        if (guessed > 0) attach(guessed, step);
      }
      return result;
    }

    /** New-side line range parsed from a hunk header. */
    function hunkRange(row) {
      const match = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(String(row?.code ?? ''));
      if (match === null) return null;
      const newStart = Number(match[2]);
      const newCount = match[3] === undefined ? 1 : Number(match[3]);
      return { newStart, newEnd: newStart + Math.max(newCount, 1) - 1 };
    }

    function DiffView(props) {
      const parsed = React.useMemo(
        () => parseUnifiedDiff(props.diffText, 4000),
        [props.diffText],
      );
      const hunkTexts = React.useMemo(() => {
        const list = [];
        for (const row of parsed.rows) {
          if (row.kind === 'hunk') list.push([]);
          else if (list.length > 0 && row.kind !== 'meta') list[list.length - 1].push(row.code);
        }
        return list.map((lines) => lines.join('\n'));
      }, [parsed]);
      const stepsByHunk = React.useMemo(
        () => mapWalkthroughToHunks(props.walkthrough, hunkTexts),
        [props.walkthrough, hunkTexts],
      );
      const fileLines = React.useMemo(
        () => (typeof props.fileContent === 'string' ? props.fileContent.split('\n') : null),
        [props.fileContent],
      );
      const expanded = props.expandedHunks instanceof Set ? props.expandedHunks : new Set();
      const contextFor = (hunk) => {
        const steps = stepsByHunk.get(hunk) ?? [];
        const withContext = steps.find(
          (step) => step.context !== null && step.context !== undefined && step.context.startLine >= 1,
        );
        return withContext === undefined ? null : withContext.context;
      };
      const contextLines = (startLine, endLine) => {
        if (fileLines === null) return [];
        const from = Math.max(1, startLine);
        const to = Math.min(fileLines.length, endLine);
        if (to < from) return [];
        const rows = [];
        for (let lineNo = from; lineNo <= to; lineNo += 1) {
          rows.push({ lineNo, code: fileLines[lineNo - 1] ?? '' });
        }
        return rows;
      };
      if (parsed.rows.length === 0) {
        return h('div', { className: 'prr-zero' }, props.emptyText);
      }
      const renderContext = (lineNo, code, key) =>
        h(
          'div',
          { key, className: 'prr-row', 'data-kind': 'ext', 'data-new-line': String(lineNo) },
          h('span', { className: 'prr-ln' }, ''),
          h('span', { className: 'prr-ln' }, String(lineNo)),
          h('span', { className: 'prr-code' }, code === '' ? ' ' : code),
        );
      const groups = [];
      const preamble = [];
      for (const row of parsed.rows) {
        if (row.kind === 'hunk') {
          groups.push({ hunk: row.hunk, header: row, rows: [] });
          continue;
        }
        if (groups.length === 0) preamble.push(row);
        else groups[groups.length - 1].rows.push(row);
      }
      const rendered = preamble.map((row, index) =>
        h(
          'div',
          {
            key: `pre-${index}`,
            className: 'prr-row',
            'data-kind': row.kind,
            'data-new-line': row.newNo > 0 ? String(row.newNo) : '',
          },
          h('span', { className: 'prr-ln' }, row.oldNo > 0 ? String(row.oldNo) : ''),
          h('span', { className: 'prr-ln' }, row.newNo > 0 ? String(row.newNo) : ''),
          h('span', { className: 'prr-code' }, row.code === '' ? ' ' : row.code),
        ),
      );
      for (const group of groups) {
        const steps = stepsByHunk.get(group.hunk) ?? [];
        const clickable = steps.length > 0;
        const range = hunkRange(group.header);
        const opened = expanded.has(group.hunk) && range !== null && fileLines !== null;
        const context = range === null ? null : contextFor(group.hunk);
        const startLine = context !== null && context.startLine <= range.newStart
          ? context.startLine
          : Math.max(1, (range === null ? 1 : range.newStart) - 40);
        const endLine = context !== null && context.endLine >= range.newStart
          ? context.endLine
          : Math.min(fileLines === null ? 0 : fileLines.length, (range === null ? 0 : range.newEnd) + 40);
        const label = context !== null ? context.label : props.expandFallbackLabel ?? '';
        if (opened) {
          rendered.push(
            h(
              'div',
              { key: `cap-${group.hunk}`, className: 'prr-ctxcap' },
              h('span', { className: 'prr-ctxcap-label' }, `${label === '' ? '' : `${label} · `}${startLine}-${endLine}`),
              h('button', {
                type: 'button',
                className: 'prr-ctxcap-btn',
                onClick: () => props.onCollapseHunk(group.hunk),
              }, props.collapseLabel ?? ''),
            ),
          );
          for (const line of contextLines(startLine, range.newStart - 1)) {
            rendered.push(renderContext(line.lineNo, line.code, `ctx-top-${group.hunk}-${line.lineNo}`));
          }
        }
        rendered.push(
          h(
            'div',
            {
              key: `hunk-${group.hunk}`,
              className: 'prr-row',
              'data-kind': 'hunk',
              'data-walk': clickable ? 'true' : 'false',
              'data-active-hunk': clickable && props.activeHunk === group.hunk ? 'true' : 'false',
              title: clickable ? props.hint ?? '' : undefined,
              onClick: clickable ? (event) => props.onOpenHunk(group.hunk, steps, event) : undefined,
            },
            h('span', { className: 'prr-ln' }, ''),
            h('span', { className: 'prr-ln' }, ''),
            h('span', { className: 'prr-code' }, group.header.code === '' ? ' ' : group.header.code),
            clickable
              ? h(
                  'span',
                  {
                    className: 'prr-hunktag',
                    title: steps.map((step) => cleanStepTitle(step.title)).join('\n'),
                  },
                  steps.length > 1 ? `${props.walkLabel ?? ''} ${steps.length}` : (props.walkLabel ?? ''),
                )
              : null,
          ),
        );
        for (const row of group.rows) {
          rendered.push(
            h(
              'div',
              {
                key: `row-${group.hunk}-${row.oldNo}-${row.newNo}`,
                className: 'prr-row',
                'data-kind': row.kind,
                'data-new-line': row.newNo > 0 ? String(row.newNo) : '',
              },
              h('span', { className: 'prr-ln' }, row.oldNo > 0 ? String(row.oldNo) : ''),
              h('span', { className: 'prr-ln' }, row.newNo > 0 ? String(row.newNo) : ''),
              h('span', { className: 'prr-code' }, row.code === '' ? ' ' : row.code),
            ),
          );
        }
        if (opened) {
          for (const line of contextLines(range.newEnd + 1, endLine)) {
            rendered.push(renderContext(line.lineNo, line.code, `ctx-bottom-${group.hunk}-${line.lineNo}`));
          }
        }
      }
      return h(
        'div',
        { className: props.wrap ? 'prr-wrap' : '' },
        rendered,
        parsed.dropped > 0
          ? h('div', { className: 'prr-zero' }, `… ${parsed.dropped}`)
          : null,
      );
    }

    function RiskList(props) {
      const list = props.risks ?? [];
      if (list.length === 0) return h('div', { className: 'prr-subtle' }, '—');
      return h(
        'div',
        null,
        list.map((risk, index) =>
          h(
            'div',
            { className: 'prr-rowitem', key: index },
            h(VerdictPill, { verdict: risk.severity, t: props.t }),
            h(
              'div',
              { className: 'prr-rowmain' },
              risk.file === ''
                ? null
                : h(
                    'button',
                    {
                      type: 'button',
                      className: 'prr-linklike prr-filetag',
                      onClick: () => props.onOpenFile(risk.file),
                      title: risk.file,
                    },
                    risk.file,
                  ),
              h('div', { className: 'prr-text' }, risk.point),
            ),
          ),
        ),
      );
    }

    function OrderList(props) {
      const list = props.order ?? [];
      if (list.length === 0) return h('div', { className: 'prr-subtle' }, '—');
      return h(
        'div',
        null,
        list.map((item, index) =>
          h(
            'div',
            { className: 'prr-rowitem', key: item.file + index },
            h('span', { className: 'prr-ford' }, String(index + 1)),
            h(
              'div',
              { className: 'prr-rowmain' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'prr-linklike prr-filetag',
                  onClick: () => props.onOpenFile(item.file),
                  title: item.file,
                },
                item.file,
              ),
              item.reason === ''
                ? null
                : h('div', { className: 'prr-subtle prr-text' }, item.reason),
            ),
          ),
        ),
      );
    }

    function ConclusionBlock(props) {
      const conclusion = props.conclusion;
      if (conclusion === null || conclusion === undefined) return null;
      const states = props.feedbackStates ?? {};
      const section = (title, items, withVerdict, kind) => {
        const list = items ?? [];
        if (list.length === 0) return null;
        return h(
          'div',
          null,
          h('div', { className: 'prr-h2' }, title),
          h(
            'div',
            { className: 'prr-card' },
            list.map((item, index) => {
              const idKey = typeof item.id === 'string' && item.id !== '' ? item.id : '';
              const pointKey = findingKey(kind, item.file ?? '', item.point ?? '');
              const state = states[idKey] ?? states[pointKey] ?? null;
              const itemLine = Number.isFinite(item.line) && item.line > 0 ? Math.floor(item.line) : 0;
              const fileLabel = fileLineLabel(item.file, itemLine);
              return h(
                'div',
                { className: 'prr-rowitem', key: index },
                withVerdict === true ? h(VerdictPill, { verdict: 'block', t: props.t }) : null,
                h(
                  'div',
                  { className: 'prr-rowmain' },
                  item.file === ''
                    ? null
                    : h(
                        'button',
                        {
                          type: 'button',
                          className: 'prr-linklike prr-filetag',
                          onClick: () => props.onOpenFile(item.file, itemLine),
                          title: fileLabel,
                        },
                        fileLabel,
                      ),
                  h(
                    'div',
                    { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
                    h('div', { className: 'prr-text', style: { flex: 1 } }, item.point),
                    state === null
                      ? null
                      : h(
                          'span',
                          { className: 'prr-fb-pill', 'data-status': state.status, title: state.reason ?? '' },
                          props.t(FEEDBACK_LABEL_KEYS[state.status] ?? 'fbQuestion'),
                        ),
                  ),
                  state === null || state.reason === '' ? null : h('div', { className: 'prr-fb-reason' }, state.reason),
                ),
              );
            }),
          ),
        );
      };
      const nextSteps = conclusion.nextSteps ?? [];
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'prr-conclusion-head' },
          h('span', { className: 'prr-h2', style: { margin: 0 } }, props.t('conclusion')),
          props.headerExtra ?? null,
        ),
        h(
          'div',
          { className: 'prr-card' },
          h(
            'div',
            { className: 'prr-verdictline' },
            h(VerdictPill, { verdict: conclusion.verdict, t: props.t }),
          ),
          h('div', { className: 'prr-text' }, conclusion.summary),
          props.metaLine === undefined || props.metaLine === null
            ? null
            : h('div', { className: 'prr-conclusion-meta' }, props.metaLine),
        ),
        section(props.t('blockers'), conclusion.blockers, true, 'blocker'),
        section(props.t('suggestions'), conclusion.suggestions, false, 'suggestion'),
        nextSteps.length === 0
          ? null
          : h(
              'div',
              { className: 'prr-card' },
              h('div', { className: 'prr-h2', style: { marginTop: 0 } }, props.t('nextSteps')),
              nextSteps.map((step, index) =>
                h('div', { className: 'prr-rowitem', key: index }, h('div', { className: 'prr-rowmain prr-text' }, step)),
              ),
            ),
      );
    }

    /**
     * True when a published entry already covers this round's newest conclusion version.
     * Legacy records predate version tracking, so version 0 counts as published.
     */
    function isRoundVersionPublished(published, roundNumber, version) {
      const list = Array.isArray(published) ? published : [];
      return list.some((entry) => {
        if (entry === null || entry === undefined) return false;
        const entryRound = typeof entry.round === 'number' ? entry.round : roundNumber;
        if (entryRound !== roundNumber) return false;
        const entryVersion = typeof entry.version === 'number' ? entry.version : 0;
        return entryVersion <= 0 || entryVersion === version;
      });
    }

    /**
     * One round pill for the top bar: the latest round reuses the live status text/tone, a
     * historical round reports when its newest conclusion was generated (or that it has none).
     */
    function roundPillOf(round, latestRoundNumber, latestText, latestTone, published, t) {
      const roundNumber = typeof round?.round === 'number' ? round.round : 0;
      const versions = versionsOf(null, round, false);
      const newest = versions.length === 0 ? null : versions[versions.length - 1];
      // A generated conclusion that never reached the PR gets a small "unpublished" tag.
      const unpublished = newest !== null
        && isRoundVersionPublished(published, roundNumber, newest.version) === false;
      if (roundNumber === latestRoundNumber) {
        return {
          round: roundNumber,
          text: latestText,
          tone: latestTone,
          isLatest: true,
          unpublished,
        };
      }
      if (newest === null) {
        return {
          round: roundNumber,
          text: fill(t('roundHistoryNoConclusion'), { round: roundNumber }),
          tone: 'idle',
          isLatest: false,
          unpublished: false,
        };
      }
      const stamp = formatClock(newest.createdAt);
      if (stamp === '') {
        return {
          round: roundNumber,
          text: fill(t('roundHistoryNoConclusion'), { round: roundNumber }),
          tone: 'idle',
          isLatest: false,
          unpublished,
        };
      }
      return {
        round: roundNumber,
        text: fill(t('roundHistoryDone'), { round: roundNumber, time: stamp }),
        tone: 'done',
        isLatest: false,
        unpublished,
      };
    }

    /**
     * Top-bar round strip: clickable status pills (reusing the round chip styling) with the
     * latest round tagged. Long histories scroll horizontally so the action buttons stay put.
     */
    function RoundPills(props) {
      const {
        rounds,
        selectedRoundNumber,
        latestRoundNumber,
        latestText,
        latestTone,
        published,
        onSelect,
        t,
      } = props;
      if (!Array.isArray(rounds) || rounds.length === 0) return null;
      const pills = rounds.map((round) =>
        roundPillOf(round, latestRoundNumber, latestText, latestTone, published, t));
      return h(
        'div',
        { className: 'prr-roundpills', role: 'tablist', 'aria-label': t('roundTabsLabel') },
        h(
          'div',
          { className: 'prr-roundpills-scroll' },
          pills.map((pill) =>
            h(
              'button',
              {
                key: pill.round,
                type: 'button',
                role: 'tab',
                className: 'prr-round prr-roundpill',
                'data-tone': pill.tone,
                'data-active': selectedRoundNumber === pill.round ? 'true' : 'false',
                title: pill.text,
                onClick: () => onSelect(pill.round),
              },
              pill.text,
              pill.unpublished
                ? h(
                    'span',
                    {
                      className: 'prr-roundtab-tag prr-roundtag-unpublished',
                      title: t('unpublishedHint'),
                    },
                    t('unpublishedTag'),
                  )
                : null,
              pill.isLatest
                ? h('span', { className: 'prr-roundtab-tag' }, t('roundLatestTag'))
                : null,
            ),
          ),
        ),
      );
    }

    /** Detail header row: the pane title plus an optional trailing control (narrow toggle). */
    function DetailHeader(props) {
      const { t, extra } = props;
      return h(
        'div',
        { className: 'prr-detail-head' },
        h('span', { className: 'prr-detail-title' }, t('detailTitle')),
        h('span', { className: 'prr-spacer' }),
        extra === undefined ? null : extra,
      );
    }

    /**
     * Top bar: PR picker, clickable round pills, and the list/review/close actions.
     * The repository meta line was removed; the refresh tooltip still shows the last poll.
     */
    function TopBar(props) {
      const {
        t,
        prNumber,
        pullOptions,
        onSelectPr,
        prSelectDisabled,
        showRounds,
        rounds,
        selectedRoundNumber,
        latestRoundNumber,
        latestRoundText,
        latestRoundTone,
        onSelectRound,
        published,
        listBusy,
        lastPoll,
        onRefresh,
        reviewLabel,
        reviewHint,
        reviewDisabled,
        onReview,
        onClose,
        showTitle,
      } = props;
      return h(
        'div',
        { className: 'prr-top' },
        showTitle === false ? null : h('span', { className: 'prr-title' }, t('title')),
        h(
          'select',
          {
            className: 'prr-select',
            value: prNumber === null || prNumber === undefined ? '' : String(prNumber),
            disabled: prSelectDisabled === true,
            onChange: (event) => {
              const next = Number(event.target.value);
              onSelectPr(Number.isFinite(next) && next > 0 ? next : null);
            },
          },
          pullOptions,
        ),
        showRounds === true
          ? h(RoundPills, {
              rounds,
              selectedRoundNumber,
              latestRoundNumber,
              latestText: latestRoundText,
              latestTone: latestRoundTone,
              published,
              onSelect: onSelectRound,
              t,
            })
          : null,
        h('span', { className: 'prr-spacer' }),
        h(Btn, {
          label: listBusy ? t('refreshing') : t('refresh'),
          title: t('refreshHint').replace('{time}', lastPoll ?? ''),
          small: true,
          disabled: listBusy === true,
          onClick: onRefresh,
        }),
        h(Btn, {
          label: reviewLabel,
          title: reviewHint,
          primary: true,
          small: true,
          disabled: reviewDisabled === true,
          onClick: onReview,
        }),
        typeof onClose === 'function'
          ? h(Btn, { label: t('overlayClose'), small: true, onClick: onClose })
          : null,
      );
    }

    /** Conclusion version selector for one round; only shown when more than one version exists. */
    function VersionSelector(props) {
      const { versions, selectedVersion, onSelect, t } = props;
      if (!Array.isArray(versions) || versions.length <= 1) return null;
      const latestVersion = versions[versions.length - 1].version;
      return h(
        'select',
        {
          className: 'prr-select prr-select-sm',
          value: selectedVersion === null || selectedVersion === undefined ? '' : String(selectedVersion),
          title: t('versionPickerTitle'),
          'aria-label': t('versionPickerTitle'),
          onChange: (event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next)) onSelect(next);
          },
        },
        versions.map((version) =>
          h(
            'option',
            { key: version.version, value: version.version },
            `${fill(t('versionOption'), { version: version.version })}${version.version === latestVersion ? t('versionLatestTag') : ''} · ${t(version.source === 'human' ? 'versionSourceHuman' : 'versionSourceModel')}`,
          ),
        ),
      );
    }

    /** Metadata line for a historical round: commit hash, start and finish. */
    function RoundMeta(props) {
      const { round, t } = props;
      const started = formatStamp(round?.startedAt);
      const finished = formatStamp(round?.finishedAt);
      return h(
        'div',
        { className: 'prr-roundmeta' },
        h('span', null, fill(t('roundMetaRound'), { round: round?.round ?? 1 })),
        h('code', null, fill(t('roundMetaHead'), { sha: shortSha(round?.headSha) })),
        started === '' ? null : h('span', null, fill(t('roundMetaStarted'), { time: started })),
        finished === '' ? null : h('span', null, fill(t('roundMetaFinished'), { time: finished })),
      );
    }

    /** Comparison between the previous and this round. */
    function DeltaBlock(props) {
      const { delta, t } = props;
      if (delta === null || delta === undefined) return null;
      const resolved = Array.isArray(delta.resolved) ? delta.resolved : [];
      const stillOpen = Array.isArray(delta.stillOpen) ? delta.stillOpen : [];
      const describe = (item) => `${text(item?.file) === '' ? '' : `${item.file} — `}${text(item?.point)}`;
      return h(
        'div',
        null,
        h('div', { className: 'prr-h2' }, t('deltaTitle')),
        h(
          'div',
          { className: 'prr-card' },
          h(
            'div',
            { className: 'prr-subtle' },
            `${t('deltaTitle')} · #${delta.previousRound ?? '?'} → #${delta.round ?? '?'}：${t('deltaResolved')} ${resolved.length} · ${t('deltaStillOpen')} ${stillOpen.length}`,
          ),
          resolved.length === 0
            ? null
            : h(
                'ul',
                { className: 'prr-delta-list' },
                resolved.map((item, index) =>
                  h('li', { key: `r-${index}` }, `${t('deltaResolved')}：${describe(item)}`),
                ),
              ),
          stillOpen.length === 0
            ? null
            : h(
                'ul',
                { className: 'prr-delta-list' },
                stillOpen.map((item, index) =>
                  h('li', { key: `s-${index}` }, `${t('deltaStillOpen')}：${describe(item)}`),
                ),
              ),
        ),
      );
    }

    /** Inline markdown for platform text: code, bold, italic and http(s) links only. */
    function inlineMarkdown(source) {
      const nodes = [];
      const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))|(\*[^*\n]+\*)/g;
      let last = 0;
      let match = pattern.exec(source);
      while (match !== null) {
        if (match.index > last) nodes.push(source.slice(last, match.index));
        const token = match[0];
        if (token.startsWith('`')) {
          nodes.push(h('code', { key: nodes.length }, token.slice(1, -1)));
        } else if (token.startsWith('**')) {
          nodes.push(h('strong', { key: nodes.length }, token.slice(2, -2)));
        } else if (token.startsWith('[')) {
          const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(token);
          nodes.push(link === null
            ? token
            : h('a', { key: nodes.length, href: link[2], target: '_blank', rel: 'noreferrer' }, link[1]));
        } else {
          nodes.push(h('em', { key: nodes.length }, token.slice(1, -1)));
        }
        last = match.index + token.length;
        match = pattern.exec(source);
      }
      if (last < source.length) nodes.push(source.slice(last));
      return nodes.length === 0 ? [source] : nodes;
    }

    /**
     * Minimal markdown renderer for text copied from the code platform (comments): headings,
     * lists, quotes, code fences, rules and paragraphs. It builds React nodes only, so platform
     * text is never injected as HTML — markup such as `<script>` stays literal.
     */
    function renderMarkdown(source) {
      const raw = typeof source === 'string' ? source.replace(/\r\n?/g, '\n') : '';
      if (raw.trim() === '') return null;
      const blocks = [];
      let paragraph = [];
      let list = null;
      let fence = null;
      const flushParagraph = () => {
        if (paragraph.length === 0) return;
        blocks.push(h('p', { key: `p${blocks.length}` }, inlineMarkdown(paragraph.join(' '))));
        paragraph = [];
      };
      const flushList = () => {
        if (list === null) return;
        blocks.push(h(
          list.ordered ? 'ol' : 'ul',
          { key: `l${blocks.length}`, className: 'prr-md-list' },
          list.items.map((item, index) => h('li', { key: index }, inlineMarkdown(item))),
        ));
        list = null;
      };
      for (const line of raw.split('\n')) {
        if (fence !== null) {
          if (/^\s*```/.test(line)) {
            blocks.push(h('pre', { key: `c${blocks.length}` }, fence.join('\n')));
            fence = null;
          } else {
            fence.push(line);
          }
          continue;
        }
        if (/^\s*```/.test(line)) {
          flushParagraph();
          flushList();
          fence = [];
          continue;
        }
        if (/^\s*$/.test(line)) {
          flushParagraph();
          flushList();
          continue;
        }
        if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
          flushParagraph();
          flushList();
          blocks.push(h('hr', { key: `h${blocks.length}` }));
          continue;
        }
        const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
        if (heading !== null) {
          flushParagraph();
          flushList();
          blocks.push(h(
            `h${Math.min(3, heading[1].length)}`,
            { key: `t${blocks.length}`, className: 'prr-md-h' },
            inlineMarkdown(heading[2]),
          ));
          continue;
        }
        const quote = /^\s*>\s?(.*)$/.exec(line);
        if (quote !== null) {
          flushParagraph();
          flushList();
          blocks.push(h('blockquote', { key: `q${blocks.length}` }, inlineMarkdown(quote[1])));
          continue;
        }
        const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
        if (ordered !== null) {
          flushParagraph();
          if (list === null || list.ordered !== true) {
            flushList();
            list = { ordered: true, items: [] };
          }
          list.items.push(ordered[1]);
          continue;
        }
        const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
        if (bullet !== null) {
          flushParagraph();
          if (list === null || list.ordered !== false) {
            flushList();
            list = { ordered: false, items: [] };
          }
          list.items.push(bullet[1]);
          continue;
        }
        flushList();
        paragraph.push(line.trim());
      }
      if (fence !== null) blocks.push(h('pre', { key: `c${blocks.length}` }, fence.join('\n')));
      flushParagraph();
      flushList();
      return blocks.length === 0 ? null : h('div', { className: 'prr-md' }, blocks);
    }

    /** Developer feedback on the published comment of the previous round. */
    function FeedbackBlock(props) {
      const { feedback, t, canCheck, onCheckFeedback, feedbackBusy, hasBaseline } = props;
      const comments = Array.isArray(feedback?.comments) ? feedback.comments : [];
      const notes = Array.isArray(feedback?.notes) ? feedback.notes : [];
      const emptyText = hasBaseline === true ? t('feedbackEmpty') : t('feedbackNoBaseline');
      return h(
        'div',
        null,
        h(
          'div',
          { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
          h('div', { className: 'prr-h2', style: { margin: 0 } }, t('feedbackTitle')),
          canCheck === true
            ? h(Btn, {
                label: feedbackBusy ? t('feedbackChecking') : t('feedbackCheck'),
                small: true,
                disabled: feedbackBusy === true,
                onClick: onCheckFeedback,
              })
            : null,
        ),
        comments.length === 0 && notes.length === 0
          ? h('div', { className: 'prr-subtle', style: { marginTop: '6px' } }, emptyText)
          : h(
              'div',
              { className: 'prr-card', style: { marginTop: '6px' } },
              comments.map((comment, index) =>
                h(
                  'div',
                  { className: 'prr-fb-comment', key: comment.id ?? index },
                  h('div', { className: 'prr-fb-meta' }, `${comment.author} · ${comment.createdAt}`),
                  h(
                    'div',
                    { className: 'prr-fb-body' },
                    renderMarkdown(comment.body) ?? h('span', null, text(comment.body)),
                  ),
                ),
              ),
              notes.map((note, index) =>
                h('div', { className: 'prr-fb-reason', key: `note-${index}` }, note),
              ),
            ),
      );
    }

    /** Published review comments that belong to one round. */
    function PublishedBlock(props) {
      const { entries, t } = props;
      if (!Array.isArray(entries) || entries.length === 0) return null;
      return h(
        'div',
        null,
        h('div', { className: 'prr-h2' }, t('publishedTitle')),
        h(
          'div',
          { className: 'prr-card' },
          entries.map((entry, index) =>
            h(
              'div',
              { className: 'prr-rowitem', key: entry.id ?? index },
              h(
                'div',
                { className: 'prr-rowmain' },
                h(
                  'div',
                  { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
                  h(
                    'span',
                    { className: 'prr-subtle' },
                    [
                      typeof entry.round === 'number' ? `#${entry.round}` : '',
                      typeof entry.version === 'number'
                        ? fill(t('publishedVersion'), { version: entry.version })
                        : '',
                      typeof entry.publishedAt === 'number' && entry.publishedAt > 0
                        ? formatClock(entry.publishedAt)
                        : '',
                    ]
                      .filter((part) => part !== '')
                      .join(' · '),
                  ),
                  typeof entry.url === 'string' && entry.url !== ''
                    ? h(
                        'a',
                        {
                          className: 'prr-linklike',
                          style: { width: 'auto', fontSize: '12px' },
                          href: entry.url,
                          target: '_blank',
                          rel: 'noreferrer',
                        },
                        t('commentLink'),
                      )
                    : null,
                ),
              ),
            ),
          ),
        ),
      );
    }

    /**
     * Expanded body of the stale warning: which files (and the report) changed after the latest
     * conclusion, plus the analysis-coverage line when both apply.
     */
    function staleDetailOf(info, coverageIncomplete, autoReconclude, t) {
      const shown = info.files.slice(0, 5);
      const more = info.files.length - shown.length;
      return h(
        React.Fragment,
        null,
        info.reportNewer === true ? h('div', { className: 'prr-dock-tip' }, t('staleReport')) : null,
        shown.length === 0
          ? null
          : h(
              'ul',
              null,
              shown.map((file) => h('li', { key: file }, file)),
            ),
        more > 0 ? h('div', { className: 'prr-dock-tip' }, fill(t('staleMore'), { count: more })) : null,
        coverageIncomplete === true ? h('div', { className: 'prr-dock-tip' }, t('coverageIncomplete')) : null,
        autoReconclude === true ? h('div', { className: 'prr-dock-tip' }, t('autoReconcludeOn')) : null,
      );
    }

    /** Inline generation progress (stage text) with a cancel button. */
    function ConcludingProgress(props) {
      const { concluding, t, onCancel, cancelBusy } = props;
      const stageKey = typeof concluding?.stage === 'string' ? STAGE_KEY[concluding.stage] : undefined;
      return h(
        'div',
        { className: 'prr-progress' },
        h('span', { className: 'prr-spinner' }),
        h('span', null, stageKey === undefined
          ? t('concluding')
          : fill(t('concludingStage'), { stage: t(stageKey) })),
        h(Btn, {
          label: cancelBusy === true ? t('cancelBusy') : t('cancel'),
          small: true,
          disabled: cancelBusy === true,
          onClick: onCancel,
        }),
      );
    }

    /** Publish preview dialog: exact markdown, language note, per-item selection, confirm/cancel. */
    function PublishPreviewModal(props) {
      const { preview, t, busy, error, onConfirm, onCancel } = props;
      const language = preview?.language === 'en' ? 'en' : 'zh';
      const conflict = typeof preview?.conflict === 'string' ? preview.conflict : '';
      const items = Array.isArray(preview?.items) ? preview.items : [];
      const selectionSupported = preview?.selectionSupported === true;
      const selectedCount = Array.isArray(preview?.selectedIds) ? preview.selectedIds.length : 0;
      const nothingSelected = selectionSupported === true && selectedCount === 0;
      const selectedIds = Array.isArray(preview?.selectedIds) ? preview.selectedIds : [];
      const selected = new Set(selectedIds);
      const refreshing = props.refreshing === true;
      const toggleItem = typeof props.onToggleItem === 'function' ? props.onToggleItem : () => {};
      const selectAll = typeof props.onSelectAll === 'function' ? props.onSelectAll : () => {};
      const selectNone = typeof props.onSelectNone === 'function' ? props.onSelectNone : () => {};
      const title = preview !== null && preview !== undefined && typeof preview.round === 'number'
        ? fill(t('previewRoundMeta'), {
            round: preview.round,
            version: typeof preview.version === 'number' ? preview.version : 1,
          })
        : t('previewTitle');
      const itemList = selectionSupported
        ? h(
            'div',
            { className: 'prr-preview-items' },
            h(
              'div',
              { className: 'prr-preview-items-head' },
              h(
                'span',
                { className: 'prr-preview-items-title' },
                `${t('previewItems')} · ${fill(t('previewItemsCount'), {
                  selected: selectedIds.length,
                  total: items.length,
                })}`,
              ),
              h(Btn, {
                label: t('selectAll'),
                small: true,
                disabled: selectedIds.length >= items.length,
                onClick: selectAll,
              }),
              h(Btn, {
                label: t('selectNone'),
                small: true,
                disabled: selectedIds.length === 0,
                onClick: selectNone,
              }),
            ),
            items.map((item) =>
              h(
                'label',
                { className: 'prr-preview-item', key: item.id },
                h('input', {
                  type: 'checkbox',
                  checked: selected.has(item.id),
                  onChange: () => toggleItem(item.id),
                }),
                h(
                  'div',
                  { className: 'prr-preview-item-body' },
                  h(
                    'div',
                    { className: 'prr-preview-item-meta' },
                    h(
                      'span',
                      { className: 'prr-tag' },
                      t(item.kind === 'suggestion' ? 'suggestions' : 'blockers'),
                    ),
                    item.file === ''
                      ? null
                      : h(
                          'span',
                          { className: 'prr-filetag', title: fileLineLabel(item.file, item.line) },
                          fileLineLabel(item.file, item.line),
                        ),
                  ),
                  h('div', { className: 'prr-preview-item-text' }, item.point),
                ),
              ),
            ),
          )
        : h('div', { className: 'prr-modal-note' }, t('previewFullFallback'));
      return h(
        'div',
        { className: 'prr-modal-backdrop', onClick: onCancel },
        h(
          'div',
          {
            className: 'prr-modal',
            role: 'dialog',
            'aria-label': t('previewTitle'),
            onClick: (event) => event.stopPropagation(),
          },
          h(
            'div',
            { className: 'prr-modal-head' },
            h('span', { className: 'prr-modal-title' }, title),
            h('button', {
              type: 'button',
              className: 'prr-float-close',
              title: t('close'),
              onClick: onCancel,
            }, '✕'),
          ),
          h(
            'div',
            { className: 'prr-modal-body' },
            h(
              'div',
              { className: 'prr-modal-note' },
              `${language === 'en' ? t('previewLanguageEn') : t('previewLanguageZh')} · ${t('previewLanguageNote')}`,
            ),
            itemList,
            selectionSupported
              ? h('div', { className: 'prr-modal-note' }, t('previewItemsHint'))
              : null,
            nothingSelected
              ? h('div', { className: 'prr-modal-warn' }, t('previewSelectNoneHint'))
              : null,
            refreshing ? h('div', { className: 'prr-preview-refreshing' }, t('previewRefreshing')) : null,
            h('pre', { className: 'prr-markdown' }, text(preview?.markdown)),
            conflict === 'already-published'
              ? h('div', { className: 'prr-modal-warn' }, t('alreadyPublished'))
              : null,
            conflict === 'publishing'
              ? h('div', { className: 'prr-modal-warn' }, t('publishingBusy'))
              : null,
            error === '' || error === undefined || error === null
              ? null
              : h('div', { className: 'prr-modal-error' }, error),
          ),
          h(
            'div',
            { className: 'prr-modal-foot' },
            h(Btn, { label: t('cancel'), onClick: onCancel }),
            conflict === 'already-published'
              ? h(Btn, {
                  label: t('previewConfirmAppend'),
                  primary: true,
                  disabled: busy === true || refreshing === true || nothingSelected === true,
                  onClick: () => onConfirm(true),
                })
              : h(Btn, {
                  label: busy === true
                    ? t('publishing')
                    : (conflict === 'publishing' ? t('retry') : t('previewConfirm')),
                  primary: true,
                  disabled: busy === true || refreshing === true || nothingSelected === true,
                  onClick: () => onConfirm(false),
                }),
          ),
        ),
      );
    }

    /** One-line conclusion metadata: round, version, generated time, coverage, human/published. */
    function conclusionMetaLine(review, roundNumber, version, publishedEntries, isCurrent, t) {
      const parts = [fill(t('metaRound'), { round: roundNumber })];
      parts.push(fill(t('versionOption'), { version: version.version }));
      const rawCreated = version.createdAt ?? review?.conclusionAt ?? 0;
      const stamp = formatClock(typeof rawCreated === 'number' ? rawCreated : 0);
      if (stamp !== '') parts.push(fill(t('metaGeneratedAt'), { time: stamp }));
      const coverage = version.coverage ?? review?.coverage ?? null;
      if (
        coverage !== null
        && coverage !== undefined
        && typeof coverage.total === 'number'
        && coverage.total > 0
      ) {
        parts.push(
          fill(t('metaCoverage'), {
            analyzed: typeof coverage.analyzed === 'number' ? coverage.analyzed : 0,
            total: coverage.total,
          }),
        );
      }
      const humanEdited = version.source === 'human'
        || (isCurrent === true
          && (review?.conclusionEditedAt ?? 0) > (typeof version.createdAt === 'number' ? version.createdAt : 0));
      if (humanEdited) parts.push(t('metaHumanEdited'));
      const published = publishedEntries.some(
        (entry) => typeof entry.version !== 'number' || entry.version === version.version,
      );
      if (published) parts.push(t('metaPublished'));
      return parts.join(' · ');
    }

    /**
     * Whole-review footer: the conclusion/publish actions plus the coverage and staleness
     * notices. Rendered above the composer (session takeover or embedded footer), never inside
     * the overview scroll, so it stays reachable while reading. Returns nulls for historical
     * rounds and for a round without a report — nothing to act on or qualify there.
     */
    function overviewFooter(props, derived) {
      const { report, pull, selectedVersion, staleInfo, isCurrent, isOlderVersion } = derived;
      const t = props.t;
      const review = props.review;
      if (report === null || report === undefined || isCurrent !== true) {
        return { actions: null, notice: null };
      }
      const link = typeof pull.url === 'string' && pull.url !== ''
        ? h(
            'a',
            {
              className: 'prr-btn prr-btn-sm',
              href: pull.url,
              target: '_blank',
              rel: 'noreferrer',
              style: { textDecoration: 'none', display: 'inline-flex', alignItems: 'center' },
            },
            t('openPlatform'),
          )
        : null;
      const concludeLabel = staleInfo !== null ? t('reconclude') : t('conclude');
      const progressActive = props.concluding !== null && props.concluding !== undefined;
      const actions = h(
        'div',
        { className: 'prr-actions' },
        progressActive === true || props.concludeBusy === true
          ? h(ConcludingProgress, {
              concluding: progressActive === true ? props.concluding : null,
              t,
              cancelBusy: props.cancelBusy,
              onCancel: props.onCancelConclude,
            })
          : h(Btn, {
              label: props.concludeBusy ? t('concluding') : concludeLabel,
              primary: true,
              disabled: props.concludeBusy === true || props.reviewBusy === true,
              onClick: props.onConclude,
            }),
        selectedVersion === null
          ? null
          : h(Btn, {
              label: props.publishBusy === true || review.publishing === true
                ? t('publishing')
                : (props.previewBusy === true ? t('previewLoading') : t('publishComment')),
              disabled: props.publishBusy === true || props.previewBusy === true
                || review.publishing === true || isOlderVersion === true,
              title: isOlderVersion === true ? t('publishOlderHint') : undefined,
              onClick: props.onPublish,
            }),
        props.comment !== null && props.comment !== undefined && typeof props.comment.url === 'string' && props.comment.url !== ''
          ? h(
              'a',
              {
                className: 'prr-btn prr-btn-sm',
                href: props.comment.url,
                target: '_blank',
                rel: 'noreferrer',
                style: { textDecoration: 'none', display: 'inline-flex', alignItems: 'center' },
              },
              t('commentLink'),
            )
          : null,
        link,
      );
      const coverageMissing = (props.explainedCount ?? 0) < (props.totalFiles ?? 0);
      // One collapsible panel in the dock: the coverage line merges into the stale warning when
      // both apply, and the whole thing folds to a single summary row. The action button does not
      // repeat the count.
      const notice = staleInfo !== null
        ? {
            tone: 'warn',
            summary: fill(t('staleSummary'), { count: staleInfo.count }),
            detail: staleDetailOf(staleInfo, coverageMissing === true, props.autoReconclude === true, t),
          }
        : (coverageMissing === true
            ? { tone: 'note', summary: t('coverageIncomplete'), detail: null }
            : null);
      return { actions, notice };
    }

    /**
     * PR-level overview: round tabs first, then (round >= 2) the round comparison and
     * developer feedback, then this round's report/conclusion/publish area and actions.
     * Historical rounds render read-only meta + delta + feedback + conclusion + published comments.
     */
    function OverviewPanel(props) {
      const { review, t } = props;
      const report = review.report;
      const rounds = React.useMemo(() => roundsOf(review), [review]);
      const latestRound = rounds.length === 0 ? null : rounds[rounds.length - 1];
      const latestRoundNumber = latestRound === null ? null : latestRound.round;
      const requestedRound = typeof props.selectedRoundNumber === 'number' ? props.selectedRoundNumber : null;
      const selectedRound = requestedRound === null
        ? latestRound
        : (rounds.find((entry) => entry.round === requestedRound) ?? latestRound);
      const roundNumber = selectedRound === null ? 1 : selectedRound.round;
      const isCurrent = latestRound === null || selectedRound === null || selectedRound.round === latestRound.round;
      const versions = React.useMemo(
        () => versionsOf(review, selectedRound, isCurrent),
        [review, selectedRound, isCurrent],
      );
      const latestVersion = versions.length === 0 ? null : versions[versions.length - 1];
      const versionPick = props.versionPick ?? {};
      const pickedVersion = typeof versionPick[roundNumber] === 'number' ? versionPick[roundNumber] : null;
      const selectedVersion = versions.find((entry) => entry.version === pickedVersion) ?? latestVersion;
      const isOlderVersion = selectedVersion !== null
        && latestVersion !== null
        && selectedVersion.version !== latestVersion.version;
      const publishedEntries = publishedOfRound(review, roundNumber);
      const entryDelta = selectedRound === null ? null : selectedRound.delta ?? null;
      const entryFeedback = selectedRound === null ? null : selectedRound.feedback ?? null;
      const delta = isCurrent ? (review.delta ?? entryDelta) : entryDelta;
      const feedback = isCurrent ? (review.feedback ?? entryFeedback) : entryFeedback;
      const feedbackStates = (feedback !== null && feedback !== undefined ? feedback.states : null) ?? {};
      const staleInfo = React.useMemo(
        () => (isCurrent ? staleInfoOf(review, versionsOf(review, selectedRound, true)) : null),
        [isCurrent, review, selectedRound],
      );
      // Round >= 2 pins the developer feedback first, then the round comparison. Feedback
      // answers the PREVIOUS round's published comment, so this round does not need to be
      // published before it can be read.
      const anyPublished = Array.isArray(review.published) && review.published.length > 0;
      const roundTop = roundNumber >= 2
        ? h(
            React.Fragment,
            null,
            h(FeedbackBlock, {
              feedback,
              t,
              canCheck: isCurrent === true && anyPublished === true,
              hasBaseline: anyPublished === true,
              feedbackBusy: props.feedbackBusy,
              onCheckFeedback: props.onCheckFeedback,
            }),
            h(DeltaBlock, { delta, t }),
          )
        : null;
      const versionHeader = h(
        React.Fragment,
        null,
        h(VersionSelector, {
          versions,
          selectedVersion: selectedVersion === null ? null : selectedVersion.version,
          onSelect: (version) => props.onPickVersion(
            roundNumber,
            version,
            latestVersion === null ? version : latestVersion.version,
          ),
          t,
        }),
        selectedVersion === null
          ? null
          : h(
              'span',
              { className: 'prr-tag' },
              t(selectedVersion.source === 'human' ? 'versionSourceHuman' : 'versionSourceModel'),
            ),
        isOlderVersion === true ? h('span', { className: 'prr-tag' }, t('versionReadOnly')) : null,
      );
      const conclusionNode = selectedVersion === null
        ? h('div', { className: 'prr-subtle' }, t('historyNoConclusion'))
        : h(ConclusionBlock, {
            conclusion: selectedVersion.conclusion,
            t,
            onOpenFile: props.onOpenFile,
            feedbackStates,
            headerExtra: versionHeader,
            metaLine: conclusionMetaLine(review, roundNumber, selectedVersion, publishedEntries, isCurrent, t),
          });

      const pull = review.pull ?? {};
      // The whole-review footer (conclusion/publish actions plus the coverage and staleness
      // notices) is rendered above the composer by whichever surface owns it: the session
      // composer takeover or the embedded footer. Both read it from `actionsBridge`.
      const footer = overviewFooter(props, {
        report, pull, selectedVersion, staleInfo, isCurrent, isOlderVersion,
      });
      React.useEffect(() => {
        actionsBridge.set(footer.actions);
        actionsBridge.setNotice(footer.notice);
        return undefined;
      }, [footer.actions, footer.notice]);
      // Leaving the overview must clear the dock instead of leaving stale buttons behind.
      React.useEffect(() => () => {
        actionsBridge.set(null);
        actionsBridge.setNotice(null);
      }, []);

      // The current round needs a report before anything renders; a historical round keeps
      // its own conclusion/delta/feedback even though `record.report` is reset on a new round.
      if ((report === null || report === undefined) && isCurrent) {
        return h(
          'div',
          null,
          h('div', { className: 'prr-zero' }, review.status === 'reviewing' ? t('reportPending') : t('noReport')),
        );
      }

      // Historical rounds are read-only: meta, delta/feedback (round >= 2), conclusion, published.
      if (!isCurrent) {
        return h(
          'div',
          null,
          h(RoundMeta, { round: selectedRound, t }),
          roundTop,
          conclusionNode,
          h(PublishedBlock, { entries: publishedEntries, t }),
          h('div', { className: 'prr-subtle', style: { marginTop: '10px' } }, t('historyReadOnly')),
        );
      }

      return h(
        'div',
        null,
        roundTop,
        h('div', { className: 'prr-h2' }, t('summary')),
        h(
          'div',
          { className: 'prr-card' },
          h(
            'div',
            { className: 'prr-verdictline' },
            h(VerdictPill, { verdict: report.verdict, t }),
            h('span', { className: 'prr-meta2' }, `#${review.number} ${text(pull.title)}`),
          ),
          h(
            'div',
            { className: 'prr-subtle', style: { marginBottom: '8px' } },
            `${text(pull.author)} · ${text(pull.headRef)} → ${text(pull.baseRef)} · +${pull.additions ?? 0} / -${pull.deletions ?? 0} · ${pull.changedFiles ?? 0}`,
          ),
          h('div', { className: 'prr-text' }, report.summary),
        ),
        h('div', { className: 'prr-h2' }, t('initialRisks')),
        h('div', { className: 'prr-card' }, h(RiskList, { risks: report.risks, t, onOpenFile: props.onOpenFile })),
        h(
          'div',
          { className: 'prr-h2' },
          `${t('fileFindings')} · ${t('explainedOf')} ${props.explainedCount ?? 0}/${props.totalFiles ?? 0}`,
        ),
        h(
          'div',
          { className: 'prr-card' },
          (props.fileFindings ?? []).length === 0
            ? h('div', { className: 'prr-subtle' }, t('noFileFindings'))
            : (props.fileFindings ?? []).map((group) =>
                h(
                  'div',
                  { className: 'prr-finding-file', key: group.file },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'prr-linklike prr-filetag',
                      onClick: () => props.onOpenFile(group.file),
                      title: group.file,
                    },
                    group.file,
                  ),
                  (group.issues ?? []).map((issue, index) =>
                    h(
                      'div',
                      { className: 'prr-rowitem', key: `issue-${index}` },
                      h(VerdictPill, { verdict: issue.severity, t }),
                      h(
                        'div',
                        { className: 'prr-rowmain' },
                        h('div', { className: 'prr-text' }, issue.point),
                        issue.line > 0
                          ? h('div', { className: 'prr-subtle' }, `${t('severityLine')} ${issue.line}`)
                          : null,
                      ),
                    ),
                  ),
                  (group.suggestions ?? []).map((text, index) =>
                    h(
                      'div',
                      { className: 'prr-rowitem', key: `suggestion-${index}` },
                      h('span', { className: 'prr-tag' }, t('suggestionTag')),
                      h('div', { className: 'prr-rowmain prr-text' }, text),
                    ),
                  ),
                ),
              ),
        ),
        h('div', { className: 'prr-h2' }, t('order')),
        h('div', { className: 'prr-card' }, h(OrderList, { order: report.order, t, onOpenFile: props.onOpenFile })),
        conclusionNode,
        h(PublishedBlock, { entries: publishedEntries, t }),
        review.concludeError === null || review.concludeError === undefined || review.concludeError === ''
          ? null
          : h('div', { className: 'prr-conclude-note' }, String(review.concludeError)),
      );
    }

    /** Per-file review detail: logic, walkthrough, changes, findings, suggestions. */
    function FileDetailPanel(props) {
      const { t, filePath, explanation } = props;
      if (explanation === null || explanation === undefined) {
        return h('div', { className: 'prr-zero' }, t('noExplanation'));
      }
      if (explanation.status === 'error') {
        return h(
          'div',
          null,
          h('div', { className: 'prr-banner', style: { margin: '0 0 10px' } }, explanation.error ?? t('statusError')),
          h(Btn, { label: t('retry'), onClick: () => props.onExplain(true) }),
        );
      }
      if (explanation.status !== 'done' || explanation.explanation === null) {
        return h('div', { className: 'prr-zero' }, t('explaining'));
      }
      const detail = explanation.explanation;
      const section = (title, body) =>
        body === ''
          ? null
          : h(
              'div',
              null,
              h('div', { className: 'prr-h2' }, title),
              h('div', { className: 'prr-card prr-text' }, body),
            );
      const issues = (detail.issues ?? []).length === 0
        ? null
        : h(
            'div',
            null,
            h('div', { className: 'prr-h2' }, t('issues')),
            h(
              'div',
              { className: 'prr-card' },
              detail.issues.map((issue, index) =>
                h(
                  'div',
                  { className: 'prr-rowitem', key: index },
                  h(VerdictPill, { verdict: issue.severity, t }),
                  h(
                    'div',
                    { className: 'prr-rowmain' },
                    h('div', { className: 'prr-text' }, issue.point),
                    issue.line > 0
                      ? h('div', { className: 'prr-subtle' }, `${t('severityLine')} ${issue.line}`)
                      : null,
                  ),
                ),
              ),
            ),
          );
      const suggestions = (detail.suggestions ?? []).length === 0
        ? null
        : h(
            'div',
            null,
            h('div', { className: 'prr-h2' }, t('fileSuggestions')),
            h(
              'div',
              { className: 'prr-card' },
              detail.suggestions.map((item, index) =>
                h('div', { className: 'prr-rowitem', key: index }, h('div', { className: 'prr-rowmain prr-text' }, item)),
              ),
            ),
          );
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'prr-verdictline' },
          h(VerdictPill, { verdict: detail.verdict, t }),
          h('span', { className: 'prr-meta2 prr-filetag' }, filePath),
        ),
        h(
          'div',
          { style: { display: 'flex', gap: '6px', marginBottom: '10px' } },
          h(Btn, {
            label: props.explainBusy ? t('explaining') : t('reExplain'),
            small: true,
            disabled: props.explainBusy === true,
            onClick: () => props.onExplain(true),
          }),
        ),
        h('div', { className: 'prr-card prr-text' }, detail.summary),
        section(t('changes'), detail.changes),
        issues,
        suggestions,
      );
    }

    /** Follow-up conversation inside the review panel (per file or per pull request). */
    /**
     * Discussion history; the input itself lives in the composer takeover, which owns the
     * scope. Nothing renders until a discussion exists, so the pane never shows an empty box.
     */
    function ChatBox(props) {
      const listRef = React.useRef(null);
      React.useEffect(() => {
        const node = listRef.current;
        if (node === null) return;
        node.scrollTop = node.scrollHeight;
      }, [props.messages.length]);
      if (props.messages.length === 0) return null;
      return h(
        'div',
        { className: 'prr-chat' },
        h(
          'div',
          { className: 'prr-chat-list', ref: listRef },
          props.notice === undefined || props.notice === '' ? null : h('div', { className: 'prr-chat-notice prr-chat-noticeline' }, props.notice),
          props.messages.map((turn, index) =>
            h('div', { key: index, className: 'prr-msg', 'data-role': turn.role }, turn.text),
          ),
        ),
      );
    }

    /** Full-file content cache keyed by "<pr>/<path>" (browser-side, survives view remounts). */
    const fileContentCache = new Map();

    /** Full file at PR head with the diff's added lines highlighted, for reading complete context. */
    function FullFileView(props) {
      const containerRef = React.useRef(null);
      const rows = React.useMemo(() => {
        const added = new Set();
        const hunkStarts = new Set();
        let newNo = 0;
        for (const line of String(props.diffText ?? '').split('\n')) {
          if (line.startsWith('@@')) {
            const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
            if (match !== null) {
              newNo = Number(match[1]) - 1;
              hunkStarts.add(Number(match[1]));
            }
            continue;
          }
          if (line.startsWith('+') && !line.startsWith('+++')) {
            newNo += 1;
            added.add(newNo);
          } else if (line.startsWith('-') || line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
            // deleted/meta lines do not advance the new-side counter
          } else {
            newNo += 1;
          }
        }
        return { added, hunkStarts };
      }, [props.diffText]);
      const lines = React.useMemo(() => String(props.content ?? '').split('\n').slice(0, 6000), [props.content]);
      React.useEffect(() => {
        const container = containerRef.current;
        if (container === null) return;
        const firstChange = container.querySelector('[data-change="true"]');
        if (firstChange !== null && typeof firstChange.scrollIntoView === 'function') {
          firstChange.scrollIntoView({ block: 'center' });
        }
      }, [props.content]);
      if (lines.length === 0) return h('div', { className: 'prr-zero' }, props.emptyText);
      return h(
        'div',
        { className: 'prr-fullfile', ref: containerRef },
        h('div', { className: 'prr-fullfile-note' }, props.note),
        lines.map((line, index) => {
          const lineNo = index + 1;
          const isAdded = rows.added.has(lineNo);
          const isHunkStart = rows.hunkStarts.has(lineNo);
          return h(
            'div',
            {
              key: lineNo,
              className: 'prr-row',
              'data-kind': isAdded ? 'add' : 'ctx',
              'data-change': isAdded ? 'true' : 'false',
              'data-hunk-start': isHunkStart ? 'true' : 'false',
              'data-new-line': String(lineNo),
            },
            h('span', { className: 'prr-ln' }, String(lineNo)),
            h('span', { className: 'prr-ln prr-hunkmark' }, isHunkStart ? '▸' : ''),
            h('span', { className: 'prr-code' }, line === '' ? ' ' : line),
          );
        }),
        lines.length >= 6000 ? h('div', { className: 'prr-zero' }, props.truncatedText) : null,
      );
    }

    /**
     * Bridge between the current round's actions and the composer dock that renders them.
     * The overview owns the buttons (they depend on the conclusion/version state); the dock
     * owns the placement, above the session composer, so they stay in reach.
     */
    const actionsBridge = {
      node: null,
      notice: null,
      listeners: new Set(),
      snapshot: { revision: 0 },
      subscribe(fn) {
        actionsBridge.listeners.add(fn);
        return () => actionsBridge.listeners.delete(fn);
      },
      getSnapshot() {
        return actionsBridge.snapshot;
      },
      publish() {
        actionsBridge.snapshot = { revision: actionsBridge.snapshot.revision + 1 };
        for (const fn of actionsBridge.listeners) fn();
      },
      set(node) {
        const next = node === undefined ? null : node;
        if (actionsBridge.node === next) return;
        actionsBridge.node = next;
        actionsBridge.publish();
      },
      /** Coverage/staleness notices rendered above the action row in the dock. */
      setNotice(node) {
        const next = node === undefined ? null : node;
        if (actionsBridge.notice === next) return;
        actionsBridge.notice = next;
        actionsBridge.publish();
      },
    };

        /**
     * Footer of the embedded layers (empty-state overlay and the main-area panel): the same
     * dock above a plain discussion input, so the actions sit where the session view puts them.
     */
    function EmbeddedFooter(props) {
      const { t, draft, busy, locked, onChange, onSend } = props;
      return h(
        'div',
        { className: 'prr-drawer-footer' },
        h(ReviewDock),
        h(
          'div',
          { className: 'prr-drawer-composer' },
          h('input', {
            className: 'prr-input',
            value: draft,
            placeholder: locked ? t('historyDiscussionDisabled') : t('composerPlaceholder'),
            disabled: locked,
            onChange: (event) => onChange(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                onSend();
              }
            },
          }),
          locked ? h('span', { className: 'prr-composer-warn' }, t('historyDiscussionLockedHint')) : null,
          h(Btn, {
            label: busy ? t('composerSending') : t('send'),
            small: true,
            primary: true,
            disabled: locked || busy || draft.trim() === '',
            onClick: () => onSend(),
          }),
        ),
      );
    }

    /**
     * One dock notice: a single summary row that folds the long stale-file list away and
     * expands it on demand. Coverage-only notices keep the light chip form (nothing to fold).
     */
    function DockNotice(props) {
      const { notice, expanded, onToggle } = props;
      if (notice === null || notice === undefined) return null;
      if (notice.detail === null || notice.detail === undefined) {
        return h('div', { className: 'prr-dock-note', 'data-tone': notice.tone === 'warn' ? 'warn' : 'note' }, notice.summary);
      }
      const open = expanded === true;
      return h(
        'div',
        { className: 'prr-dock-panel' },
        h(
          'button',
          {
            type: 'button',
            className: 'prr-dock-toggle',
            'aria-expanded': open ? 'true' : 'false',
            onClick: onToggle,
          },
          h('span', { className: 'prr-dock-caret', 'aria-hidden': 'true' }, open ? '▾' : '▸'),
          h('span', null, notice.summary),
        ),
        open ? h('div', { className: 'prr-dock-detail' }, notice.detail) : null,
      );
    }

    /**
     * Resolve the repository that belongs to the current workspace (not a shared global list).
     * A tab restored at startup can load before the host half registers its routes (restart
     * race), so retry with backoff instead of ending in a permanent error shell.
     */
    function useRepoContext(cwd, attemptToken) {
      const [repoContext, setRepoContext] = React.useState(null);
      const [contextError, setContextError] = React.useState('');
        const [contextBusy, setContextBusy] = React.useState(false);
      // Resolve the repository that belongs to the current workspace (not a shared global list).
      // A tab restored at startup can load before the host half registers its routes (restart
      // race), so retry with backoff instead of ending in a permanent error shell.
      React.useEffect(() => {
        let cancelled = false;
        let timer = null;
        let attempt = 0;
        if (typeof cwd !== 'string' || cwd === '') {
          setRepoContext(null);
          setContextError('no-cwd');
          setContextBusy(false);
          return undefined;
        }
        setRepoContext(null);
        setContextError('');
        setContextBusy(true);
        const load = () => {
          attempt += 1;
          void api(`/pr-review-api/context?cwd=${encodeURIComponent(cwd)}`)
            .then((data) => {
              if (cancelled) return;
              if (data.supported === true && data.repo !== undefined && data.repo !== null) {
                setRepoContext(data.repo);
                setContextError('');
                setContextBusy(false);
                return;
              }
              setRepoContext(null);
              setContextError(typeof data.reason === 'string' ? data.reason : 'unsupported');
              setContextBusy(false);
            })
            .catch(() => {
              if (cancelled) return;
              if (attempt >= 5) {
                setRepoContext(null);
                setContextError('hostNotReady');
                setContextBusy(false);
                return;
              }
              setContextBusy(true);
              timer = setTimeout(load, Math.min(8000, 500 * 2 ** (attempt - 1)));
            });
        };
        load();
        return () => {
          cancelled = true;
          if (timer !== null) clearTimeout(timer);
        };
      }, [cwd, attemptToken]);
      return { repoContext, contextError, contextBusy };
    }


    /**
     * File-detail state: diff text, full-file content, hunk expansion and the walkthrough
     * popover. The selected path stays with the caller; everything else lives here.
     */
    function useFileDetail({ withRepo, generationRef, review, prNumber, filePath }) {
      const [fileDiff, setFileDiff] = React.useState(null);
      const [fileDiffError, setFileDiffError] = React.useState('');
      const [fileContent, setFileContent] = React.useState(null);
      const [fileContentError, setFileContentError] = React.useState('');
      const [fileContentBusy, setFileContentBusy] = React.useState(false);
      const [showFullFile, setShowFullFile] = React.useState(false);
      const [expandedHunks, setExpandedHunks] = React.useState(new Set());
      const [walkFloat, setWalkFloat] = React.useState(null);
      const [activeHunk, setActiveHunk] = React.useState(0);
    const loadFileDiff = React.useCallback(async (number, path) => {
      if (typeof number !== 'number' || path === '') return;
      const generation = generationRef.current;
      setFileDiff(null);
      setFileDiffError('');
      try {
        const data = await api(withRepo(`/pr-review-api/file?number=${number}&path=${encodeURIComponent(path)}`));
        if (generation !== generationRef.current) return;
        setFileDiff(data.file ?? null);
      } catch (error) {
        if (generation === generationRef.current) setFileDiffError(error instanceof Error ? error.message : String(error));
      }
    }, []);

    const loadFileContent = React.useCallback(async (number, path) => {
      if (typeof number !== 'number' || path === '') return null;
      const key = `${number}:${path}`;
      const cached = fileContentCache.get(key);
      if (cached !== undefined) {
        setFileContent(cached);
        setFileContentError('');
        return cached;
      }
      const generation = generationRef.current;
      setFileContentBusy(true);
      setFileContentError('');
      try {
        const data = await api(withRepo(`/pr-review-api/file-content?number=${number}&path=${encodeURIComponent(path)}`));
        if (generation !== generationRef.current) return null;
        const file = data.file ?? null;
        if (file !== null) fileContentCache.set(key, file);
        setFileContent(file);
        return file;
      } catch (error) {
        setFileContentError(error instanceof Error ? error.message : String(error));
        setFileContent(null);
        return null;
      } finally {
        setFileContentBusy(false);
      }
    }, []);

    const toggleFullFile = React.useCallback(async () => {
      if (showFullFile) {
        setShowFullFile(false);
        return;
      }
      const number = review?.number ?? prNumber;
      const file = fileContent ?? (await loadFileContent(number, filePath));
      if (file !== null) setShowFullFile(true);
    }, [showFullFile, fileContent, review, prNumber, filePath, loadFileContent]);

    const expandHunkContext = React.useCallback(async () => {
      const hunk = activeHunk;
      if (hunk < 1) return;
      const number = review?.number ?? prNumber;
      if (fileContent === null) {
        const file = await loadFileContent(number, filePath);
        if (file === null) return;
      }
      setExpandedHunks((previous) => {
        const next = new Set(previous);
        next.add(hunk);
        return next;
      });
      setWalkFloat(null);
      setActiveHunk(0);
    }, [activeHunk, review, prNumber, fileContent, filePath, loadFileContent]);

    const collapseHunkContext = React.useCallback((hunk) => {
      setExpandedHunks((previous) => {
        const next = new Set(previous);
        next.delete(hunk);
        return next;
      });
    }, []);
    const closeWalkFloat = React.useCallback(() => {
      setWalkFloat(null);
      setActiveHunk(0);
    }, []);

    const openWalkFloat = React.useCallback((kind, payload, title, event) => {
      const logic = kind === 'logic' && typeof payload === 'string' ? payload : '';
      const steps = kind === 'steps' && Array.isArray(payload) ? payload : [];
      if ((kind === 'logic' && logic === '') || (kind === 'steps' && steps.length === 0)) return;
      const margin = 12;
      const width = Math.min(420, Math.max(260, window.innerWidth - 24));
      const height = Math.min(Math.round(window.innerHeight * 0.6), 520);
      const x = typeof event?.clientX === 'number' ? event.clientX : window.innerWidth / 2;
      const y = typeof event?.clientY === 'number' ? event.clientY : window.innerHeight / 2;
      setWalkFloat({
        kind,
        steps,
        logic,
        title,
        width,
        left: Math.min(Math.max(margin, x - 60), Math.max(margin, window.innerWidth - width - margin)),
        top: Math.min(Math.max(margin, y - 16), Math.max(margin, window.innerHeight - height - margin)),
      });
    }, []);
    React.useEffect(() => {
      if (walkFloat === null) return undefined;
      const onKeyDown = (event) => {
        if (event.key === 'Escape') closeWalkFloat();
      };
      window.addEventListener('keydown', onKeyDown);
      return () => window.removeEventListener('keydown', onKeyDown);
    }, [walkFloat, closeWalkFloat]);

      return {
        fileDiff, setFileDiff,
        fileDiffError, setFileDiffError,
        fileContent, setFileContent,
        fileContentError, setFileContentError,
        fileContentBusy, setFileContentBusy,
        showFullFile, setShowFullFile,
        expandedHunks, setExpandedHunks,
        walkFloat, setWalkFloat,
        activeHunk, setActiveHunk,
        loadFileDiff, loadFileContent, toggleFullFile, expandHunkContext, collapseHunkContext,
        closeWalkFloat, openWalkFloat,
      };
    }

    /**
     * Publish preview state: one markdown preview at a time, debounced selection refreshes,
     * and the append-only publish call. The component only renders what this returns.
     */
    function usePreviewPublish({ withRepo, stateRef, loadReview }) {
        const [publishBusy, setPublishBusy] = React.useState(false);
        const [publishError, setPublishError] = React.useState('');
        const [preview, setPreview] = React.useState(null);
        const [previewBusy, setPreviewBusy] = React.useState(false);
        const [previewError, setPreviewError] = React.useState('');
        const [previewRefreshBusy, setPreviewRefreshBusy] = React.useState(false);
        const previewTimerRef = React.useRef(null);
        const previewSeqRef = React.useRef(0);
        const previewRef = React.useRef(null);
        previewRef.current = preview;

    // Drop a pending preview debounce when the owning view unmounts.
    React.useEffect(() => () => {
      if (previewTimerRef.current !== null) {
        clearTimeout(previewTimerRef.current);
        previewTimerRef.current = null;
      }
    }, []);

    const applyPreviewResponse = React.useCallback((data, record, previous) => {
      const rounds = roundsOf(record);
      const latest = rounds.length === 0 ? null : rounds[rounds.length - 1];
      const versions = versionsOf(record, latest, true);
      const latestVersion = versions.length === 0 ? null : versions[versions.length - 1];
      const currentList = stateRef.current.list;
      const hostItems = Array.isArray(data?.items) ? data.items : null;
      const items = previewItemsOf(
        hostItems,
        latestVersion === null ? null : latestVersion.conclusion,
      );
      const selectionSupported = previewSelectionSupported(items);
      const previousSelected = previous !== null && previous !== undefined
        && Array.isArray(previous.selectedIds)
        ? new Set(previous.selectedIds)
        : null;
      const selectedIds = selectionSupported
        ? items
          .filter((item) => previousSelected === null || previousSelected.has(item.id))
          .map((item) => item.id)
        : [];
      return {
        markdown: typeof data?.markdown === 'string' ? data.markdown : (previous?.markdown ?? ''),
        language: typeof data?.language === 'string'
          ? data.language
          : (previous?.language
            ?? (typeof currentList?.commentLanguage === 'string' ? currentList.commentLanguage : 'zh')),
        round: latest === null ? 1 : latest.round,
        version: latestVersion === null ? 1 : latestVersion.version,
        conflict: previous?.conflict ?? '',
        items: selectionSupported ? items : [],
        selectionSupported,
        selectedIds,
      };
    }, []);

    /** Publish flow: fetch the host-rendered markdown first, then show the preview dialog. */
    const requestPreview = React.useCallback(async () => {
      const number = stateRef.current.prNumber;
      if (typeof number !== 'number') return;
      setPreviewBusy(true);
      setPublishError('');
      setPreviewError('');
      try {
        const data = await postJson(
          withRepo('/pr-review-api/comment/preview'),
          buildPreviewBody(number),
        );
        setPreview(applyPreviewResponse(data, stateRef.current.review, null));
      } catch (error) {
        setPublishError(error instanceof Error ? error.message : String(error));
      } finally {
        setPreviewBusy(false);
      }
    }, [applyPreviewResponse]);

    /** Re-render the preview markdown for the given selection (host filters by includeIds). */
    const refreshPreview = React.useCallback(async (includeIds) => {
      const number = stateRef.current.prNumber;
      const current = previewRef.current;
      if (typeof number !== 'number' || current === null || current.selectionSupported !== true) return;
      const seq = previewSeqRef.current + 1;
      previewSeqRef.current = seq;
      setPreviewRefreshBusy(true);
      setPreviewError('');
      try {
        const data = await postJson(
          withRepo('/pr-review-api/comment/preview'),
          buildPreviewBody(number, includeIds),
        );
        if (seq !== previewSeqRef.current) return;
        setPreview((previous) => {
          if (previous === null) return previous;
          const next = applyPreviewResponse(data, stateRef.current.review, previous);
          const previousIds = new Set((previous.items ?? []).map((item) => item.id));
          // A host may answer a filtered request with only the selected items: never shrink
          // the checkbox list, otherwise deselected entries become impossible to re-select.
          if (next.items.length < previous.items.length) {
            return {
              ...previous,
              markdown: next.markdown,
              language: next.language,
              round: next.round,
              version: next.version,
            };
          }
          const nextIds = new Set(next.items.map((item) => item.id));
          const selectedIds = (previous.selectedIds ?? []).filter((id) => nextIds.has(id));
          for (const item of next.items) {
            if (!previousIds.has(item.id)) selectedIds.push(item.id);
          }
          return { ...next, selectedIds, conflict: previous.conflict };
        });
      } catch (error) {
        if (seq === previewSeqRef.current) {
          setPreviewError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (seq === previewSeqRef.current) setPreviewRefreshBusy(false);
      }
    }, [applyPreviewResponse]);

    /** Debounce selection changes so rapid checkbox clicks issue one preview request. */
    const schedulePreviewRefresh = React.useCallback((includeIds) => {
      if (previewTimerRef.current !== null) clearTimeout(previewTimerRef.current);
      previewTimerRef.current = setTimeout(() => {
        previewTimerRef.current = null;
        void refreshPreview(includeIds);
      }, 200);
    }, [refreshPreview]);

    const closePreview = React.useCallback(() => {
      if (previewTimerRef.current !== null) {
        clearTimeout(previewTimerRef.current);
        previewTimerRef.current = null;
      }
      setPreview(null);
      setPreviewError('');
      setPreviewRefreshBusy(false);
    }, []);

    const togglePreviewItem = React.useCallback((id) => {
      const current = previewRef.current;
      if (current === null || current.selectionSupported !== true) return;
      const selected = Array.isArray(current.selectedIds) ? current.selectedIds : [];
      const nextSelected = selected.includes(id)
        ? selected.filter((item) => item !== id)
        : [...selected, id];
      setPreview({ ...current, selectedIds: nextSelected });
      schedulePreviewRefresh(nextSelected);
    }, [schedulePreviewRefresh]);

    const selectAllPreviewItems = React.useCallback(() => {
      const current = previewRef.current;
      if (current === null || current.selectionSupported !== true) return;
      const ids = (Array.isArray(current.items) ? current.items : []).map((item) => item.id);
      setPreview({ ...current, selectedIds: ids });
      schedulePreviewRefresh(ids);
    }, [schedulePreviewRefresh]);

    const selectNonePreviewItems = React.useCallback(() => {
      const current = previewRef.current;
      if (current === null || current.selectionSupported !== true) return;
      setPreview({ ...current, selectedIds: [] });
      schedulePreviewRefresh([]);
    }, [schedulePreviewRefresh]);

    const submitPublish = React.useCallback(async (force) => {
      const number = stateRef.current.prNumber;
      if (typeof number !== 'number') return;
      const includeIds = selectionIncludeIds(previewRef.current);
      setPublishBusy(true);
      setPreviewError('');
      try {
        await postJson(
          withRepo('/pr-review-api/comment'),
          buildPublishBody(number, force, includeIds),
        );
        closePreview();
        await loadReview(number);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = error instanceof Error && typeof error.code === 'string' ? error.code : '';
        if (code === 'already-published' || code === 'publishing') {
          setPreview((previous) => (previous === null ? previous : { ...previous, conflict: code }));
        } else {
          setPreviewError(message);
          setPublishError(message);
        }
      } finally {
        setPublishBusy(false);
      }
    }, [loadReview, closePreview]);

      return {
        preview, setPreview, previewBusy, setPreviewBusy, previewError, setPreviewError,
        previewRefreshBusy, setPreviewRefreshBusy, publishBusy, setPublishBusy, publishError, setPublishError,
        requestPreview, refreshPreview, closePreview, togglePreviewItem,
        selectAllPreviewItems, selectNonePreviewItems, submitPublish,
      };
    }

    /**
     * Round and conclusion-version selection. `roundPick` null follows the latest round;
     * per-round version picks are keyed by round number (absent = latest version).
     */
    function useRoundSelection(review, mode, setMode) {
      const [roundPick, setRoundPick] = React.useState(null);
      const [versionPick, setVersionPick] = React.useState({});
    // Round selection (null = follow the latest round) and per-round conclusion version picks.
    const reviewRounds = React.useMemo(() => roundsOf(review), [review]);
    const latestRoundNumber = reviewRounds.length === 0
      ? null
      : reviewRounds[reviewRounds.length - 1].round;
    const selectedRoundNumber = roundPick === null || !reviewRounds.some((entry) => entry.round === roundPick)
      ? latestRoundNumber
      : roundPick;
    const selectedIsCurrent = selectedRoundNumber === null || selectedRoundNumber === latestRoundNumber;
    const historicalView = mode === 'overview' && review !== null && selectedIsCurrent === false;
    const selectRound = React.useCallback((round) => {
      const next = applyRoundSelection(round, latestRoundNumber);
      setRoundPick(next.roundPick);
      setMode(next.mode);
    }, [latestRoundNumber]);
    const pickConclusionVersion = React.useCallback((round, version, latestVersion) => {
      setVersionPick((previous) => {
        const next = { ...previous };
        if (version === latestVersion) delete next[round];
        else next[round] = version;
        return next;
      });
    }, []);

      return {
        reviewRounds, latestRoundNumber, selectedRoundNumber, selectedIsCurrent, historicalView,
        roundPick, setRoundPick, versionPick, setVersionPick, selectRound, pickConclusionVersion,
      };
    }

    /**
     * Re-check implementer replies on the published comment (every 2 minutes while the panel shows it).
     */
    function useFeedbackCheck({ withRepo, stateRef, review, selectedIsCurrent, loadReview }) {
      const [feedbackBusy, setFeedbackBusy] = React.useState(false);
      const [feedbackError, setFeedbackError] = React.useState('');
    const checkFeedback = React.useCallback(async () => {
      const number = stateRef.current.prNumber;
      if (typeof number !== 'number') return;
      setFeedbackBusy(true);
      setFeedbackError('');
      try {
        await postJson(withRepo('/pr-review-api/feedback'), { number });
        await loadReview(number);
      } catch (error) {
        setFeedbackError(error instanceof Error ? error.message : String(error));
      } finally {
        setFeedbackBusy(false);
      }
    }, [loadReview]);
    // Periodically re-check developer feedback on the published comment (cheap unless new replies exist).
    React.useEffect(() => {
      if (review === null || review.status !== 'done') return undefined;
      if (selectedIsCurrent === false) return undefined;
      if ((review.published ?? []).length === 0) return undefined;
      const timer = setInterval(() => {
        if (!feedbackBusy) void checkFeedback();
      }, 120_000);
      return () => clearInterval(timer);
    }, [review, feedbackBusy, checkFeedback, selectedIsCurrent]);

      return {
        feedbackBusy, feedbackError, checkFeedback,
      };
    }

    /**
     * Background conclusion generation: start, cancel, and the short wait window for writes.
     */
    function useConcludeAction({ withRepo, stateRef, loadReview, setReviewError }) {
      const [concludeBusy, setConcludeBusy] = React.useState(false);
      const [concludeWait, setConcludeWait] = React.useState(false);
      const [concludeCancelBusy, setConcludeCancelBusy] = React.useState(false);
    const runConclude = React.useCallback(async () => {
      const number = stateRef.current.prNumber;
      if (typeof number !== 'number') return;
      setConcludeBusy(true);
      setConcludeWait(true);
      try {
        const result = await postJson(withRepo('/pr-review-api/conclude'), { number });
        // Old hosts conclude synchronously; async hosts answer { started: true } and report
        // progress through `review.concluding`, picked up by the poll below.
        if (result?.started !== true) setConcludeWait(false);
        await loadReview(number);
      } catch (error) {
        setConcludeWait(false);
        setReviewError(error instanceof Error ? error.message : String(error));
      } finally {
        setConcludeBusy(false);
      }
    }, [loadReview, setReviewError]);
    const cancelConclude = React.useCallback(async () => {
      const number = stateRef.current.prNumber;
      if (typeof number !== 'number') return;
      setConcludeCancelBusy(true);
      try {
        await postJson(withRepo('/pr-review-api/conclude/cancel'), { number });
        await loadReview(number);
      } catch (error) {
        setReviewError(error instanceof Error ? error.message : String(error));
      } finally {
        setConcludeCancelBusy(false);
      }
    }, [loadReview, setReviewError]);

      return {
        concludeBusy, setConcludeBusy, concludeWait, setConcludeWait, concludeCancelBusy,
        runConclude, cancelConclude,
      };
    }

    /**
     * Legacy overlay conversation and the in-review chat call; both drive the same host /chat route.
     */
    function useReviewChat({ withRepo, stateRef, mode, filePath, historicalView, loadReview, t }) {
      const [overlayDraft, setOverlayDraft] = React.useState('');
      const [overlayBusy, setOverlayBusy] = React.useState(false);
      const [suggestionNotice, setSuggestionNotice] = React.useState('');
    const sendChatMessage = React.useCallback(async (message) => {
      if (historicalView === true) throw new Error(t('historyDiscussionDisabled'));
      const number = stateRef.current.prNumber;
      if (typeof number !== 'number') throw new Error(t('emptyReview'));
      const textValue = String(message ?? '').trim();
      if (textValue === '') return;
      const path = mode === 'file' ? filePath : '';
      const result = await postJson(withRepo('/pr-review-api/chat'), { number, path, message: textValue });
      const applied = Array.isArray(result.applied) ? result.applied : [];
      const inFileScope = path !== '';
      setSuggestionNotice(
        applied.length === 0 ? '' : `${t(inFileScope ? 'suggestionUpdated' : 'overviewUpdated')} ×${applied.length}`,
      );
      await loadReview(number);
    }, [filePath, mode, loadReview, t, historicalView]);
    const sendOverlayMessage = React.useCallback(async () => {
      if (historicalView === true) return;
      const message = overlayDraft.trim();
      if (message === '' || overlayBusy) return;
      setOverlayBusy(true);
      setOverlayDraft('');
      try {
        await sendChatMessage(message);
      } finally {
        setOverlayBusy(false);
      }
    }, [overlayDraft, overlayBusy, sendChatMessage, historicalView]);

      return {
        overlayDraft, setOverlayDraft, overlayBusy, suggestionNotice, setSuggestionNotice,
        sendChatMessage, sendOverlayMessage,
      };
    }
    /** Dock host: re-renders whenever the overview publishes a new footer. */
    function ReviewDock() {
      const [, bump] = React.useReducer((value) => value + 1, 0);
      const [expanded, setExpanded] = React.useState(false);
      React.useEffect(() => actionsBridge.subscribe(() => bump()), []);
      const notice = actionsBridge.notice;
      const actions = actionsBridge.node;
      if (notice === null && actions === null) return null;
      return h(
        'div',
        { className: 'prr-dock' },
        notice === null
          ? null
          : h(
              'div',
              { className: 'prr-dock-notice' },
              h(DockNotice, {
                notice,
                expanded,
                onToggle: () => setExpanded((current) => current !== true),
              }),
            ),
        actions,
      );
    }

    // ---------- the review workspace ----------

    function ReviewWorkspace(props) {
      const ctx = props.ctx;
      const localeId = useLocaleId(ctx);
      const t = makeT(localeId);

      const useSessions = typeof props.useSessions === 'function' ? props.useSessions : () => '';
      const sessionCwd = useSessions((snapshot) => (props.sessionId !== undefined && snapshot?.byId !== undefined
        ? snapshot.byId[props.sessionId]?.cwd ?? ''
        : ''));
      const cwd = typeof props.forcedCwd === 'string' && props.forcedCwd !== '' ? props.forcedCwd : sessionCwd;
      const [contextAttempt, setContextAttempt] = React.useState(0);
      const { repoContext, contextError, contextBusy } = useRepoContext(cwd, contextAttempt);
      const repoRef = React.useRef(null);
      repoRef.current = repoContext;
      const generationRef = React.useRef(0);
      const withRepo = (pathname) => {
        const current = repoRef.current;
        if (current === null) return pathname;
        const query = `repo=${encodeURIComponent(current.repo)}&platform=${encodeURIComponent(current.platform)}&baseUrl=${encodeURIComponent(current.baseUrl)}`;
        return `${pathname}${pathname.includes('?') ? '&' : '?'}${query}`;
      };

      const [list, setList] = React.useState(null);
      const [listError, setListError] = React.useState('');
      const [listBusy, setListBusy] = React.useState(false);
      const [prNumber, setPrNumber] = React.useState(null);
      const [review, setReview] = React.useState(null);
      const [reviewError, setReviewError] = React.useState('');
      const [reviewBusy, setReviewBusy] = React.useState(false);
      const [filePath, setFilePath] = React.useState('');
      const {
        fileDiff, setFileDiff, fileDiffError, setFileDiffError,
        fileContent, setFileContent, fileContentError, setFileContentError, fileContentBusy, setFileContentBusy,
        showFullFile, setShowFullFile, expandedHunks, setExpandedHunks, walkFloat, setWalkFloat, activeHunk, setActiveHunk,
        loadFileDiff, loadFileContent, toggleFullFile, expandHunkContext, collapseHunkContext, closeWalkFloat, openWalkFloat,
      } = useFileDetail({ withRepo, generationRef, review, prNumber, filePath });
      const embedded = props.layer === 'overlay';
      // v2: the right-sidebar tab keeps the main conversation as the only chat surface, so it
      // neither takes over the composer nor renders the (legacy) review discussion box.
      const sidebar = props.layer === 'sidebar';
      // Sidebar keeps the original columns; only a very narrow panel falls back to showing
      // one content pane at a time (the file list stays visible either way).
      const [sidebarPane, setSidebarPane] = React.useState('diff');
      const [sidebarWidth, setSidebarWidth] = React.useState(0);
      const [filesWidth, setFilesWidth] = React.useState(panelSizing.files);
      const [detailWidth, setDetailWidth] = React.useState(panelSizing.detail);
      const rootRef = React.useRef(null);
      const [explainBusy, setExplainBusy] = React.useState(false);
      const [wrap, setWrap] = React.useState(false);
      const [mode, setMode] = React.useState('overview');
      const [scrollLine, setScrollLine] = React.useState(0);
      const diffScrollRef = React.useRef(null);

      const {
        reviewRounds, latestRoundNumber, selectedRoundNumber, selectedIsCurrent, historicalView,
        roundPick, setRoundPick, versionPick, setVersionPick, selectRound, pickConclusionVersion,
      } = useRoundSelection(review, mode, setMode);
      const concluding = review?.concluding ?? null;
      const concludingActive = concluding !== null && concluding !== undefined;

      const initialRef = React.useRef({ number: props.initialNumber, file: props.initialFile });
      const rememberRef = React.useRef(props.onRemember);
      rememberRef.current = props.onRemember;
      const explainInFlight = React.useRef(new Set());
      const stateRef = React.useRef({ prNumber: null, review: null, list: null });
      const withRepoRef = React.useRef(withRepo);
      withRepoRef.current = withRepo;
      const focusRef = React.useRef({ view: 'overview', path: '', pane: 'diff', round: 0 });
      focusRef.current = {
        view: mode === 'file' && filePath !== '' ? 'file' : 'overview',
        path: mode === 'file' ? filePath : '',
        pane: sidebarPane,
        round: selectedRoundNumber ?? 0,
      };
      stateRef.current = { prNumber, review, list };

      const loadList = React.useCallback(async (startMissing) => {
        const generation = generationRef.current;
        try {
          let data = await api(withRepo('/pr-review-api/prs'));
          if (startMissing === true && (data.prs ?? []).length === 0 && data.lastPollAt === 0) {
            await postJson(withRepo('/pr-review-api/refresh'), {});
            data = await api(withRepo('/pr-review-api/prs'));
          }
          if (generation !== generationRef.current) return data;
          setList(data);
          setListError('');
          const current = stateRef.current.prNumber;
          const numbers = (data.prs ?? []).map((pull) => pull.number);
          const stillThere = current !== null && numbers.includes(current);
          if (!stillThere) {
            const preferred = initialRef.current.number;
            const next =
              typeof preferred === 'number' && numbers.includes(preferred)
                ? preferred
                : (numbers.length > 0 ? numbers[0] : null);
            setPrNumber(next);
          }
          return data;
        } catch (error) {
          if (generation === generationRef.current) setListError(error instanceof Error ? error.message : String(error));
          return null;
        }
      }, []);

      const loadReview = React.useCallback(async (number) => {
        if (typeof number !== 'number') return null;
        const generation = generationRef.current;
        try {
          const data = await api(withRepo(`/pr-review-api/review?number=${number}`));
          if (generation !== generationRef.current) return data.review ?? null;
          setReview(data.review ?? null);
          setReviewError('');
          return data.review ?? null;
        } catch (error) {
          if (generation === generationRef.current) setReviewError(error instanceof Error ? error.message : String(error));
          return null;
        }
      }, []);
      const { feedbackBusy, feedbackError, checkFeedback } = useFeedbackCheck({
        withRepo, stateRef, review, selectedIsCurrent, loadReview,
      });
      const {
        concludeBusy, setConcludeBusy, concludeWait, setConcludeWait, concludeCancelBusy,
        runConclude, cancelConclude,
      } = useConcludeAction({ withRepo, stateRef, loadReview, setReviewError });
      const {
        overlayDraft, setOverlayDraft, overlayBusy, suggestionNotice, setSuggestionNotice,
        sendChatMessage, sendOverlayMessage,
      } = useReviewChat({ withRepo, stateRef, mode, filePath, historicalView, loadReview, t });
      const {
        preview, setPreview, previewBusy, setPreviewBusy, previewError, setPreviewError,
        previewRefreshBusy, setPreviewRefreshBusy, publishBusy, setPublishBusy, publishError, setPublishError,
        requestPreview, refreshPreview, closePreview, togglePreviewItem,
        selectAllPreviewItems, selectNonePreviewItems, submitPublish,
      } = usePreviewPublish({ withRepo, stateRef, loadReview });


      const requestExplain = React.useCallback(async (number, path, force) => {
        if (typeof number !== 'number' || path === '') return;
        if (explainInFlight.current.has(path)) return;
        explainInFlight.current.add(path);
        setExplainBusy(true);
        try {
          await postJson(withRepo('/pr-review-api/explain'), { number, path, force: force === true });
          await loadReview(number);
        } catch (error) {
          setReviewError(error instanceof Error ? error.message : String(error));
        } finally {
          explainInFlight.current.delete(path);
          setExplainBusy(false);
        }
      }, [loadReview]);

      const explanationFor = (target) => {
        if (review === null || target === '') return null;
        return (review.explanations ?? []).find((entry) => entry.file === target) ?? null;
      };

      /** Put a review-scoped question starter into the main composer (the only chat surface). */
      const askInChat = React.useCallback(() => {
        const actions = props.inputActions;
        if (actions === undefined || actions === null) return;
        const number = review?.number ?? stateRef.current.prNumber ?? '';
        const scope = reviewAskContext(t, number, selectedRoundNumber ?? 1, mode === 'file' ? filePath : '');
        try {
          if (typeof actions.insertQuote === 'function') actions.insertQuote(scope);
          else if (typeof actions.setDraft === 'function') actions.setDraft(scope);
        } catch {
          // Composer unavailable (for example during a takeover): leave the draft untouched.
        }
      }, [props.inputActions, review, selectedRoundNumber, mode, filePath, t]);

      const openFile = React.useCallback(async (path, line) => {
        if (review === null) return;
        const number = review.number;
        const targetLine = Number.isFinite(line) && line > 0 ? Math.floor(line) : 0;
        setFilePath(path);
        setScrollLine(targetLine);
        setFileContent(null);
        setFileContentError('');
        setShowFullFile(false);
        setExpandedHunks(new Set());
        setSuggestionNotice('');
        if (typeof rememberRef.current === 'function') rememberRef.current(stateRef.current.prNumber ?? number, path);
        setMode('file');
        setSidebarPane('diff');
        void loadFileDiff(number, path);
        const cached = (review.explanations ?? []).find((entry) => entry.file === path);
        if (cached === undefined || (cached.status !== 'done' && cached.status !== 'error')) {
          void requestExplain(number, path, false);
        }
      }, [review, loadFileDiff, requestExplain]);

      const startReview = React.useCallback(async (force) => {
        const number = stateRef.current.prNumber;
        if (typeof number !== 'number') return;
        setReviewBusy(true);
        try {
          await postJson(withRepo('/pr-review-api/review'), { number, force: force === true });
          await loadReview(number);
        } catch (error) {
          setReviewError(error instanceof Error ? error.message : String(error));
        } finally {
          setReviewBusy(false);
        }
      }, [loadReview]);

      const refreshPulls = React.useCallback(async () => {
        setListBusy(true);
        try {
          await postJson(withRepo('/pr-review-api/refresh'), {});
          await loadList(false);
        } catch (error) {
          setListError(error instanceof Error ? error.message : String(error));
        } finally {
          setListBusy(false);
        }
      }, [loadList]);






      /**
       * Turn one host preview payload into dialog state. Host `items` win; hosts that do not
       * return them yet fall back to the current conclusion's items so selection keeps working.
       */





      // Switching workspace/repository must reset the selection so two repos never mix.
      React.useEffect(() => {
        if (repoContext === null) return undefined;
        generationRef.current += 1;
        setPrNumber(null);
        setReview(null);
        setFilePath('');
        setFileDiff(null);
        setFileContent(null);
        setShowFullFile(false);
        setExpandedHunks(new Set());
        setSuggestionNotice('');
        setMode('overview');
        setRoundPick(null);
        setVersionPick({});
        setConcludeWait(false);
        setScrollLine(0);
        setPreview(null);
        setPreviewError('');
        return undefined;
      }, [repoContext]);

      // First load waits for the workspace repository; every request carries that repo.
      React.useEffect(() => {
        if (repoContext === null) return undefined;
        void loadList(true);
        return undefined;
      }, [repoContext, loadList]);

      // Selection: load the review record and restore the remembered file.
      React.useEffect(() => {
        if (prNumber === null) {
          setReview(null);
          setFilePath('');
          return undefined;
        }
        setFilePath('');
        setFileDiff(null);
        setFileDiffError('');
        setFileContent(null);
        setFileContentError('');
        setShowFullFile(false);
        setSuggestionNotice('');
        setMode('overview');
        setRoundPick(null);
        setVersionPick({});
        setConcludeWait(false);
        setScrollLine(0);
        setPreview(null);
        setPreviewError('');
        void loadReview(prNumber).then((record) => {
          if (record === null) return;
          const remembered = initialRef.current.file;
          if (remembered === '') return;
          const hasFile = (record.files ?? []).some((file) => file.path === remembered);
          if (hasFile) {
            setFilePath(remembered);
            setMode('file');
            void loadFileDiff(record.number, remembered);
            const cached = (record.explanations ?? []).find((entry) => entry.file === remembered);
            if (cached === undefined) void requestExplain(record.number, remembered, false);
          }
        });
        return undefined;
      }, [prNumber, loadReview, loadFileDiff, requestExplain]);

      React.useEffect(() => {
        if (!sidebar) return;
        setSidebarPane('diff');
      }, [prNumber, sidebar]);

      // Bind this session to the PR on screen so the main-conversation review_* tools default
      // to what the reviewer is reading; clear the binding when the panel goes away.
      React.useEffect(() => {
        if (!sidebar) return undefined;
        const sessionId = typeof props.sessionId === 'string' ? props.sessionId : '';
        if (sessionId === '' || prNumber === null) return undefined;
        void postJson(withRepoRef.current('/pr-review-api/active'), {
          sessionId,
          number: prNumber,
          ...focusRef.current,
        }).catch(() => {});
        return () => {
          void postJson(withRepoRef.current('/pr-review-api/active'), { sessionId }).catch(() => {});
        };
      }, [sidebar, props.sessionId, prNumber]);

      // Measure the panel so a narrow sidebar can collapse the analysis column instead of
      // forcing a separate file-list screen.
      React.useEffect(() => {
        if (!sidebar) return undefined;
        const node = rootRef.current;
        if (node === null || node === undefined || typeof ResizeObserver === 'undefined') return undefined;
        const observer = new ResizeObserver((entries) => {
          const width = entries[0]?.contentRect?.width;
          if (typeof width === 'number' && width > 0) setSidebarWidth(Math.round(width));
        });
        observer.observe(node);
        return () => observer.disconnect();
      }, [sidebar]);


      // Poll the review while it is being generated; refresh the PR list slowly.
      React.useEffect(() => {
        const reviewTimer = setInterval(() => {
          const current = stateRef.current;
          if (current.prNumber === null) return;
          if (current.review !== null && current.review.status !== 'reviewing') return;
          void loadReview(current.prNumber);
        }, 4000);
        const listTimer = setInterval(() => {
          void loadList(false);
        }, 20000);
        return () => {
          clearInterval(reviewTimer);
          clearInterval(listTimer);
        };
      }, [loadReview, loadList]);

      // Report view changes (overview ↔ file, diff ↔ analysis) so the injected snapshot follows
      // the panel; the host throttles actual injections to once a minute.
      React.useEffect(() => {
        if (!sidebar) return undefined;
        const sessionId = typeof props.sessionId === 'string' ? props.sessionId : '';
        if (sessionId === '' || prNumber === null) return undefined;
        const timer = setTimeout(() => {
          void postJson(withRepoRef.current('/pr-review-api/focus'), {
            sessionId,
            number: prNumber,
            ...focusRef.current,
          }).catch(() => {});
        }, 600);
        return () => clearTimeout(timer);
      }, [sidebar, props.sessionId, prNumber, mode, filePath, sidebarPane, selectedRoundNumber]);

      // Sidebar refresh: the main-conversation tools rewrite the review data, so poll while the
      // panel is visible and let the render catch up. Cheap read, no local state is overwritten.
      React.useEffect(() => {
        if (!sidebar) return undefined;
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
          const number = stateRef.current.prNumber;
          if (typeof number !== 'number') return;
          void loadReview(number);
        }, 5000);
        return () => clearInterval(timer);
      }, [sidebar, loadReview]);

      // A background conclusion reports its stage through `review.concluding`: poll every 2s.
      React.useEffect(() => {
        if (concludingActive === false && concludeWait === false) return undefined;
        const timer = setInterval(() => {
          const current = stateRef.current;
          if (current.prNumber === null) return;
          void loadReview(current.prNumber);
        }, 2000);
        return () => clearInterval(timer);
      }, [concludingActive, concludeWait, loadReview]);

      // The host may need a moment to flip `concluding` on; stop waiting if it never shows up.
      React.useEffect(() => {
        if (concludeWait === false || concludingActive === true) return undefined;
        const timer = setTimeout(() => setConcludeWait(false), 25000);
        return () => clearTimeout(timer);
      }, [concludeWait, concludingActive]);

      // Escape closes the publish preview dialog (same cleanup as its Cancel button).
      React.useEffect(() => {
        if (preview === null) return undefined;
        const onKeyDown = (event) => {
          if (event.key === 'Escape') closePreview();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
      }, [preview, closePreview]);

      // Scroll the rendered diff to the clicked conclusion item's new-side line. A line that
      // is outside the displayed hunks (or a host without line data) silently keeps the file open.
      React.useEffect(() => {
        if (scrollLine <= 0) return undefined;
        scrollToNewLine(diffScrollRef.current, scrollLine);
        return undefined;
      }, [fileDiff, scrollLine]);

      const currentExplanation = explanationFor(filePath);
      const currentLogic =
        currentExplanation !== null && currentExplanation.status === 'done' && currentExplanation.explanation !== null
          ? (currentExplanation.explanation.logic ?? '')
          : '';
      const currentWalkthrough =
        currentExplanation !== null && currentExplanation.status === 'done' && currentExplanation.explanation !== null
          ? (currentExplanation.explanation.walkthrough ?? [])
          : [];

      const orderedFiles = React.useMemo(() => {
        if (review === null) return [];
        const byPath = new Map((review.files ?? []).map((file) => [file.path, file]));
        const orderList = review.report?.order ?? [];
        const orderIndex = new Map(orderList.map((item, index) => [item.file, index]));
        const reasonMap = new Map(orderList.map((item) => [item.file, item.reason]));
        const severityMap = new Map();
        for (const entry of review.explanations ?? []) {
          const issues = entry.explanation?.issues ?? [];
          const severity = issues.some((issue) => issue.severity === 'block')
            ? 'block'
            : issues.length > 0
              ? 'suggest'
              : '';
          severityMap.set(entry.file, severity);
        }
        const paths = [];
        const seen = new Set();
        for (const item of orderList) {
          if (!seen.has(item.file)) {
            paths.push(item.file);
            seen.add(item.file);
          }
        }
        for (const file of review.files ?? []) {
          if (!seen.has(file.path)) {
            paths.push(file.path);
            seen.add(file.path);
          }
        }
        return paths.map((path) => {
          const file = byPath.get(path) ?? { path, status: 'changed', additions: 0, deletions: 0 };
          return {
            path,
            status: file.status ?? 'changed',
            additions: file.additions ?? 0,
            deletions: file.deletions ?? 0,
            order: (orderIndex.get(path) ?? orderIndex.size) + 1,
            reason: reasonMap.get(path) ?? '',
            severity: severityMap.get(path) ?? '',
          };
        });
      }, [review]);

      const explainedCount = React.useMemo(
        () => (review?.explanations ?? []).filter((entry) => entry.status === 'done').length,
        [review],
      );

      const fileFindings = React.useMemo(() => {
        const groups = [];
        const orderIndex = new Map((review?.report?.order ?? []).map((item, index) => [item.file, index]));
        for (const entry of review?.explanations ?? []) {
          if (entry.status !== 'done' || entry.explanation === null || entry.explanation === undefined) continue;
          const issues = entry.explanation.issues ?? [];
          const suggestions = entry.explanation.suggestions ?? [];
          if (issues.length === 0 && suggestions.length === 0) continue;
          groups.push({ file: entry.file, issues, suggestions });
        }
        groups.sort(
          (a, b) =>
            (orderIndex.get(a.file) ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(b.file) ?? Number.MAX_SAFE_INTEGER),
        );
        return groups;
      }, [review]);

      const pullChat = review?.pullChat ?? [];
      const fileChat = currentExplanation?.chat ?? [];

      const selectedFile = review?.files?.find((file) => file.path === filePath) ?? null;
      const reviewing = review !== null && review.status === 'reviewing';
      const pullOptions = (list?.prs ?? []).map((pull) => {
        const summary = list?.reviews?.[pull.number] ?? null;
        const verdict = summary?.status === 'error'
          ? t('statusError')
          : summary?.status === 'reviewing'
            ? t('statusReviewing')
            : summary === null || summary?.verdict === null || summary?.verdict === undefined
              ? t('statusIdle')
              : severityLabel(summary.verdict, t);
        return h(
          'option',
          { key: pull.number, value: pull.number },
          `#${pull.number} ${pull.title} · ${verdict}`,
        );
      });
      const lastPoll = list === null || list.lastPollAt === 0 ? t('neverPolled') : formatClock(list.lastPollAt);
      const CONTEXT_MESSAGES = {
        'no-cwd': 'contextNoSession',
        'not-git': 'contextNotGit',
        'no-origin': 'contextNoOrigin',
        'unsupported-remote': 'contextBadRemote',
        'git-missing': 'contextGitMissing',
        'host-outdated': 'contextOutdated',
        hostNotReady: 'contextHostNotReady',
      };
      const contextMessage = contextBusy
        ? t('contextChecking')
        : contextError === ''
          ? t('contextChecking')
          : t(CONTEXT_MESSAGES[contextError] ?? 'contextUnsupported');
      const contextBlocked = repoContext === null;

      // Which round the selected PR is on, and whether that round still covers the current head commit.
      const selectedPull = prNumber === null ? null : (list?.prs ?? []).find((pull) => pull.number === prNumber) ?? null;
      const reviewRound = review === null ? 0 : (review.round ?? 1);
      let roundKey = '';
      let roundTone = 'idle';
      if (!contextBlocked && prNumber !== null) {
        if (review === null) {
          roundKey = 'roundNone';
        } else if (review.status === 'reviewing') {
          roundKey = 'roundReviewing';
          roundTone = 'reviewing';
        } else if (review.status === 'error') {
          roundKey = 'roundError';
          roundTone = 'error';
        } else if (review.status === 'stale') {
          roundKey = 'roundInterrupted';
          roundTone = 'pending';
        } else if (selectedPull !== null && selectedPull.headSha !== '' && selectedPull.headSha !== review.headSha) {
          roundKey = 'roundNewCommits';
          roundTone = 'pending';
        } else if (review.conclusion === null || review.conclusion === undefined) {
          roundKey = 'roundReportReady';
          roundTone = 'pending';
        } else {
          roundKey = 'roundDone';
          roundTone = 'done';
        }
      }
      const concludedAt = review === null ? '' : formatClock(review.conclusionAt);
      const roundLabelKey = roundKey === 'roundDone' && concludedAt !== '' ? 'roundDoneAt' : roundKey;
      const roundText = roundKey === ''
        ? ''
        : t(roundLabelKey).replace('{round}', String(reviewRound)).replace('{time}', concludedAt);
      const reviewButtonLabel = reviewing
        ? t('reviewing')
        : review === null || prNumber === null
          ? t('review')
          : t('reviewNextRound').replace('{round}', String(reviewRound + 1));
      const reviewButtonHint = reviewing
        ? undefined
        : review === null || prNumber === null
          ? t('reviewFirstHint')
          : t('reviewNextHint');

      const banners = [
        list?.tokenMissing === true ? h('div', { className: 'prr-banner', key: 'token' }, t('tokenMissing')) : null,
        list?.truncatedList === true ? h('div', { className: 'prr-banner', key: 'trunc' }, t('truncatedList')) : null,
        typeof list?.cacheError === 'string' && list.cacheError !== ''
          ? h('div', { className: 'prr-banner', key: 'cache' }, list.cacheError)
          : null,
        typeof list?.saveError === 'string' && list.saveError !== ''
          ? h('div', { className: 'prr-banner', key: 'save' }, list.saveError)
          : null,
        listError === '' ? null : h('div', { className: 'prr-banner', key: 'list' }, listError),
        list !== null && list.lastPollError !== null && list.lastPollError !== undefined && list.lastPollError !== ''
          ? h('div', { className: 'prr-banner', key: 'poll' }, list.lastPollError)
          : null,
        reviewError === '' ? null : h('div', { className: 'prr-banner', key: 'review' }, reviewError),
        review?.filesTruncated === true
          ? h('div', { className: 'prr-banner', key: 'files-trunc' }, t('filesTruncated'))
          : null,
        publishError === '' ? null : h('div', { className: 'prr-banner', key: 'publish' }, publishError),
        feedbackError === '' ? null : h('div', { className: 'prr-banner', key: 'feedback' }, feedbackError),
        fileDiffError === '' ? null : h('div', { className: 'prr-banner', key: 'diff' }, fileDiffError),
        fileContentError === '' ? null : h('div', { className: 'prr-banner', key: 'content' }, fileContentError),
      ].filter((item) => item !== null);

      const topBar = h(TopBar, {
        t,
        prNumber,
        pullOptions,
        onSelectPr: (next) => setPrNumber(next),
        prSelectDisabled: contextBlocked || list === null || (list.prs ?? []).length === 0,
        showRounds: review !== null && roundText !== '',
        rounds: reviewRounds,
        selectedRoundNumber,
        latestRoundNumber,
        latestRoundText: roundText,
        latestRoundTone: roundTone,
        onSelectRound: selectRound,
        published: Array.isArray(review?.published) ? review.published : [],
        listBusy,
        lastPoll,
        onRefresh: () => void refreshPulls(),
        reviewLabel: reviewButtonLabel,
        reviewHint: reviewButtonHint,
        reviewDisabled: contextBlocked || reviewing || prNumber === null,
        onReview: () => void startReview(review !== null),
        onClose: typeof props.onClose === 'function' ? props.onClose : null,
        showTitle: sidebar ? false : true,
      });

      let center;
      if (prNumber === null && (list === null || (list.prs ?? []).length === 0)) {
        center = h('div', { className: 'prr-zero' }, list === null ? t('loading') : t('emptyPr'));
      } else if (reviewing) {
        center = h('div', { className: 'prr-zero' }, t('reviewing'));
      } else if (review !== null && review.status === 'error') {
        center = h(
          'div',
          { className: 'prr-zero' },
          h('div', { className: 'prr-banner', style: { margin: '0 0 8px' } }, review.error ?? t('statusError')),
          h(Btn, { label: t('retry'), onClick: () => void startReview(true) }),
        );
      } else if (filePath === '') {
        center = h('div', { className: 'prr-zero' }, review === null || review.report === null ? t('emptyReview') : t('emptyFile'));
      } else {
        const head = h(
          'div',
          { className: 'prr-diff-head' },
          h('span', { className: 'prr-diff-path', title: filePath }, filePath),
          currentLogic === ''
            ? null
            : h(Btn, {
                label: t('logic'),
                small: true,
                title: t('logic'),
                onClick: (event) => openWalkFloat('logic', currentLogic, t('logic'), event),
              }),
          currentWalkthrough.length === 0
            ? null
            : h(Btn, {
                label: `${t('walkSegment')} · ${currentWalkthrough.length}`,
                small: true,
                title: t('walkHint'),
                onClick: (event) => openWalkFloat('steps', currentWalkthrough, t('walkthrough'), event),
              }),
          selectedFile === null
            ? null
            : h('span', { className: 'prr-subtle' }, t(STATUS_KEY[selectedFile.status] ?? 'modified')),
          selectedFile === null
            ? null
            : h(
                'span',
                { className: 'prr-diff-stat' },
                h('span', { className: 'prr-addn' }, `+${selectedFile.additions ?? 0}`),
                h('span', { className: 'prr-deln' }, `-${selectedFile.deletions ?? 0}`),
              ),
          h(Btn, {
            label: showFullFile ? t('diffOnly') : fileContentBusy ? t('fullFileLoading') : t('fullFile'),
            small: true,
            disabled: fileContentBusy,
            onClick: () => void toggleFullFile(),
          }),
          h(Btn, { label: wrap ? t('wrapOff') : t('wrapOn'), small: true, onClick: () => setWrap(!wrap) }),
        );
        const body = fileDiff === null
          ? h('div', { className: 'prr-zero' }, t('loading'))
          : showFullFile && fileContent !== null
          ? h(FullFileView, {
              content: fileContent.content,
              diffText: fileDiff.diff ?? '',
              note: t('fullFileNote'),
              truncatedText: t('fullFileTruncated'),
              emptyText: t('fullFileUnavailable'),
            })
          : h(
              'div',
              { className: 'prr-diff', ref: diffScrollRef },
              h(DiffView, {
                diffText: fileDiff.diff ?? '',
                wrap,
                emptyText: t('loading'),
                walkthrough: currentWalkthrough,
                walkLabel: t('walkSegment'),
                hint: t('walkHint'),
                activeHunk,
                fileContent: fileContent === null ? null : fileContent.content,
                expandedHunks,
                expandFallbackLabel: t('expandContext'),
                collapseLabel: t('collapseContext'),
                onCollapseHunk: collapseHunkContext,
                onOpenHunk: (hunk, steps, event) => {
                  setActiveHunk(hunk);
                  openWalkFloat('steps', steps, `${t('walkthrough')} · #${hunk}`, event);
                },
              }),
              fileDiff.truncated === true ? h('div', { className: 'prr-zero' }, t('truncated')) : null,
            );
        center = h('div', { className: 'prr-diffcol' }, head, body);
      }

      const overviewMode = mode === 'overview' || filePath === '';
      const noOpenPrs = !contextBlocked && list !== null && (list.prs ?? []).length === 0 && prNumber === null;

      // Wide sidebars keep the three columns; below ~780px the analysis column collapses into
      // the content pane (the file list stays visible in both cases).
      const narrowFile = sidebar && sidebarWidth > 0 && sidebarWidth < 780;
      const fileColumnWidth = sidebar
        ? (sidebarWidth >= 960 ? 224 : (sidebarWidth >= 780 ? 196 : 156))
        : 0;
      const narrowToggle = narrowFile && !overviewMode
        ? h(
            'div',
            { className: 'prr-subseg' },
            h('button', {
              type: 'button',
              className: 'prr-subseg-btn',
              'data-active': sidebarPane === 'diff' ? 'true' : 'false',
              onClick: () => setSidebarPane('diff'),
            }, t('sidebarDiff')),
            h('button', {
              type: 'button',
              className: 'prr-subseg-btn',
              'data-active': sidebarPane === 'analysis' ? 'true' : 'false',
              onClick: () => setSidebarPane('analysis'),
            }, t('sidebarAnalysis')),
          )
        : null;
      const paneHeader = h(DetailHeader, { t, extra: narrowToggle });

      const chatBox = (scopeName) => (sidebar ? null : h(ChatBox, {
        key: 'chat',
        t,
        messages: scopeName === 'file' ? fileChat : pullChat,
        notice: suggestionNotice,
      }));

      const overviewPane = h(
        'section',
        { className: 'prr-overview-pane' },
        paneHeader,
        h(
          'div',
          { className: 'prr-overview-scroll' },
          h(
            'div',
            { className: 'prr-overview-inner' },
            h(OverviewPanel, {
              review: review ?? { report: null, number: prNumber ?? 0, pull: null, status: 'idle', conclusion: null },
              t,
              selectedRoundNumber,
              onSelectRound: selectRound,
              versionPick,
              onPickVersion: pickConclusionVersion,
              concludeBusy,
              concluding,
              cancelBusy: concludeCancelBusy,
              onCancelConclude: () => void cancelConclude(),
              reviewBusy,
              onConclude: () => void runConclude(),
              onOpenFile: (path, line) => void openFile(path, line),
              explainedCount,
              totalFiles: (review?.files ?? []).length,
              fileFindings,
              publishBusy,
              previewBusy,
              feedbackBusy,
              onCheckFeedback: () => void checkFeedback(),
              comment: review?.comment ?? null,
              onPublish: () => void requestPreview(),
              autoReconclude: list?.autoReconclude === true,
            }),
            sidebar ? null : h('div', { className: 'prr-overview-chat' }, chatBox('pull')),
          ),
        ),
      );

      const filesWidthValue = filesWidth > 0 ? filesWidth : fileColumnWidth;
      const detailWidthValue = detailWidth > 0 ? detailWidth : (sidebar ? 280 : 372);

      /** Drag one column divider: the file list grows with the pointer, analysis grows leftwards. */
      const startColumnDrag = (which, event) => {
        if (typeof event.button === 'number' && event.button !== 0) return;
        event.preventDefault();
        const startX = event.clientX;
        const baseFiles = filesWidthValue > 0 ? filesWidthValue : 246;
        const startDetail = detailWidthValue;
        const onMove = (moveEvent) => {
          const delta = moveEvent.clientX - startX;
          if (which === 'files') {
            const next = clampColumnWidth('files', baseFiles + delta);
            panelSizing.files = next;
            setFilesWidth(next);
            return;
          }
          const next = clampColumnWidth('detail', startDetail - delta);
          panelSizing.detail = next;
          setDetailWidth(next);
        };
        const onUp = () => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      };

      const resizer = (which) => h('div', {
        key: `resizer-${which}`,
        className: 'prr-resizer',
        role: 'separator',
        'aria-orientation': 'vertical',
        title: which === 'files' ? t('resizeFiles') : t('resizeDetail'),
        onMouseDown: (event) => startColumnDrag(which, event),
        onDoubleClick: () => {
          panelSizing[which] = 0;
          if (which === 'files') setFilesWidth(0);
          else setDetailWidth(0);
        },
      });

      const analysisPane = h(
        'div',
        { className: 'prr-detail-body' },
        h(FileDetailPanel, {
          filePath,
          explanation: currentExplanation,
          explainBusy,
          t,
          notice: suggestionNotice,
          onExplain: (force) => void requestExplain(review?.number ?? prNumber, filePath, force),
        }),
      );

      const fileDetailPane = h(
        'aside',
        { className: 'prr-detail', style: { flex: `0 0 ${detailWidthValue}px`, minWidth: '120px' } },
        paneHeader,
        analysisPane,
        sidebar ? null : chatBox('file'),
      );

      const filesPane = h(FilesPane, {
        t,
        width: filesWidthValue,
        overviewMode,
        onSelectOverview: () => setMode('overview'),
        files: orderedFiles,
        // Only the file actually on screen keeps the active row; the overview highlights nothing.
        filePath: overviewMode ? '' : filePath,
        review,
        onOpenFile: (path) => void openFile(path),
      });

      return h(
        React.Fragment,
        null,
        h('style', { key: 'css' }, CSS),
        h(
          'div',
          { className: sidebar ? 'prr-root prr-sidebar' : 'prr-root', key: 'root', ref: rootRef },
          topBar,
          banners.length === 0 ? null : h('div', null, banners),
          contextBlocked
            ? h(
                'div',
                { className: 'prr-zero', key: 'context', style: { padding: '32px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' } },
                h('div', null, contextMessage),
                contextError === 'hostNotReady' || contextError === 'host-outdated'
                  ? h(Btn, { label: t('retry'), small: true, onClick: () => setContextAttempt((value) => value + 1) })
                  : null,
              )
            : noOpenPrs
              ? h('div', { className: 'prr-zero', key: 'no-prs', style: { padding: '32px 24px' } }, t('emptyPr'))
              : sidebar
                ? (overviewMode
                    ? h('div', { className: 'prr-body' }, filesPane, resizer('files'), overviewPane)
                    : narrowFile
                      ? h(
                          'div',
                          { className: 'prr-body' },
                          filesPane,
                          resizer('files'),
                          h(
                            'section',
                            { className: 'prr-overview-pane' },
                            paneHeader,
                            sidebarPane === 'analysis' ? analysisPane : center,
                          ),
                        )
                      : h('div', { className: 'prr-body' }, filesPane, resizer('files'), center, resizer('detail'), fileDetailPane))
                : overviewMode
                  ? h('div', { className: 'prr-body' }, filesPane, resizer('files'), overviewPane)
                  : h('div', { className: 'prr-body' }, filesPane, resizer('files'), center, resizer('detail'), fileDetailPane),
          sidebar
            ? h(
                'div',
                { className: 'prr-panel-footer', key: 'panel-footer' },
                h(ReviewDock),
                props.inputActions !== undefined && props.inputActions !== null
                  ? h(
                      'div',
                      { className: 'prr-panel-footer-extra' },
                      h('span', { className: 'prr-subtle' }, t('discussHint')),
                      h(Btn, { label: t('discussInChat'), small: true, onClick: askInChat }),
                    )
                  : null,
              )
            : null,
          embedded
            ? h(EmbeddedFooter, {
                key: 'overlay-composer',
                t,
                draft: overlayDraft,
                busy: overlayBusy,
                locked: historicalView === true,
                onChange: (next) => setOverlayDraft(next),
                onSend: () => void sendOverlayMessage(),
              })
            : null,
          preview === null
            ? null
            : h(PublishPreviewModal, {
                key: 'publish-preview',
                preview,
                t,
                busy: publishBusy,
                refreshing: previewRefreshBusy,
                error: previewError,
                onConfirm: (force) => void submitPublish(force),
                onToggleItem: togglePreviewItem,
                onSelectAll: selectAllPreviewItems,
                onSelectNone: selectNonePreviewItems,
                onCancel: closePreview,
              }),
          walkFloat === null
            ? null
            : h(
                'div',
                { key: 'walk-float', className: 'prr-float-backdrop', onClick: closeWalkFloat },
                h(
                  'div',
                  {
                    className: 'prr-float',
                    role: 'dialog',
                    'aria-label': walkFloat.title,
                    style: {
                      left: `${walkFloat.left}px`,
                      top: `${walkFloat.top}px`,
                      width: `${walkFloat.width}px`,
                      maxHeight: 'min(60vh, 520px)',
                    },
                    onClick: (event) => event.stopPropagation(),
                  },
                  h(
                    'div',
                    { className: 'prr-float-head' },
                    h('span', { className: 'prr-float-title' }, walkFloat.title),
                    h('button', { type: 'button', className: 'prr-float-close', title: t('close'), onClick: closeWalkFloat }, '✕'),
                  ),
                  h(
                    'div',
                    { className: 'prr-float-body' },
                    walkFloat.kind === 'logic'
                      ? h('div', { className: 'prr-text' }, walkFloat.logic)
                      : walkFloat.steps.map((step, index) =>
                          h(
                            'div',
                            { className: 'prr-float-step', key: index },
                            h('div', { className: 'prr-float-step-title' }, cleanStepTitle(step.title)),
                            h('div', { className: 'prr-text' }, step.detail),
                          ),
                        ),
                    walkFloat.kind !== 'steps' || activeHunk < 1
                      ? null
                      : h(
                          'div',
                          { className: 'prr-float-actions' },
                          h(Btn, {
                            label: (() => {
                              const step = walkFloat.steps.find(
                                (item) => item.context !== null && item.context !== undefined && item.context.startLine >= 1,
                              );
                              return step === undefined ? t('expandContext') : t('expandFunction');
                            })(),
                            small: true,
                            primary: true,
                            onClick: () => void expandHunkContext(),
                          }),
                        ),
                  ),
                ),
              ),
        ),
      );
    }

    /** Column widths the reviewer dragged (0 = layout default); survives tab switches. */
    const panelSizing = { files: 0, detail: 0 };

    /** Clamp one dragged column width so neither pane can collapse or push the others out. */
    function clampColumnWidth(which, width) {
      const rounded = Math.round(width);
      if (which === 'files') return Math.max(96, Math.min(380, rounded));
      return Math.max(160, Math.min(760, rounded));
    }

    /** Right-sidebar tab type identity (the key its body registers under) and the entry id. */
    const SIDEBAR_TYPE_ID = '@modouai/dsh-pr-review/panel';
    const SIDEBAR_ENTRY_ID = 'pr-review-panel';

    /** Right-sidebar resource address for one review panel: cwd (+ optional PR number). */
    function sidebarReviewAddress(cwd, number) {
      const base = 'dsh-resource://pr-review/';
      const tail = typeof number === 'number' && number > 0 ? `/${number}` : '';
      return `${base}${encodeURIComponent(typeof cwd === 'string' ? cwd : '')}${tail}`;
    }

    /** Parse a sidebar review address back into its cwd and optional PR number. */
    function parseSidebarReviewAddress(address) {
      const prefix = 'dsh-resource://pr-review/';
      if (typeof address !== 'string' || !address.startsWith(prefix)) return null;
      const rest = address.slice(prefix.length).replace(/\/+$/, '');
      if (rest === '') return null;
      let cwdPart = rest;
      let number = null;
      const slash = rest.lastIndexOf('/');
      if (slash >= 0) {
        const tail = rest.slice(slash + 1);
        if (/^\d+$/.test(tail)) {
          cwdPart = rest.slice(0, slash);
          number = Number(tail) > 0 ? Number(tail) : null;
        }
      }
      let cwd = '';
      try {
        cwd = decodeURIComponent(cwdPart);
      } catch {
        cwd = cwdPart;
      }
      return { cwd, number };
    }

    /**
     * Keeps a review-panel render error contained: the host page keeps working and the panel
     * offers a retry instead of a blank screen.
     */
    const PanelBoundary = typeof React.Component === 'function'
      ? class PanelBoundary extends React.Component {
          constructor(props) {
            super(props);
            this.state = { error: null };
          }

          static getDerivedStateFromError(error) {
            return { error };
          }

          render() {
            if (this.state.error !== null) {
              const t = this.props.t;
              return h(
                'div',
                {
                  className: 'prr-zero',
                  style: { padding: '24px 16px', display: 'flex', flexDirection: 'column', gap: '10px' },
                },
                h('div', null, t('panelCrash')),
                h(Btn, {
                  label: t('panelRetry'),
                  small: true,
                  onClick: () => this.setState({ error: null }),
                }),
              );
            }
            return this.props.children;
          }
        }
      : (props) => props.children;

    /**
     * v2: the review panel rendered as a session right-sidebar tab. The main conversation stays
     * the only chat surface; this panel only shows/reviews data and hosts the human actions.
     */
    function ReviewSidebar(props) {
      const ctx = props.ctx;
      const localeId = useLocaleId(ctx);
      const t = makeT(localeId);
      const useSessions = typeof props.useSessions === 'function' ? props.useSessions : () => null;
      const useTabInfo = typeof props.useTabInfo === 'function' ? props.useTabInfo : null;
      const info = useTabInfo === null ? null : useTabInfo();
      const address = info !== null && info !== undefined && info.tab !== undefined ? info.tab.contentId : '';
      const parsed = parseSidebarReviewAddress(address);
      const sessionCwd = useSessions((snapshot) => (props.sessionId !== undefined && snapshot?.byId !== undefined
        ? snapshot.byId[props.sessionId]?.cwd ?? ''
        : ''));
      const cwd = parsed !== null && parsed.cwd !== '' ? parsed.cwd : sessionCwd;
      if (cwd === '') {
        return h(
          React.Fragment,
          null,
          h('style', { key: 'css' }, CSS),
          h(
            'div',
            { className: 'prr-root prr-sidebar' },
            h('div', { className: 'prr-zero', style: { padding: '24px 16px' } }, t('contextNoSession')),
          ),
        );
      }
      return h(
        PanelBoundary,
        { t: makeT(useLocaleId(ctx)) },
        h(ReviewWorkspace, {
          ctx,
          sessionId: props.sessionId,
          forcedCwd: cwd,
          layer: 'sidebar',
          initialNumber: parsed === null ? null : parsed.number,
          initialFile: '',
          onRemember: () => {},
        }),
      );
    }

    /**
     * Shared review-entry state: the session workspace's cwd, its resolved repo, and the number
     * of open PRs. The workspace is the identity — switching workspaces re-resolves the repo, so
     * one session never opens another workspace's review data.
     */
    function useReviewEntryState(props) {
      const ctx = props.ctx;
      const sessionsHook = typeof props.useSessions === 'function' ? props.useSessions : null;
      const hookCwd = sessionsHook !== null
        ? sessionsHook((snapshot) => (props.sessionId !== undefined && snapshot?.byId !== undefined
          ? snapshot.byId[props.sessionId]?.cwd ?? ''
          : ''))
        : '';
      const [serviceCwd, setServiceCwd] = React.useState('');
      const [repo, setRepo] = React.useState(null);
      const [count, setCount] = React.useState(null);
      const [status, setStatus] = React.useState('loading');
      const buttonRef = React.useRef(null);
      const cwdRef = React.useRef('');
      const isVisible = () => {
        const node = buttonRef.current;
        if (node === null) return false;
        if (typeof node.offsetParent !== 'undefined' && node.offsetParent === null) return false;
        return true;
      };
      React.useEffect(() => {
        if (typeof props.useSessions === 'function') return undefined;
        let dispose = null;
        const read = () => {
          try {
            const sessions = ctx.get('sessions');
            setServiceCwd(sessions?.list?.getSnapshot?.()?.byId?.[props.sessionId]?.cwd ?? '');
          } catch {
            setServiceCwd('');
          }
        };
        read();
        try {
          const store = ctx.get('sessions')?.list;
          if (store !== undefined && store !== null && typeof store.subscribe === 'function') dispose = store.subscribe(read);
        } catch {
          dispose = null;
        }
        return () => {
          if (typeof dispose === 'function') dispose();
        };
      }, [ctx, props.sessionId, props.useSessions]);
      const cwd = hookCwd !== '' ? hookCwd : serviceCwd;
      cwdRef.current = cwd;
      const requestRef = React.useRef(0);
      const refreshCount = React.useCallback(async (cwdValue) => {
        if (cwdValue === '') {
          setCount(0);
          setStatus('ready');
          return 'ready';
        }
        const request = requestRef.current + 1;
        requestRef.current = request;
        try {
          const context = await api(`/pr-review-api/context?cwd=${encodeURIComponent(cwdValue)}`);
          if (request !== requestRef.current) return 'stale';
          if (context.supported !== true || context.repo === null || context.repo === undefined) {
            setRepo(null);
            setCount(0);
            setStatus('ready');
            return 'ready';
          }
          const query = `repo=${encodeURIComponent(context.repo.repo)}&platform=${encodeURIComponent(context.repo.platform)}&baseUrl=${encodeURIComponent(context.repo.baseUrl)}`;
          let data = await api(`/pr-review-api/prs?${query}`);
          if (request !== requestRef.current) return 'stale';
          if ((data.prs ?? []).length === 0 && (data.lastPollAt ?? 0) === 0) {
            await postJson(`/pr-review-api/refresh?${query}`, {});
            if (request !== requestRef.current) return 'stale';
            data = await api(`/pr-review-api/prs?${query}`);
          }
          if (request !== requestRef.current) return 'stale';
          setRepo(context.repo);
          const total = (data.prs ?? []).length;
          // An empty list from a host that has never polled means "still warming up", not
          // "no PRs": keep the entry in the connecting state and retry instead of hiding it.
          if (total === 0 && (data.lastPollAt ?? 0) === 0) {
            setStatus('loading');
            return 'pending';
          }
          setCount(total);
          setStatus('ready');
          return 'ready';
        } catch {
          if (request === requestRef.current) setStatus('error');
          return 'error';
        }
      }, []);
      React.useEffect(() => {
        setCount(null);
        setRepo(null);
        setStatus('loading');
        if (cwd === '') return undefined;
        let disposed = false;
        let retryTimer = null;
        let attempt = 0;
        // The host registers its routes while booting, so the first calls right after a restart
        // can fail. Retry with backoff until the first success instead of waiting for the poll.
        const run = () => {
          void refreshCount(cwd).then((result) => {
            if (disposed || result === 'ready' || result === 'stale') return;
            attempt += 1;
            const delay = Math.min(30_000, 1500 * 2 ** Math.min(attempt - 1, 4));
            retryTimer = setTimeout(run, delay);
          });
        };
        run();
        const timer = setInterval(() => {
          // Hidden/retained conversations must not flip the host's active repository.
          if (!isVisible()) return;
          void refreshCount(cwd);
        }, 30_000);
        const onFocus = () => {
          if (!isVisible()) return;
          void refreshCount(cwd);
        };
        window.addEventListener('focus', onFocus);
        return () => {
          disposed = true;
          clearInterval(timer);
          if (retryTimer !== null) clearTimeout(retryTimer);
          window.removeEventListener('focus', onFocus);
        };
      }, [cwd, refreshCount]);
      const retry = React.useCallback(() => {
        const value = cwdRef.current;
        if (value === '') return;
        setStatus('loading');
        void refreshCount(value);
      }, [refreshCount]);
      return { cwd, repo, count, status, retry, buttonRef };
    }

    /** Public on-screen-session observable of the right sidebar, when the host exposes it. */
    function mountedSessionStore(ctx) {
      const sidebarRight = ctx.get('sidebarRight') ?? ctx.sidebarRight;
      const mounted = sidebarRight !== undefined && sidebarRight !== null ? sidebarRight.mounted : undefined;
      return mounted !== undefined && mounted !== null && typeof mounted.getSnapshot === 'function' ? mounted : undefined;
    }

    /** Host errors that only mean "this session's sidebar store is not adopted yet". */
    function isPendingOpenError(error) {
      const message = error instanceof Error ? error.message : String(error);
      return message.includes('no session surface is mounted');
    }

    /** Whether the review tab is already committed for that session (tabsIn throws never). */
    function reviewTabPresent(sidebarRight, sessionId) {
      if (sidebarRight === undefined || sidebarRight === null || typeof sidebarRight.tabsIn !== 'function') return false;
      try {
        return sidebarRight.tabsIn(sessionId).some(
          (tab) => typeof tab.contentId === 'string' && tab.contentId.startsWith('dsh-resource://pr-review/'),
        );
      } catch {
        return false;
      }
    }

    /**
     * One attempt to dock the review tab with the public navigation controller.
     * - `opened`: the tab is committed.
     * - `pending`: the host has no on-screen/adopted session yet; the entry queues and retries.
     * - `unsupported` / `failed`: no public opener, or navigation threw a real error.
     *
     * `openResource` is the documented external entry path. The internal `openResourceIn`
     * silently does nothing until that session's sidebar store is adopted, so using it first
     * left the entry stuck whenever the store was not adopted yet.
     */
    function requestReviewTab(ctx, sessionId, cwd) {
      const sidebarRight = ctx.get('sidebarRight') ?? ctx.sidebarRight;
      if (sidebarRight === undefined || sidebarRight === null) return 'unsupported';
      if (typeof sidebarRight.openResource !== 'function') return 'unsupported';
      const address = sidebarReviewAddress(cwd);
      try {
        sidebarRight.openResource(address, { destination: 'sidebar' });
        return reviewTabPresent(sidebarRight, sessionId) ? 'opened' : 'pending';
      } catch (error) {
        if (isPendingOpenError(error)) return 'pending';
        // Without an on-screen session there is no surface to open yet; keep the entry queued.
        const mounted = mountedSessionStore(ctx);
        if (mounted !== undefined && mounted.getSnapshot() === undefined) return 'pending';
        console.warn('[pr-review] 打开审查面板失败', error);
        return 'failed';
      }
    }

    /**
     * Review entry pill shared by the session header and the empty-state options: same form,
     * same workspace-scoped open-PR count. It docks the review tab in the right sidebar; a blank
     * conversation has no on-screen session, so the request waits for that signal instead of
     * opening a floating surface.
     */
    function ReviewEntry(props) {
      const ctx = props.ctx;
      const localeId = useLocaleId(ctx);
      const t = makeT(localeId);
      const state = useReviewEntryState(props);
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : '';
      const [mountedId, setMountedId] = React.useState(() => {
        const mounted = mountedSessionStore(ctx);
        return mounted === undefined ? undefined : mounted.getSnapshot();
      });
      const [pending, setPending] = React.useState(null);
      const [openError, setOpenError] = React.useState('');
      React.useEffect(() => {
        const mounted = mountedSessionStore(ctx);
        if (mounted === undefined || typeof mounted.subscribe !== 'function') return undefined;
        setMountedId(mounted.getSnapshot());
        return mounted.subscribe(() => setMountedId(mounted.getSnapshot()));
      }, [ctx]);
      // A queued request retries briefly: the host adopts a session's sidebar store asynchronously
      // after startup, and this is the window before the tab can be placed.
      React.useEffect(() => {
        if (pending === null) return undefined;
        let cancelled = false;
        let attempts = 0;
        let timer = null;
        const tryOpen = () => {
          if (cancelled) return;
          const result = requestReviewTab(ctx, pending.sessionId, pending.cwd);
          if (result === 'pending') {
            attempts += 1;
            // Startup adoption of the right sidebar can take a while; keep the queued request
            // alive (visible as "opening") instead of dropping it after a few seconds.
            if (attempts < 60) timer = setTimeout(tryOpen, Math.min(2000, 400 * Math.min(attempts, 5)));
            return;
          }
          setPending(null);
          setOpenError(result === 'opened' ? '' : result);
        };
        tryOpen();
        return () => {
          cancelled = true;
          if (timer !== null) clearTimeout(timer);
        };
      }, [ctx, mountedId, pending]);
      const ready = state.status === 'ready';
      // Hide only a confirmed empty workspace; while the count is unknown the pill stays visible.
      if (ready && (state.count === null || state.count === 0)) return null;
      const opening = pending !== null;
      const busy = state.status === 'loading';
      const failed = openError !== '' || state.status === 'error';
      const countLabel = ready ? String(state.count) : (busy || opening ? '…' : '!');
      const title = opening
        ? t('heroPendingHint')
        : (openError === 'unsupported'
          ? t('heroUnsupportedHint')
          : (openError === 'failed'
            ? t('heroOpenFailedHint')
            : (busy
              ? t('heroConnecting')
              : (state.status === 'error' ? t('heroRetryHint') : t('heroEntryHint').replace('{count}', String(state.count))))));
      const onClick = () => {
        if (state.cwd === '') {
          state.retry();
          return;
        }
        setOpenError('');
        const result = requestReviewTab(ctx, sessionId, state.cwd);
        if (result === 'pending') {
          setPending({ sessionId, cwd: state.cwd });
          return;
        }
        setOpenError(result === 'opened' ? '' : result);
      };
      return h(
        React.Fragment,
        null,
        h('style', { key: 'css' }, CSS),
        h(
          'button',
          {
            type: 'button',
            className: 'prr-hero-entry',
            ref: state.buttonRef,
            'data-busy': busy || opening ? 'true' : 'false',
            'data-tone': failed ? 'warn' : 'normal',
            'aria-busy': busy || opening ? 'true' : 'false',
            title,
            onClick,
          },
          h('span', { className: 'prr-hero-entry-title' }, t('heroEntry')),
          h('span', { className: 'prr-hero-count' }, countLabel),
        ),
        opening || failed
          ? h(
              'span',
              { key: 'status', className: 'prr-entry-status', 'data-tone': failed ? 'warn' : 'info' },
              opening ? t('heroOpeningHint') : (openError === 'unsupported' ? t('heroUnsupportedHint') : t('heroOpenFailedHint')),
            )
          : null,
      );
    }

    /** Session-header entry: the same pill as the empty state, docking the review tab. */
    function ReviewSidebarEntry(props) {
      return h(ReviewEntry, {
        ctx: props.ctx,
        sessionId: props.sessionId,
        useSessions: props.useSessions,
      });
    }

    /** Empty-conversation (hero) entry: the same pill; the request queues until the session is on screen. */
    function HeroReviewEntry(props) {
      return h(ReviewEntry, {
        ctx: props.ctx,
        sessionId: props.sessionId,
        useSessions: props.useSessions,
      });
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // Entry registrations need no sidebar service; register them first so a cold boot still
        // shows the entry even when the right-sidebar package activates later.
        try {
          ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
            { name: 'conversation.session.header.utilities', id: SIDEBAR_ENTRY_ID, order: 40 },
            (entryProps) => h(ReviewSidebarEntry, { ...entryProps, ctx }),
          ));
        } catch (error) {
          console.error('[pr-review] header entry registration failed', error);
        }
        try {
          ctx.slots.inject('conversation.hero.options', () => ctx.slots.register(
            { name: 'conversation.hero.options', id: 'pr-review-entry', order: 20 },
            (entryProps) => h(HeroReviewEntry, { ...entryProps, ctx }),
          ));
        } catch (error) {
          console.error('[pr-review] hero entry registration failed', error);
        }

        // The tab type and body depend on the right-sidebar services. Client module ordering
        // covers the normal case (dsh.client.inject); this retry covers a cold boot where the
        // services appear after this plugin activated (otherwise nothing would be registered
        // until the plugin is toggled in Settings).
        const registerSidebar = () => {
          try {
            const sidebarRightTabs = ctx.get('sidebarRightTabs');
            if (sidebarRightTabs === undefined || sidebarRightTabs === null || typeof sidebarRightTabs.register !== 'function') {
              return false;
            }
            ctx.effect(() => sidebarRightTabs.register({
              id: SIDEBAR_TYPE_ID,
              kind: 'pr-review',
              patterns: ['dsh-resource://pr-review/**'],
              priority: 'extension',
              canOpen: (address) => parseSidebarReviewAddress(address) !== null,
              title: () => localeTableFor(ctx).title,
            }));
            ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
              { name: 'sidebar.right.pane.tab', key: SIDEBAR_TYPE_ID },
              (tabProps) => h(ReviewSidebar, { ...tabProps, ctx }),
            ));
            return true;
          } catch (error) {
            console.error('[pr-review] sidebar tab registration failed', error);
            return false;
          }
        };
        if (registerSidebar()) return;
        if (typeof ctx.inject === 'function') {
          try {
            ctx.inject(['sidebarRightTabs'], () => {
              registerSidebar();
            });
            return;
          } catch (error) {
            console.error('[pr-review] waiting for sidebarRightTabs failed', error);
          }
        }
        let attempts = 0;
        const retry = () => {
          if (registerSidebar()) return;
          attempts += 1;
          if (attempts < 20) setTimeout(retry, 500);
        };
        setTimeout(retry, 500);
      },
    };
  },
});

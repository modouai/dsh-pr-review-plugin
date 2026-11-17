// Package-local browser chunk. Registered by __ModuleLoader__.load and materialized on
// first require.async from client.js; it shares no scope with the entry.
window.__ModuleLoader__.load({
  id: '@modouai/dsh-pr-review',
  chunk: 'client.workspace.js',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Workspace container and layout: columns, dock, overlays and the composer footer. */
    return function createWorkspace({
      i18n, core, components, preview, hooks, views,
    }) {
      const {
        makeT, useLocaleId,
      } = i18n;
      const {
        api, postJson, reviewAskContext, scrollToNewLine, formatClock, cleanStepTitle,
        severityLabel, text, CSS, Btn, panelSizing, clampColumnWidth, actionsBridge,
        shouldShowReviewButton, derivePhase, shouldAutoSwitchPhase, staleInfoOf, versionsOf,
      } = core;
      const {
        DetailHeader, TopBar,
      } = components;
      const {
        PublishPreviewModal,
      } = preview;
      const {
        FilesPane, ChatBox, FileDetailPanel, OverviewPage, ConclusionPage, WorkspaceCenter, PhaseBar,
      } = views;
      const {
        useRepoContext, useFileDetail, usePreviewPublish, useRoundSelection, useFeedbackCheck,
        useConcludeAction, useReviewChat, usePanelResize, usePanelFocusReport, useReviewPolling,
        useWorkspaceDerived,
      } = hooks;

      /** Stable stand-in when the host gives the panel no session store. */
      const noSessions = () => '';

      function ReviewWorkspace(props) {
        const ctx = props.ctx;
        const onClose = typeof props.onClose === 'function' ? props.onClose : null;
        const inputActions = props.inputActions;
        const localeId = useLocaleId(ctx);
        const t = makeT(localeId);

        const useSessions = typeof props.useSessions === 'function' ? props.useSessions : noSessions;
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
        const [analyzeAllBusy, setAnalyzeAllBusy] = React.useState(false);
        const [wrap, setWrap] = React.useState(false);
        const [mode, setMode] = React.useState('overview');
        const [scrollLine, setScrollLine] = React.useState(0);
        const diffScrollRef = React.useRef(null);

        const {
          reviewRounds, latestRoundNumber, selectedRoundNumber, selectedIsCurrent, historicalView,
          roundPick, setRoundPick, versionPick, setVersionPick, selectRound, pickConclusionVersion,
        } = useRoundSelection(review, mode, setMode);
        const concluding = review?.concluding ?? null;
        const staleInfo = React.useMemo(() => {
          if (review === null || review === undefined) return null;
          const current = reviewRounds.length === 0 ? null : reviewRounds[reviewRounds.length - 1];
          return staleInfoOf(review, versionsOf(review, current, true));
        }, [review, reviewRounds]);
        const phase = React.useMemo(
          () => derivePhase(review, staleInfo, { manual: list?.autoAnalyze === false }),
          [review, staleInfo, list],
        );
        const concludingActive = concluding !== null && concluding !== undefined;

        // When concluding finishes, land on the conclusion page — but only from the overview;
        // a reviewer reading a file is not interrupted, the badges carry the state instead.
        const previousPhaseRef = React.useRef(null);
        React.useEffect(() => {
          const previous = previousPhaseRef.current;
          previousPhaseRef.current = phase.phase;
          if (!shouldAutoSwitchPhase(previous, phase.phase, mode, selectedIsCurrent)) return;
          setMode('conclusion');
        }, [phase, mode, selectedIsCurrent]);

        const initialRef = React.useRef({ number: props.initialNumber, file: props.initialFile });
        const rememberRef = React.useRef(props.onRemember);
        rememberRef.current = props.onRemember;
        const explainInFlight = React.useRef(new Set());
        const analyzeAllRef = React.useRef(false);
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
          previewModalOpen, setPreviewModalOpen,
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

        /** Manual mode: ask the host to analyze every file that still has no analysis. */
        const requestAnalyzeAll = React.useCallback(async () => {
          // The disabled button is not enough: two clicks in one tick see the same state.
          if (analyzeAllRef.current) return;
          const number = stateRef.current.prNumber;
          if (typeof number !== 'number') return;
          analyzeAllRef.current = true;
          setAnalyzeAllBusy(true);
          try {
            await postJson(withRepo('/pr-review-api/analyze'), { number });
            await loadReview(number);
          } catch (error) {
            setReviewError(error instanceof Error ? error.message : String(error));
          } finally {
            analyzeAllRef.current = false;
            setAnalyzeAllBusy(false);
          }
        }, [loadReview]);

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
          setPreviewModalOpen(false);
          setPreviewError('');
          setPublishError('');
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
          setPreviewModalOpen(false);
          setPreviewError('');
          setPublishError('');
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

        usePanelFocusReport({
          sidebar,
          sessionId: typeof props.sessionId === 'string' ? props.sessionId : '',
          prNumber,
          withRepoRef,
          focusRef,
          mode,
          filePath,
          sidebarPane,
          selectedRoundNumber,
        });

        usePanelResize({ sidebar, rootRef, setSidebarWidth });

        useReviewPolling({
          sidebar,
          stateRef,
          concludingActive,
          concludeWait,
          setConcludeWait,
          loadReview,
          loadList,
        });

        // Escape closes the publish preview dialog (same cleanup as its Cancel button). A quiet
        // prefetch keeps `preview` around without a dialog, so the flag gates the listener too.
        React.useEffect(() => {
          if (preview === null || previewModalOpen !== true) return undefined;
          const onKeyDown = (event) => {
            if (event.key === 'Escape') closePreview();
          };
          window.addEventListener('keydown', onKeyDown);
          return () => window.removeEventListener('keydown', onKeyDown);
        }, [preview, previewModalOpen, closePreview]);

        // The conclusion page composes the publish inline: keep a preview prepared (quietly,
        // without opening the modal) while that page is visible with a conclusion present.
        // A failed prefetch stops retrying: the sidebar polls re-load the review every few
        // seconds, and without this gate every poll would fire another request. The publish
        // error banner is the tripwire — it is also what an explicit failed attempt leaves, so
        // the page never fights the reviewer with background traffic either way.
        React.useEffect(() => {
          if (mode !== 'conclusion') return;
          if (review === null || review.conclusion === null || review.conclusion === undefined) return;
          if (preview !== null || previewBusy === true || publishError !== '') return;
          void requestPreview({ quiet: true });
        }, [mode, review, preview, previewBusy, publishError, requestPreview]);

        // Scroll the rendered diff to the clicked conclusion item's new-side line. A line that
        // is outside the displayed hunks (or a host without line data) silently keeps the file open.
        React.useEffect(() => {
          if (scrollLine <= 0) return undefined;
          scrollToNewLine(diffScrollRef.current, scrollLine);
          return undefined;
        }, [fileDiff, scrollLine]);

        const {
          orderedFiles, explainedCount, fileFindings,
          currentExplanation, currentLogic, currentWalkthrough,
        } = useWorkspaceDerived(review, filePath);

        // The shell only wires state and loads; `WorkspaceView` owns the whole render tree.
        const contextBlocked = repoContext === null;
        const model = {
          // Locale and props.
          t, onClose, inputActions,
          // Layer and root.
          embedded, sidebar, rootRef,
          // PR list and record.
          list, listError, listBusy, prNumber, setPrNumber,
          review, reviewError, reviewBusy, filePath,
          // Repository context.
          contextBusy, contextError, contextBlocked, setContextAttempt,
          // Open file.
          fileDiff, fileDiffError, fileContent, fileContentError, fileContentBusy,
          showFullFile, toggleFullFile, expandedHunks, walkFloat, activeHunk, setActiveHunk,
          expandHunkContext, collapseHunkContext, closeWalkFloat, openWalkFloat, diffScrollRef,
          requestExplain, explainBusy,
          // Rounds and view mode.
          reviewRounds, latestRoundNumber, selectedRoundNumber, historicalView,
          versionPick, pickConclusionVersion, selectRound, mode, setMode,
          phase, staleInfo,
          // Columns.
          sidebarPane, setSidebarPane, sidebarWidth,
          filesWidth, setFilesWidth, detailWidth, setDetailWidth,
          // Actions and derived data.
          startReview, refreshPulls, openFile, requestAnalyzeAll, analyzeAllBusy, wrap, setWrap,
          orderedFiles, explainedCount, fileFindings,
          currentExplanation, currentLogic, currentWalkthrough,
          // Feedback.
          feedbackBusy, feedbackError, checkFeedback,
          // Conclusion.
          concludeBusy, concludeCancelBusy, runConclude, cancelConclude, concluding,
          // Chat and overlay composer.
          askInChat, overlayDraft, overlayBusy, setOverlayDraft, suggestionNotice, sendOverlayMessage,
          // Publish preview.
          preview, previewBusy, previewError, previewRefreshBusy, publishBusy, publishError,
          requestPreview, closePreview, togglePreviewItem,
          selectAllPreviewItems, selectNonePreviewItems, submitPublish,
          previewModalOpen,
        };
        return h(WorkspaceView, { model });
      }

      /**
       * Render half of the review workspace.
       *
       * The container (`ReviewWorkspace`) owns state, effects and loads. This component turns
       * that model into labels and layout; `WorkspaceCenter`, `WorkspaceOverviewPane` and
       * `WorkspaceFileDetailPane` each render one region. Cross-area helpers arrive through
       * `createWorkspace(deps)`; this file owns the composition, not the primitives.
       */
      function WorkspaceView({ model }) {
        const {
          t, onClose, inputActions,
          embedded, sidebar, rootRef,
          list, listError, listBusy, prNumber, setPrNumber, review, reviewError, filePath,
          contextBusy, contextError, contextBlocked, setContextAttempt,
          currentExplanation, suggestionNotice,
          reviewRounds, latestRoundNumber, selectedRoundNumber, selectRound,
          mode, setMode, phase, sidebarPane, setSidebarPane, sidebarWidth,
          filesWidth, setFilesWidth, detailWidth, setDetailWidth,
          startReview, refreshPulls, openFile, requestAnalyzeAll, analyzeAllBusy,
          orderedFiles, historicalView,
          publishError, feedbackError, fileDiffError, fileContentError,
          overlayDraft, overlayBusy, setOverlayDraft, sendOverlayMessage,
          preview, previewModalOpen, previewBusy, previewError, previewRefreshBusy, publishBusy,
          closePreview, submitPublish,
          walkFloat, activeHunk, closeWalkFloat, expandHunkContext,
          askInChat,
        } = model;

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
        // With automatic rounds on, the action only appears when they cannot cover the head.
        const showReview = shouldShowReviewButton(list, review, selectedPull);

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
          showReview,
          reviewLabel: reviewButtonLabel,
          reviewHint: reviewButtonHint,
          reviewDisabled: contextBlocked || reviewing || prNumber === null,
          onReview: () => void startReview(review !== null),
          onClose: typeof onClose === 'function' ? onClose : null,
          showTitle: sidebar ? false : true,
        });

        const center = h(WorkspaceCenter, { model });

        const conclusionMode = mode === 'conclusion';
        const overviewMode = mode === 'overview' || (filePath === '' && mode !== 'conclusion');
        const noOpenPrs = !contextBlocked && list !== null && (list.prs ?? []).length === 0 && prNumber === null;

        // Wide sidebars keep the three columns; below ~780px the analysis column collapses into
        // the content pane (the file list stays visible in both cases).
        const narrowFile = sidebar && sidebarWidth > 0 && sidebarWidth < 780;
        const fileColumnWidth = sidebar
          ? (sidebarWidth >= 960 ? 224 : (sidebarWidth >= 780 ? 196 : 156))
          : 0;
        // The diff/analysis toggle only means something while a file's detail is on screen.
        const narrowToggle = narrowFile && !overviewMode && !conclusionMode
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

        const pullChat = review?.pullChat ?? [];
        const fileChat = currentExplanation?.chat ?? [];
        const chatBox = (scopeName) => (sidebar ? null : h(ChatBox, {
          key: 'chat',
          t,
          messages: scopeName === 'file' ? fileChat : pullChat,
          notice: suggestionNotice,
        }));

        const overviewPane = h(WorkspaceOverviewPane, { model, paneHeader, chat: chatBox('pull') });
        const conclusionPane = h(WorkspaceConclusionPane, { model, paneHeader, chat: chatBox('pull') });

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

        const analysisPane = h(WorkspaceAnalysisPane, { model });
        const fileDetailPane = h(WorkspaceFileDetailPane, {
          paneHeader,
          phaseBar: h(PhaseBar, { phase, round: selectedRoundNumber ?? review?.round ?? 1, t }),
          analysis: analysisPane,
          chat: chatBox('file'),
          width: detailWidthValue,
        });

        const filesPane = h(FilesPane, {
          t,
          width: filesWidthValue,
          overviewMode,
          conclusionMode,
          onSelectOverview: () => setMode('overview'),
          onSelectConclusion: () => setMode('conclusion'),
          files: orderedFiles,
          // Only the file actually on screen keeps the active row: the overview highlights
          // nothing, while the conclusion page keeps the row of the file the reviewer came from.
          filePath: overviewMode ? '' : filePath,
          review,
          onOpenFile: (path) => void openFile(path),
          // A historical round has no batch of its own; the progress belongs to the current round.
          analyzing: historicalView ? null : (review?.analyzing ?? null),
          // The on-demand batch only makes sense for a finished round in manual mode.
          manual: historicalView !== true && list?.autoAnalyze === false && review?.status === 'done',
          analyzeAllBusy,
          onAnalyzeAll: () => void requestAnalyzeAll(),
          phase,
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
                  ? (conclusionMode
                      ? h('div', { className: 'prr-body' }, filesPane, resizer('files'), conclusionPane)
                      : overviewMode
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
                  : (conclusionMode
                      ? h('div', { className: 'prr-body' }, filesPane, resizer('files'), conclusionPane)
                      : overviewMode
                        ? h('div', { className: 'prr-body' }, filesPane, resizer('files'), overviewPane)
                        : h('div', { className: 'prr-body' }, filesPane, resizer('files'), center, resizer('detail'), fileDetailPane)),
            sidebar
              ? h(
                  'div',
                  { className: 'prr-panel-footer', key: 'panel-footer' },
                  h(ReviewDock),
                  inputActions !== undefined && inputActions !== null
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
            preview === null || previewModalOpen !== true
              ? null
              : h(PublishPreviewModal, {
                  key: 'publish-preview',
                  preview,
                  t,
                  busy: publishBusy,
                  refreshing: previewRefreshBusy,
                  error: previewError,
                  onConfirm: (force) => void submitPublish(force),
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

      /** Overview pane: the review report, conclusion controls and (outside the sidebar) chat. */
      function WorkspaceOverviewPane({ model, paneHeader, chat }) {
        const {
          t, list, review, prNumber, sidebar,
          selectedRoundNumber, selectRound, versionPick, pickConclusionVersion,
          concludeBusy, concluding, concludeCancelBusy, cancelConclude, reviewBusy, runConclude,
          openFile, explainedCount, fileFindings, phase,
          feedbackBusy, checkFeedback,
        } = model;
        return h(
          'section',
          { className: 'prr-overview-pane' },
          paneHeader,
          h(
            'div',
            { className: 'prr-overview-scroll' },
            h(
              'div',
              { className: 'prr-overview-inner' },
              h(PhaseBar, { phase: model.phase, round: model.selectedRoundNumber ?? review?.round ?? 1, t }),
              h(OverviewPage, {
                review: review ?? { report: null, number: prNumber ?? 0, pull: null, status: 'idle', conclusion: null },
                t,
                phase,
                selectedRoundNumber,
                onOpenFile: (path, line) => void openFile(path, line),
                explainedCount,
                totalFiles: (review?.files ?? []).length,
                fileFindings,
                feedbackBusy,
                onCheckFeedback: () => void checkFeedback(),
                concludeBusy,
                reviewBusy,
                onConclude: () => void runConclude(),
                concluding,
                cancelBusy: concludeCancelBusy,
                onCancelConclude: () => void cancelConclude(),
              }),
              sidebar ? null : h('div', { className: 'prr-overview-chat' }, chat),
            ),
          ),
        );
      }

      /** Conclusion pane: the decision page with the shared status bar and the composer. */
      function WorkspaceConclusionPane({ model, paneHeader, chat }) {
        const {
          t, review, prNumber, sidebar, list, selectedRoundNumber,
          versionPick, pickConclusionVersion,
          concludeBusy, concluding, concludeCancelBusy, cancelConclude, reviewBusy, runConclude,
          openFile, explainedCount, phase,
          publishBusy, previewBusy, previewRefreshBusy, feedbackBusy, checkFeedback,
          preview, togglePreviewItem, staleInfo, requestPreview,
        } = model;
        return h(
          'section',
          { className: 'prr-overview-pane' },
          paneHeader,
          h(
            'div',
            { className: 'prr-overview-scroll' },
            h(
              'div',
              { className: 'prr-overview-inner' },
              h(PhaseBar, { phase, round: selectedRoundNumber ?? review?.round ?? 1, t }),
              h(ConclusionPage, {
                review: review ?? { report: null, number: prNumber ?? 0, pull: null, status: 'idle', conclusion: null },
                t,
                selectedRoundNumber,
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
                publishBusy,
                previewBusy,
                previewRefreshBusy,
                feedbackBusy,
                onCheckFeedback: () => void checkFeedback(),
                preview,
                onToggleInclude: (id) => togglePreviewItem(id),
                onPublish: () => void requestPreview(),
                autoReconclude: list?.autoReconclude === true,
                staleInfo,
              }),
              sidebar ? null : h('div', { className: 'prr-overview-chat' }, chat),
            ),
          ),
        );
      }

      /** Analysis column: the open file's review, or the empty state before one is picked. */
      function WorkspaceAnalysisPane({ model }) {
        const { t, review, prNumber, filePath, currentExplanation, explainBusy, suggestionNotice, requestExplain } = model;
        return h(
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
      }

      /** Analysis column wrapped in its resizable aside, with the pane header and chat box. */
      function WorkspaceFileDetailPane({ paneHeader, phaseBar, analysis, chat, width }) {
        return h(
          'aside',
          { className: 'prr-detail', style: { flex: `0 0 ${width}px`, minWidth: '120px' } },
          paneHeader,
          phaseBar,
          analysis,
          chat,
        );
      }

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

      return {
        ReviewWorkspace, WorkspaceView, WorkspaceOverviewPane, WorkspaceConclusionPane, WorkspaceAnalysisPane, WorkspaceFileDetailPane, EmbeddedFooter, DockNotice, ReviewDock,
      };
    };
  },
});

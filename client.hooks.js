// Package-local browser chunk. Registered by __ModuleLoader__.load and materialized on
// first require.async from client.js; it shares no scope with the entry.
window.__ModuleLoader__.load({
  id: '@modouai/dsh-pr-review',
  chunk: 'client.hooks.js',
  factory(require) {
    const React = require('react');

    /** Stateful workspace hooks: loading, polling, preview/publish and chat. */
    return function createHooks({ core }) {
      const {
        api, postJson, roundsOf, versionsOf, applyRoundSelection, buildPreviewBody,
        buildPublishBody, previewItemsOf, previewSelectionSupported, selectionIncludeIds,
        previewConflictOf, isAnalyzing, fileSeverityOf, fileContentCache, fileContentKey,
      } = core;

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
        // A response fetched for an older head must not land after a round switch; the ref
        // stays current across renders, unlike the closure that started the request.
        const headRef = React.useRef(review?.headSha ?? '');
        headRef.current = review?.headSha ?? '';
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
        const head = headRef.current;
        setFileDiff(null);
        setFileDiffError('');
        try {
          const data = await api(withRepo(`/pr-review-api/file?number=${number}&path=${encodeURIComponent(path)}`));
          if (generation !== generationRef.current || headRef.current !== head) return;
          setFileDiff(data.file ?? null);
        } catch (error) {
          if (generation === generationRef.current && headRef.current === head) {
            setFileDiffError(error instanceof Error ? error.message : String(error));
          }
        }
      }, []);

      const loadFileContent = React.useCallback(async (number, path) => {
        if (typeof number !== 'number' || path === '') return null;
        const head = headRef.current;
        const key = fileContentKey(number, head, path);
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
          if (generation !== generationRef.current || headRef.current !== head) return null;
          const file = data.file ?? null;
          if (file !== null) fileContentCache.set(key, file);
          setFileContent(file);
          return file;
        } catch (error) {
          if (generation === generationRef.current && headRef.current === head) {
            setFileContentError(error instanceof Error ? error.message : String(error));
            setFileContent(null);
          }
          return null;
        } finally {
          setFileContentBusy(false);
        }
      }, [review?.headSha]);

      // A new reviewed head invalidates the full files fetched for this pull request; other
      // pull requests keep their entries (the cache key already contains the head).
      React.useEffect(() => {
        if (typeof prNumber === 'number') {
          const prefix = `${prNumber}@`;
          for (const key of [...fileContentCache.keys()]) {
            if (key.startsWith(prefix)) fileContentCache.delete(key);
          }
        }
        setFileContent(null);
        setFileContentError('');
      }, [prNumber, review?.headSha]);

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
          const [previewModalOpen, setPreviewModalOpen] = React.useState(false);
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
          round: latest === null ? 1 : latest.round,
          version: latestVersion === null ? 1 : latestVersion.version,
          conflict: previous?.conflict ?? previewConflictOf(record),
          items: selectionSupported ? items : [],
          selectionSupported,
          selectedIds,
        };
      }, []);

      /** Publish flow: fetch the host-rendered markdown first, then show the preview dialog. */
      const requestPreview = React.useCallback(async (options = {}) => {
        const number = stateRef.current.prNumber;
        // Early exits (no PR selected) must not open the dialog — or a quiet prefetch on the
        // conclusion page would leave a modal flag that survives PR switches.
        if (typeof number !== 'number') return;
        // A quiet request only refreshes the preview state (used by the conclusion page);
        // the plain publish button still opens the confirmation dialog.
        setPreviewModalOpen(options.quiet !== true);
        // Sequence the fetch like refreshPreview AND pin it to the PR it started for: a newer
        // request/refresh wins (seq), and a PR switch invalidates the answer outright (the
        // landing check) — otherwise PR A's markdown ends up on PR B's page and a publish
        // from it would mix the two records.
        const seq = previewSeqRef.current + 1;
        previewSeqRef.current = seq;
        setPreviewBusy(true);
        setPublishError('');
        setPreviewError('');
        try {
          const data = await postJson(
            withRepo('/pr-review-api/comment/preview'),
            buildPreviewBody(number),
          );
          if (seq !== previewSeqRef.current) return;
          if (number !== stateRef.current.prNumber) return;
          setPreview(applyPreviewResponse(data, stateRef.current.review, null));
        } catch (error) {
          if (seq === previewSeqRef.current) {
            setPublishError(error instanceof Error ? error.message : String(error));
          }
        } finally {
          if (seq === previewSeqRef.current) setPreviewBusy(false);
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
        setPreviewModalOpen(false);
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
          previewModalOpen, setPreviewModalOpen,
        };
      }

      /**
       * Round selection. `roundPick` null follows the latest round.
       */
      function useRoundSelection(review, mode, setMode) {
        const [roundPick, setRoundPick] = React.useState(null);
      // Round selection (null = follow the latest round).
      const reviewRounds = React.useMemo(() => roundsOf(review), [review]);
      const latestRoundNumber = reviewRounds.length === 0
        ? null
        : reviewRounds[reviewRounds.length - 1].round;
      const selectedRoundNumber = roundPick === null || !reviewRounds.some((entry) => entry.round === roundPick)
        ? latestRoundNumber
        : roundPick;
      const selectedIsCurrent = selectedRoundNumber === null || selectedRoundNumber === latestRoundNumber;
      const historicalView = (mode === 'overview' || mode === 'conclusion') && review !== null && selectedIsCurrent === false;
      const selectRound = React.useCallback((round) => {
        const next = applyRoundSelection(round, latestRoundNumber);
        setRoundPick(next.roundPick);
        setMode(next.mode);
      }, [latestRoundNumber]);

        return {
          reviewRounds, latestRoundNumber, selectedRoundNumber, selectedIsCurrent, historicalView,
          roundPick, setRoundPick, selectRound,
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

      /** Measure the panel: a narrow sidebar collapses the analysis column instead of a second screen. */
      function usePanelResize({ sidebar, rootRef, setSidebarWidth }) {
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
      }

      /**
       * Bind this session to the PR on screen — the main conversation's review_* tools default to
       * it — and report the panel's focus, which the host turns into the runtime-context snapshot
       * on the next model step. The report is debounced; an unchanged panel costs nothing.
       */
      function usePanelFocusReport({
        sidebar, sessionId, prNumber, withRepoRef, focusRef,
        mode, filePath, sidebarPane, selectedRoundNumber,
      }) {
        // Binding only ties this session to the PR on screen. The focus fields in its payload are
        // the snapshot at bind time; later view changes are reported by the debounced /focus below.
        React.useEffect(() => {
          if (!sidebar) return undefined;
          if (sessionId === '' || prNumber === null) return undefined;
          void postJson(withRepoRef.current('/pr-review-api/active'), {
            sessionId,
            number: prNumber,
            ...focusRef.current,
          }).catch(() => {});
          return () => {
            void postJson(withRepoRef.current('/pr-review-api/active'), { sessionId }).catch(() => {});
          };
        }, [sidebar, sessionId, prNumber]);

        React.useEffect(() => {
          if (!sidebar) return undefined;
          if (sessionId === '' || prNumber === null) return undefined;
          const timer = setTimeout(() => {
            void postJson(withRepoRef.current('/pr-review-api/focus'), {
              sessionId,
              number: prNumber,
              ...focusRef.current,
            }).catch(() => {});
          }, 600);
          return () => clearTimeout(timer);
        }, [sidebar, sessionId, prNumber, mode, filePath, sidebarPane, selectedRoundNumber]);
      }

      /**
       * Keeps the panel's data fresh: the review while a round or its analysis is running, the PR
       * list slowly, the whole record while the sidebar is visible (tools rewrite it), and the
       * conclusion stage every two seconds.
       */
      function useReviewPolling({ sidebar, stateRef, loadReview, loadList }) {
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

        // The main-conversation tools rewrite the review data, so poll while the panel is visible
        // and let the render catch up. Cheap read, no local state is overwritten.
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
      }

      /** Pure derivations for the workspace: the ordered file list, findings, and the open file. */
      function useWorkspaceDerived(review, filePath) {
        const explanationFor = React.useMemo(() => (target) => {
          if (review === null || target === '') return null;
          return (review.explanations ?? []).find((entry) => entry.file === target) ?? null;
        }, [review]);

        const orderedFiles = React.useMemo(() => {
          if (review === null) return [];
          const byPath = new Map((review.files ?? []).map((file) => [file.path, file]));
          const orderList = review.report?.order ?? [];
          const orderIndex = new Map(orderList.map((item, index) => [item.file, index]));
          const reasonMap = new Map(orderList.map((item) => [item.file, item.reason]));
          const severityMap = new Map();
          for (const entry of review.explanations ?? []) {
            severityMap.set(entry.file, fileSeverityOf(entry));
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
            const findings = entry.explanation.issues ?? [];
            if (findings.length === 0) continue;
            groups.push({ file: entry.file, findings });
          }
          groups.sort(
            (a, b) =>
              (orderIndex.get(a.file) ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(b.file) ?? Number.MAX_SAFE_INTEGER),
          );
          return groups;
        }, [review]);

        const currentExplanation = explanationFor(filePath);
        const currentLogic =
          currentExplanation !== null && currentExplanation.status === 'done' && currentExplanation.explanation !== null
            ? (currentExplanation.explanation.logic ?? '')
            : '';
        const currentWalkthrough =
          currentExplanation !== null && currentExplanation.status === 'done' && currentExplanation.explanation !== null
            ? (currentExplanation.explanation.walkthrough ?? [])
            : [];

        return {
          orderedFiles, explainedCount, fileFindings,
          currentExplanation, currentLogic, currentWalkthrough,
        };
      }

      return {
        useRepoContext, useFileDetail, usePreviewPublish, useRoundSelection, useFeedbackCheck, useReviewChat, usePanelResize, usePanelFocusReport, useReviewPolling, useWorkspaceDerived,
      };
    };
  },
});

// Package-local browser chunk. Registered by __ModuleLoader__.load and materialized on
// first require.async from client.js; it shares no scope with the entry.
window.__ModuleLoader__.load({
  id: '@modouai/dsh-pr-review',
  chunk: 'client.entries.js',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Session-header and hero entry pills that open the review tab. */
    return function createEntries({
      i18n, core,
    }) {
      const {
        makeT, useLocaleId,
      } = i18n;
      const {
        api, postJson, CSS, sidebarReviewAddress,
      } = core;

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
        useReviewEntryState, mountedSessionStore, isPendingOpenError, reviewTabPresent, requestReviewTab, ReviewEntry, ReviewSidebarEntry, HeroReviewEntry,
      };
    };
  },
});

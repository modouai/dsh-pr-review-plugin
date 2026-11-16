// Package-local browser chunk. Registered by __ModuleLoader__.load and materialized on
// first require.async from client.js; it shares no scope with the entry.
window.__ModuleLoader__.load({
  id: '@modouai/dsh-pr-review',
  chunk: 'client.sidebar.js',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Right-sidebar tab body and its render boundary. */
    return function createSidebar({
      i18n, core, workspace,
    }) {
      const {
        makeT, useLocaleId,
      } = i18n;
      const {
        CSS, Btn, parseSidebarReviewAddress,
      } = core;
      const {
        ReviewWorkspace,
      } = workspace;

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

            componentDidCatch(error, info) {
              // React already logs the throw; add our label so the panel's crash is easy to find
              // among host errors, with the component stack the fallback cannot show.
              console.error('[pr-review] 审查面板渲染失败', error, info?.componentStack ?? '');
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

      return {
        PanelBoundary, ReviewSidebar,
      };
    };
  },
});

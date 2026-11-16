// Entry of the browser half. The Host resolves one client module per package, so this file
// stays a thin shell: it registers the package and composes the area chunks beside it.
// `require.async('./client.<area>.js')` loads a chunk as its own script with its own scope;
// chunks register through the same __ModuleLoader__.load with a `chunk` name.
//
// Revision stamp: the Host derives a package's revision from this entry file only, so the
// stamp below is rewritten by scripts/stamp.js whenever a chunk changes. That keeps
// `/plugins/<pkg>/client.<area>.js?rev=<entry rev>` cache-busting honest.
// pr-review chunks: 14020fe12cc9
window.__ModuleLoader__.load({
  id: '@modouai/dsh-pr-review',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const SIDEBAR_ENTRY_ID = 'pr-review-panel';
    const SIDEBAR_TYPE_ID = '@modouai/dsh-pr-review/panel';

    /** Area chunks, in dependency order; `compose` consumes them by file name. */
    const CHUNK_FILES = [
      'client.i18n.js',
      'client.core.js',
      'client.components.js',
      'client.conclusion.js',
      'client.preview.js',
      'client.hooks.js',
      'client.views.js',
      'client.workspace.js',
      'client.sidebar.js',
      'client.entries.js',
    ];

    /**
     * Run each chunk's factory against the areas it depends on. Kept a plain function so the
     * test harness composes the same graph synchronously from the same chunk files.
     */
    function compose(chunks) {
      const i18n = chunks['client.i18n.js'];
      const core = chunks['client.core.js'];
      const components = chunks['client.components.js']({ core });
      const conclusion = chunks['client.conclusion.js']({ core });
      const preview = chunks['client.preview.js']({ core });
      const hooks = chunks['client.hooks.js']({ core });
      const views = chunks['client.views.js']({ core, components, conclusion });
      const workspace = chunks['client.workspace.js']({ i18n, core, components, preview, hooks, views });
      const sidebar = chunks['client.sidebar.js']({ i18n, core, workspace });
      const entries = chunks['client.entries.js']({ i18n, core });
      return { i18n, core, components, conclusion, preview, hooks, views, workspace, sidebar, entries };
    }

    // Chunk scripts arrive independently; the slot components below render nothing until the
    // whole graph is composed, so no slot can see a half-wired area.
    const app = { status: 'loading', error: null, modules: null };
    const listeners = new Set();
    const notify = () => {
      for (const listener of listeners) listener();
    };
    const ready = Promise.all(CHUNK_FILES.map((file) => require.async(`./${file}`)))
      .then((loaded) => {
        const chunks = Object.fromEntries(CHUNK_FILES.map((file, index) => [file, loaded[index]]));
        app.modules = compose(chunks);
        app.status = 'ready';
        notify();
        return app.modules;
      })
      .catch((error) => {
        app.error = error instanceof Error ? error : new Error(String(error));
        app.status = 'error';
        notify();
        return null;
      });

    /** Re-render a slot when the chunks finish (or fail) loading. */
    function useAppState() {
      const [, force] = React.useState(0);
      React.useEffect(() => {
        const listener = () => force((value) => value + 1);
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      }, []);
      return app;
    }

    /** Wrap a slot renderer so the host only ever calls it with composed areas. */
    function areaSlot(render) {
      return function AreaSlot(props) {
        const state = useAppState();
        if (state.status === 'error') {
          return h('div', { className: 'prr-zero', role: 'alert' }, `PR review failed to load: ${state.error.message}`);
        }
        if (state.status !== 'ready') return null;
        return render(state.modules, props);
      };
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // Entry registrations need no sidebar service; register them first so a cold boot still
        // shows the entry even when the right-sidebar package activates later.
        try {
          ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register(
            { name: 'conversation.session.header.utilities', id: SIDEBAR_ENTRY_ID, order: 40 },
            areaSlot((modules, entryProps) => h(modules.entries.ReviewSidebarEntry, { ...entryProps, ctx })),
          ));
        } catch (error) {
          console.error('[pr-review] header entry registration failed', error);
        }
        try {
          ctx.slots.inject('conversation.hero.options', () => ctx.slots.register(
            { name: 'conversation.hero.options', id: 'pr-review-entry', order: 20 },
            areaSlot((modules, entryProps) => h(modules.entries.HeroReviewEntry, { ...entryProps, ctx })),
          ));
        } catch (error) {
          console.error('[pr-review] hero entry registration failed', error);
        }

        // The tab type and body depend on the right-sidebar services and on the composed areas,
        // so registration runs once the chunks arrive.
        const registerSidebar = () => {
          const modules = app.modules;
          if (modules === null) return false;
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
              canOpen: (address) => modules.core.parseSidebarReviewAddress(address) !== null,
              title: () => modules.i18n.localeTableFor(ctx).title,
            }));
            ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
              { name: 'sidebar.right.pane.tab', key: SIDEBAR_TYPE_ID },
              (tabProps) => h(modules.sidebar.ReviewSidebar, { ...tabProps, ctx }),
            ));
            return true;
          } catch (error) {
            console.error('[pr-review] sidebar tab registration failed', error);
            return false;
          }
        };
        // Client module ordering covers the normal case (dsh.client.inject); these fallbacks
        // cover a cold boot where the sidebar services appear after this plugin activated.
        const startSidebarRegistration = () => {
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
        };
        ready.then((modules) => {
          if (modules !== null) startSidebarRegistration();
        });
      },
    };
  },
});

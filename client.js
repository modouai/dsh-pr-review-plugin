// Entry of the browser half. The Host resolves one client module per package, so this file
// stays a thin shell: it registers the package and composes the area chunks beside it.
// `require.async('./client.<area>.js')` loads a chunk as its own script with its own scope;
// chunks register through the same __ModuleLoader__.load with a `chunk` name.
//
// Revision stamp: the Host derives a package's revision from this entry file only, so the
// stamp below is rewritten by scripts/stamp.js whenever a chunk changes. That keeps
// `/plugins/<pkg>/client.<area>.js?rev=<entry rev>` cache-busting honest.
// pr-review chunks: 76c34798b2ce
window.__ModuleLoader__.load({
  id: '@modouai/dsh-pr-review',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const SIDEBAR_ENTRY_ID = 'pr-review-panel';
    const SIDEBAR_TYPE_ID = '@modouai/dsh-pr-review/panel';

    /**
     * Area chunks in dependency order. One table drives both the parallel load and the
     * composition, so a chunk cannot be shipped without being composed, or composed without
     * being loaded. A chunk with no deps exports its value directly; one with deps exports a
     * `create({ ...deps })` function and receives the areas composed before it.
     */
    const AREAS = [
      { area: 'i18n', file: 'client.i18n.js', deps: [] },
      { area: 'core', file: 'client.core.js', deps: [] },
      { area: 'components', file: 'client.components.js', deps: ['core'] },
      { area: 'conclusion', file: 'client.conclusion.js', deps: ['core'] },
      { area: 'preview', file: 'client.preview.js', deps: ['core'] },
      { area: 'hooks', file: 'client.hooks.js', deps: ['core'] },
      { area: 'views', file: 'client.views.js', deps: ['core', 'components', 'conclusion'] },
      { area: 'workspace', file: 'client.workspace.js', deps: ['i18n', 'core', 'components', 'preview', 'hooks', 'views'] },
      { area: 'sidebar', file: 'client.sidebar.js', deps: ['i18n', 'core', 'workspace'] },
      { area: 'entries', file: 'client.entries.js', deps: ['i18n', 'core'] },
    ];
    const CHUNK_FILES = AREAS.map(({ file }) => file);

    /**
     * Run each chunk's factory against the areas it depends on. Kept a plain function so the
     * test harness composes the same graph synchronously from the same chunk files.
     */
    function compose(chunks) {
      const areas = {};
      for (const { area, file, deps } of AREAS) {
        const loaded = chunks[file];
        if (loaded === undefined || loaded === null) {
          throw new Error(`client-modules: ${file} did not export anything`);
        }
        if (deps.length === 0) {
          if (typeof loaded !== 'object') {
            throw new Error(`client-modules: ${file} must export an object`);
          }
          areas[area] = loaded;
          continue;
        }
        if (typeof loaded !== 'function') {
          throw new Error(`client-modules: ${file} must export a create() function`);
        }
        const depsOfArea = {};
        for (const dep of deps) {
          if (areas[dep] === undefined) {
            throw new Error(`client-modules: ${file} depends on ${dep}, which was not composed first`);
          }
          depsOfArea[dep] = areas[dep];
        }
        areas[area] = loaded(depsOfArea);
      }
      return areas;
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
        if (state.status !== 'ready') {
          // Chunk scripts are local and usually arrive within a frame; keep the slot's place
          // instead of letting the entry pill pop in later.
          return h('span', { className: 'prr-entry-pending', 'aria-busy': 'true' });
        }
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
        let sidebarRegistered = false;
        let sidebarTimer = null;
        let disposed = false;
        const registerSidebar = () => {
          if (disposed || sidebarRegistered) return true;
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
            sidebarRegistered = true;
            return true;
          } catch (error) {
            console.error('[pr-review] sidebar tab registration failed', error);
            return false;
          }
        };
        // Client module ordering covers the normal case (dsh.client.inject); these fallbacks
        // cover a cold boot where the sidebar services appear after this plugin activated.
        const startSidebarRegistration = () => {
          if (disposed) return;
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
            sidebarTimer = null;
            if (disposed) return;
            if (registerSidebar()) return;
            attempts += 1;
            if (attempts < 20) sidebarTimer = setTimeout(retry, 500);
          };
          sidebarTimer = setTimeout(retry, 500);
        };
        // A pending retry must not outlive this plugin's scope: the cleanup flips `disposed`
        // before clearing the timer, so a `ready` that resolves after unload cannot schedule a
        // new one against the inactive context.
        ctx.effect(() => () => {
          disposed = true;
          if (sidebarTimer !== null) {
            clearTimeout(sidebarTimer);
            sidebarTimer = null;
          }
        });
        ready.then((modules) => {
          if (modules !== null) startSidebarRegistration();
        });
      },
    };
  },
});

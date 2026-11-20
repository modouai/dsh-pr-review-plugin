// Package-local browser chunk. Registered by __ModuleLoader__.load and materialized on
// first require.async from client.js; it shares no scope with the entry.
window.__ModuleLoader__.load({
  id: '@modouai/dsh-pr-review',
  chunk: 'client.core.js',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Shared foundation: host API, review-record helpers, render primitives, styles and the singletons areas exchange. */

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
     * State transition for picking a round: the latest one keeps following (null) and lands on
     * the overview; a pinned historical round lands on the conclusion page — history persists
     * conclusions/delta/feedback/published, so the conclusion is its main artifact.
     */
    function applyRoundSelection(round, latestRoundNumber) {
      const historical = round !== latestRoundNumber;
      return {
        roundPick: historical ? round : null,
        mode: historical ? 'conclusion' : 'overview',
      };
    }

    /**
     * Overflow/boundary state for the top-bar round strip. Tolerates a not-yet-mounted
     * element, sub-pixel scroll offsets and an exact fit.
     */
    function roundStripStateOf(scroller) {
      if (scroller === null || scroller === undefined) {
        return { overflow: false, atStart: true, atEnd: true };
      }
      const scrollWidth = scroller.scrollWidth ?? 0;
      const clientWidth = scroller.clientWidth ?? 0;
      const scrollLeft = scroller.scrollLeft ?? 0;
      if (scrollWidth - clientWidth <= 1) {
        return { overflow: false, atStart: true, atEnd: true };
      }
      return {
        overflow: true,
        atStart: scrollLeft <= 1,
        atEnd: scrollLeft + clientWidth >= scrollWidth - 1,
      };
    }

    /** Scroll the round strip most of a page toward `direction` (-1 left, 1 right). */
    function scrollRoundStrip(scroller, direction) {
      if (scroller === null || scroller === undefined || typeof scroller.scrollBy !== 'function') {
        return false;
      }
      const step = Math.max(Math.round((scroller.clientWidth ?? 0) * 0.8), 120);
      scroller.scrollBy({ left: (direction < 0 ? -1 : 1) * step, behavior: 'smooth' });
      return true;
    }

    /** Keep the selected pill (the latest by default) inside the visible strip. */
    function revealActiveRound(scroller) {
      if (scroller === null || scroller === undefined || typeof scroller.querySelector !== 'function') {
        return false;
      }
      const target = scroller.querySelector('[data-active="true"]');
      if (target === null || target === undefined || typeof target.scrollIntoView !== 'function') {
        return false;
      }
      target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return true;
    }

    /**
     * Manual review starts are redundant only while automatic rounds are on and the current
     * round already covers the selected PR's head. Unknown settings and unverifiable heads
     * keep the button: it may be the only way to start a round.
     */
    function shouldShowReviewButton(list, review, selectedPull) {
      if (list?.autoReview !== true) return true;
      if (review === null || review === undefined) return true;
      if (review.status === 'reviewing') return false;
      if (review.status === 'error' || review.status === 'stale') return true;
      if (selectedPull === null || selectedPull === undefined) return true;
      const headSha = selectedPull.headSha ?? '';
      return headSha === '' || headSha !== review.headSha;
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

    /**
     * The single phase the whole panel shows. Everything the host already reports — review
     * status, batch progress, the conclude job, conclusion versions, published entries and
     * staleness — folds into one enum so the status bar, the rail badges and the footer
     * cannot disagree. `staleInfo` is staleInfoOf()'s result (null = not stale); options
     * carry per-workspace flags ({ manual: true } = autoAnalyze off).
     */
    function derivePhase(review, staleInfo, options = {}) {
      const data = review ?? {};
      // The version is resolved before the status branches: even an errored review keeps
      // reporting the newest conclusion version it reached instead of resetting to v0.
      const rounds = roundsOf(data);
      const current = rounds.length > 0 ? rounds[rounds.length - 1] : null;
      const versions = versionsOf(data, current, true);
      const version = versions.length > 0 ? versions[versions.length - 1].version : 0;
      if (data.status === 'error') return { phase: 'error', progress: null, nextAction: null, version };
      const analyzing = isAnalyzing(data.analyzing) ? data.analyzing : null;
      // Batch progress is restated in the global ledger (analyzed / all changed files), the
      // same numbers the completeness line shows — a header badge of "3/9" next to an
      // overview "6/12" used to read as two disagreeing facts. The batch object only
      // answers "is a run active" and how many hard failures it hit.
      const files = Array.isArray(data.files) ? data.files : [];
      const explanations = Array.isArray(data.explanations) ? data.explanations : [];
      const analyzedCount = explanations.filter((entry) => (
        entry !== null && typeof entry === 'object' && entry.status === 'done' && entry.explanation !== null && entry.explanation !== undefined
      )).length;
      const progress = analyzing === null
        ? null
        : {
            done: analyzedCount,
            total: files.length > 0 ? files.length : analyzedCount,
            failed: Math.min(Math.max(analyzing.failed ?? 0, 0), analyzing.total ?? 0),
          };
      const hasConclusion = versions.length > 0;
      const stale = staleInfo !== null && staleInfo !== undefined;
      if (data.status === 'reviewing') return { phase: 'reviewing', progress: null, nextAction: null, version };
      if (data.concluding !== null && data.concluding !== undefined) {
        return { phase: 'concluding', progress: null, nextAction: null, version };
      }
      if (analyzing !== null) {
        return {
          phase: 'analyzing',
          progress,
          nextAction: options.manual === true ? 'analyzeAll' : null,
          version,
        };
      }
      if (!hasConclusion) return { phase: 'ready', progress: null, nextAction: 'conclude', version };
      const published = isRoundVersionPublished(data.published, current === null ? 1 : current.round, version);
      if (published && stale) return { phase: 'published-stale', progress: null, nextAction: 'regenerate', version };
      if (published) return { phase: 'published', progress: null, nextAction: 'append', version };
      if (stale) return { phase: 'concluded-stale', progress: null, nextAction: 'regenerate', version };
      return { phase: 'concluded', progress: null, nextAction: 'publish', version };
    }

    /**
     * The auto-switch decision: land on the conclusion page when the conclude job just
     * finished (concluding → a terminal phase), but only from the overview of the current
     * round — a reviewer reading a file is not interrupted; the badges carry the state.
     */
    function shouldAutoSwitchPhase(previousPhase, phase, mode, selectedIsCurrent) {
      if (previousPhase !== 'concluding') return false;
      if (phase !== 'concluded' && phase !== 'concluded-stale'
        && phase !== 'published' && phase !== 'published-stale') return false;
      return mode === 'overview' && selectedIsCurrent === true;
    }

    /** The overview footer mounts only while reviewing is actionable: ready or concluding. */
    function overviewFooterVisible(phase) {
      return phase !== null && phase !== undefined
        && (phase.phase === 'ready' || phase.phase === 'concluding');
    }

    /** Shared「分析 d/t (+ failed)」text for both status lines. */
    function analyzingText(phase, t) {
      const base = fill(t('badgeAnalyzing'), {
        done: phase.progress?.done ?? 0,
        total: phase.progress?.total ?? 0,
      });
      const failed = (phase.progress?.failed ?? 0) > 0
        ? fill(t('badgeAnalyzingFailed'), { failed: phase.progress.failed })
        : '';
      return failed === '' ? base : `${base} ${failed}`;
    }

    /** The process-side state line: one text for the status bar and the overview badge. */
    function phaseStateText(phase, t) {
      if (phase === null || phase === undefined) return '';
      if (phase.phase === 'reviewing') return t('badgeReviewing');
      if (phase.phase === 'concluding') return t('badgeConcluding');
      if (phase.phase === 'error') return t('badgeError');
      if (phase.phase === 'analyzing') return analyzingText(phase, t);
      return t('badgeDone');
    }

    /** The overview-entry state: the review process itself, never the conclude job. */
    function overviewStateText(phase, t) {
      if (phase === null || phase === undefined) return '';
      if (phase.phase === 'error') return t('badgeError');
      if (phase.phase === 'reviewing') return t('badgeReviewing');
      if (phase.phase === 'analyzing') return analyzingText(phase, t);
      return t('badgeDone');
    }

    /** The conclusion-side badge: version-aware, none while no conclusion exists. */
    function conclusionBadgeText(phase, t) {
      if (phase === null || phase === undefined) return t('badgeConclusionNone');
      const version = phase.version ?? 0;
      if (phase.phase === 'concluding') return t('badgeConcluding');
      if (phase.phase === 'concluded') return fill(t('badgeConclusionDraft'), { version });
      if (phase.phase === 'concluded-stale') return fill(t('badgeConclusionStale'), { version });
      if (phase.phase === 'published') return fill(t('badgePublished'), { version });
      if (phase.phase === 'published-stale') return fill(t('badgePublishedStale'), { version });
      return t('badgeConclusionNone');
    }

    /** Badge tone for the rail's conclusion entry: ok/warn/info/danger/none. */
    function conclusionBadgeTone(phase) {
      if (phase === null || phase === undefined) return 'none';
      if (phase.phase === 'concluding' || phase.phase === 'concluded') return 'info';
      if (phase.phase === 'concluded-stale' || phase.phase === 'published-stale') return 'warn';
      if (phase.phase === 'published') return 'ok';
      if (phase.phase === 'error') return 'danger';
      return 'none';
    }

    /** Badge tone for the rail's overview entry: the process side of the same phase. */
    function processBadgeTone(phase) {
      if (phase === null || phase === undefined) return 'none';
      if (phase.phase === 'error') return 'danger';
      if (phase.phase === 'concluding' || phase.phase === 'concluded') return 'ok';
      if (phase.phase === 'reviewing' || phase.phase === 'analyzing') return 'info';
      return 'ok';
    }

    /** Badge tone for the changed-files header: the per-file analysis progress. */
    function filesBadgeTone(analyzing, failedCount, analyzedCount, totalCount) {
      if (isAnalyzing(analyzing)) return 'info';
      if ((failedCount ?? 0) > 0) return 'danger';
      if ((totalCount ?? 0) > 0 && (analyzedCount ?? 0) >= totalCount) return 'ok';
      return 'none';
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
     * The conflict the publish preview opens with. The dialog would otherwise let the reviewer
     * confirm a publish that the host rejects with `already-published`; opening straight in the
     * append flow says what will happen before the first click. '' means a normal publish.
     *
     * It always reads the newest round's newest version: the preview (and the host's publish
     * path) renders `review.conclusion`, which is exactly that version. Selecting an older
     * version or a historical round disables publishing, so the two never disagree in the UI.
     * `isCurrent` is true because `latest` is the newest round by construction.
     */
    function previewConflictOf(record) {
      const rounds = roundsOf(record);
      const latest = rounds.length === 0 ? null : rounds[rounds.length - 1];
      const versions = versionsOf(record, latest, true);
      if (versions.length === 0) return '';
      const latestVersion = versions[versions.length - 1];
      const roundNumber = latest === null ? 1 : latest.round;
      return isRoundVersionPublished(publishedOfRound(record, roundNumber), roundNumber, latestVersion.version)
        ? 'already-published'
        : '';
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

    /** Full-file content cache keyed by "<pr>@<head>/<path>" (browser-side, survives remounts). */
    const fileContentCache = new Map();

    /** Cache key: the reviewed head is part of it, so a new snapshot never reuses the old body. */
    function fileContentKey(number, headSha, path) {
      return `${number}@${headSha ?? ''}:${path}`;
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

    /**
     * Verdict → the tone shared by the verdict pill and the file row dot. Anything the model or
     * a tool writes outside the three known values reads as idle in both places, so the two
     * surfaces cannot drift apart again.
     */
    function verdictTone(value) {
      return value === 'block' || value === 'suggest' || value === 'pass' ? value : 'idle';
    }

    /** Severity → localized label. */
    function severityLabel(severity, t) {
      return t(VERDICT_KEY[severity] ?? 'verdictUnknown');
    }

    /**
     * Dot tone for one file row: 'block' | 'suggest' | 'pass' | '' (no dot). A finished analysis
     * is authoritative — its verdict drives the dot exactly as the pill shows it, and an unknown
     * verdict means no dot (the pill's idle tone). Only an unfinished analysis falls back to the
     * findings it already has; that fallback describes work in progress, not a final verdict.
     */
    function fileSeverityOf(entry) {
      if (entry?.status === 'done') {
        const tone = verdictTone(entry?.explanation?.verdict);
        return tone === 'idle' ? '' : tone;
      }
      const issues = Array.isArray(entry?.explanation?.issues) ? entry.explanation.issues : [];
      if (issues.some((issue) => issue?.severity === 'block')) return 'block';
      return issues.length > 0 ? 'suggest' : '';
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

    const CSS = `
.prr-root{display:flex;flex-direction:column;flex:1 1 auto;width:100%;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;min-height:0;height:calc(var(--dsh-conversation-viewport-height,100%) - var(--dsh-composer-height,0px))}
.prr-top{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:7px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.prr-title{flex:0 0 auto;font-weight:600;font-size:13px}
.prr-select{height:28px;max-width:680px;min-width:280px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:12.5px/1 inherit;outline:none}
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
.prr-btn-icon{width:28px;padding:0;display:inline-flex;align-items:center;justify-content:center}
.prr-icon{width:14px;height:14px;display:block}
.prr-btn[data-busy="true"] .prr-icon{animation:prr-rotate .8s linear infinite}
@keyframes prr-rotate{to{transform:rotate(360deg)}}
.prr-banner{flex:0 0 auto;margin:8px 14px 0;padding:7px 10px;border-radius:8px;font-size:12.5px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 13%,transparent);color:var(--dsw-alias-state-error-primary);word-break:break-word}
.prr-body{flex:1;min-height:0;display:flex;overflow:hidden}
.prr-files{flex:0 1 246px;min-width:158px;display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.prr-pane-head{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:8px 12px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}
.prr-count{margin-left:auto;font-weight:500}
.prr-filelist{flex:0 1 auto;min-height:0;overflow:auto;padding:4px 0}
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
.prr-sev[data-sev="pass"]{background:var(--dsw-alias-state-success-primary)}
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
.prr-navrow-mark{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-secondary);opacity:.5;flex:0 0 auto}
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
.prr-unverified{opacity:.78;border-style:dashed}
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
.prr-roundpills{position:relative;flex:0 3 auto;min-width:140px;display:flex;align-items:center;overflow:hidden}
.prr-roundpills-scroll{display:flex;align-items:center;gap:6px;min-width:0;padding:1px 2px;scroll-padding-inline:6px;overflow-x:auto;overflow-y:hidden;white-space:nowrap;scrollbar-width:none;-ms-overflow-style:none}
.prr-roundpills-scroll::-webkit-scrollbar{display:none}
.prr-roundscroll{position:absolute;top:50%;z-index:2;display:none;align-items:center;justify-content:center;width:20px;height:22px;padding:0;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);box-shadow:0 1px 3px rgba(0,0,0,.16);cursor:pointer;transform:translateY(-50%)}
.prr-roundscroll[data-side="prev"]{left:0}
.prr-roundscroll[data-side="next"]{right:0}
.prr-roundpills[data-overflow="true"] .prr-roundscroll{display:inline-flex}
.prr-roundpills[data-at-start="true"] .prr-roundscroll[data-side="prev"]{display:none}
.prr-roundpills[data-at-end="true"] .prr-roundscroll[data-side="next"]{display:none}
.prr-roundscroll:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.prr-roundscroll:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.prr-roundscroll-icon{display:block;width:12px;height:12px}
.prr-roundpills[data-overflow="true"][data-at-start="false"] .prr-roundpills-scroll{-webkit-mask-image:linear-gradient(90deg,transparent 0,#000 16px,#000 100%);mask-image:linear-gradient(90deg,transparent 0,#000 16px,#000 100%)}
.prr-roundpills[data-overflow="true"][data-at-end="false"] .prr-roundpills-scroll{-webkit-mask-image:linear-gradient(90deg,#000 0,#000 calc(100% - 16px),transparent 100%);mask-image:linear-gradient(90deg,#000 0,#000 calc(100% - 16px),transparent 100%)}
.prr-roundpills[data-overflow="true"][data-at-start="false"][data-at-end="false"] .prr-roundpills-scroll{-webkit-mask-image:linear-gradient(90deg,transparent 0,#000 16px,#000 calc(100% - 16px),transparent 100%);mask-image:linear-gradient(90deg,transparent 0,#000 16px,#000 calc(100% - 16px),transparent 100%)}
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
.prr-conclusion-title{margin:0;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}
.prr-conclusion-ref{margin-top:6px;padding:2px 0 2px 8px;border-left:2px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:12px;word-break:break-word}
.prr-rownum{flex:0 0 auto;min-width:16px;text-align:right;color:var(--dsw-alias-label-secondary);font-size:11.5px;font-variant-numeric:tabular-nums}
.prr-nextbox{flex:0 0 auto;width:11px;height:11px;margin-top:3px;border:1.5px solid var(--dsw-alias-border-l1);border-radius:3px}
.prr-appendix{margin-top:10px;padding:2px 10px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.prr-appendix summary{padding:6px 0;cursor:pointer;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.prr-appendix-section{margin-top:10px}
.prr-appendix-line{font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary);word-break:break-word}
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
.prr-spinner-sm{width:10px;height:10px;border-radius:50%;border:1.5px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 30%,transparent);border-top-color:var(--dsw-alias-brand-primary);animation:prr-spin .8s linear infinite;flex:0 0 auto;display:inline-block;vertical-align:middle;margin-right:5px}
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
.prr-preview-refreshing{margin:0 0 8px;color:var(--dsw-alias-label-secondary);font-size:11px}
.prr-resizer{flex:0 0 5px;align-self:stretch;cursor:col-resize;background:transparent;position:relative;z-index:2;touch-action:none}
.prr-resizer::after{content:'';position:absolute;top:0;bottom:0;left:2px;width:1px;background:var(--dsw-alias-border-l1)}
.prr-resizer:hover::after{background:var(--dsw-alias-brand-primary)}
.prr-panel-footer{flex:0 0 auto;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);padding:8px 10px}
.prr-panel-footer .prr-dock{width:100%;margin:0;padding:0}
.prr-panel-footer .prr-dock .prr-actions{margin-left:auto}
.prr-panel-footer-extra{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:6px}
.prr-sidebar .prr-files{flex:0 0 146px;min-width:104px}
.prr-files-tail{flex:0 0 auto;border-top:1px solid var(--dsw-alias-border-l1)}
.prr-navrow-badge{margin-left:auto;flex:0 0 auto;font:11px/1.3 inherit;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.prr-navrow-badge[data-tone="ok"]{color:var(--dsw-alias-state-success-primary)}
.prr-navrow-badge[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary)}
.prr-navrow-badge[data-tone="info"]{color:var(--dsw-alias-state-info-primary, var(--dsw-alias-brand-primary))}
.prr-navrow-badge[data-tone="danger"]{color:var(--dsw-alias-state-error-primary)}
.prr-navrow-mark[data-tone="ok"]{background:var(--dsw-alias-state-success-primary);opacity:1}
.prr-navrow-mark[data-tone="warn"]{background:var(--dsw-alias-state-warn-primary);opacity:1}
.prr-navrow-mark[data-tone="info"]{background:var(--dsw-alias-state-info-primary, var(--dsw-alias-brand-primary));opacity:1}
.prr-navrow-mark[data-tone="danger"]{background:var(--dsw-alias-state-error-primary);opacity:1}
.prr-phasebar{display:flex;gap:10px;align-items:center;padding:6px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);font:12px/1.4 inherit;color:var(--dsw-alias-label-secondary)}
.prr-finding{border-bottom:1px dashed var(--dsw-alias-border-l1)}
.prr-finding:last-child{border-bottom:0}
.prr-finding-head{display:flex;align-items:flex-start;gap:6px;width:100%;padding:6px 10px;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer}
.prr-finding-point{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.prr-finding-caret{flex:0 0 auto;color:var(--dsw-alias-label-secondary)}
.prr-finding-detail{padding:2px 10px 8px 10px}
.prr-completeness{padding:6px 10px;font:12px/1.5 inherit;color:var(--dsw-alias-label-secondary)}
.prr-include{display:inline-flex;align-items:center;flex:0 0 auto;cursor:pointer}
.prr-preview-section{margin-top:8px}
.prr-preview-section .prr-dock-toggle{width:100%;border:0;background:transparent;color:var(--dsw-alias-label-primary);padding:4px 0;text-align:left;cursor:pointer}
.prr-sidebar .prr-detail{flex:0 0 224px;min-width:176px}
.prr-sidebar .prr-diffcol{min-width:176px}
.prr-sidebar .prr-top{padding:6px 8px;gap:6px}
.prr-sidebar .prr-select{min-width:110px;max-width:260px}
.prr-subseg{flex:0 0 auto;display:flex;gap:2px;padding:2px;border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.prr-subseg-btn{height:22px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:12px/1 inherit;cursor:pointer;white-space:nowrap}
.prr-subseg-btn[data-active="true"]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-weight:600}
.prr-sidebar .prr-roundpills{min-width:0}
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
      return h(Pill, { tone: verdictTone(verdict), label: severityLabel(verdict, t) });
    }

    function Btn(props) {
      const className = [
        'prr-btn',
        props.small ? 'prr-btn-sm' : '',
        props.primary ? 'prr-btn-primary' : '',
        props.iconOnly === true ? 'prr-btn-icon' : '',
      ]
        .filter((item) => item !== '')
        .join(' ');
      return h(
        'button',
        {
          type: 'button',
          className,
          title: props.title,
          'aria-label': props.ariaLabel,
          'data-busy': props.busy === true ? 'true' : undefined,
          disabled: props.disabled === true,
          onClick: props.disabled === true ? undefined : props.onClick,
        },
        props.icon === undefined ? props.label : props.icon,
      );
    }

    /** Inline refresh glyph: the project ships no icon library, so the icon is an SVG here. */
    function RefreshIcon() {
      return h(
        'svg',
        {
          className: 'prr-icon',
          width: 14,
          height: 14,
          viewBox: '0 0 16 16',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', {
          d: 'M13.2 8a5.2 5.2 0 1 1-1.7-3.85',
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': 1.6,
          'stroke-linecap': 'round',
        }),
        h('path', {
          d: 'M13.4 1.9v3.1h-3.1',
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': 1.6,
          'stroke-linecap': 'round',
          'stroke-linejoin': 'round',
        }),
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
     * A usable batch progress: the host always sends a positive total while a batch runs.
     * The file column and the poll loop share this so one cannot call it a batch while the
     * other treats it as no batch.
     */
    function isAnalyzing(analyzing) {
      return analyzing !== null
        && analyzing !== undefined
        && typeof analyzing.total === 'number'
        && analyzing.total > 0;
    }

    return {
        api, postJson, formatClock, formatStamp, fill, reviewAskContext,
        shortSha, roundsOf, applyRoundSelection, versionsOf, publishedOfRound, staleInfoOf,
        roundStripStateOf, scrollRoundStrip, revealActiveRound, shouldShowReviewButton,
        isRoundVersionPublished, previewConflictOf, roundPillOf, panelSizing, clampColumnWidth,
        sidebarReviewAddress, parseSidebarReviewAddress, actionsBridge, fileContentCache,
        fileContentKey, STAGE_KEY, scrollToNewLine, fileLineLabel, previewItemsOf,
        previewSelectionSupported, selectionIncludeIds, buildPreviewBody, buildPublishBody, text,
        severityLabel, fileSeverityOf, STATUS_KEY, cleanStepTitle,
        parseUnifiedDiff, mapWalkthroughToHunks, hunkRange, CSS,
        findingKey, FEEDBACK_LABEL_KEYS, VerdictPill, Btn, RefreshIcon, FileRow, isAnalyzing,
        derivePhase, shouldAutoSwitchPhase, overviewFooterVisible, phaseStateText, overviewStateText,
        conclusionBadgeText, conclusionBadgeTone, processBadgeTone, filesBadgeTone,
    };
  },
});

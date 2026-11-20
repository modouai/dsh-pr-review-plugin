// Package-local browser chunk. Registered by __ModuleLoader__.load and materialized on
// first require.async from client.js; it shares no scope with the entry.
window.__ModuleLoader__.load({
  id: '@modouai/dsh-pr-review',
  chunk: 'client.components.js',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Reusable chrome: top bar, round strip and version controls. */
    return function createComponents({ core }) {
      const {
        Btn, RefreshIcon, text, fill, formatStamp, shortSha, roundPillOf,
        roundStripStateOf, scrollRoundStrip, revealActiveRound,
      } = core;

      /**
       * Top-bar round strip: clickable status pills (reusing the round chip styling) with the
       * latest round tagged. Overflowing histories show edge arrows so the newest rounds are
       * discoverable; the selected pill is scrolled back into view on every change.
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
        const roundCount = Array.isArray(rounds) ? rounds.length : 0;
        const scrollRef = React.useRef(null);
        const [strip, setStrip] = React.useState({ overflow: false, atStart: true, atEnd: true });
        const syncStrip = React.useCallback(() => {
          const next = roundStripStateOf(scrollRef.current);
          // Scroll fires per frame: keep the same object when nothing changed to avoid churn.
          setStrip((current) => (
            current.overflow === next.overflow
              && current.atStart === next.atStart
              && current.atEnd === next.atEnd
              ? current
              : next
          ));
        }, []);

        // Re-measure when the number of pills, a pill's text or the available width changes.
        React.useEffect(() => {
          const scroller = scrollRef.current;
          syncStrip();
          if (scroller === null) return undefined;
          const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(syncStrip) : null;
          if (observer !== null) observer.observe(scroller);
          return () => {
            if (observer !== null) observer.disconnect();
          };
        }, [syncStrip, rounds, latestText]);

        // Keep the selected pill (the latest by default) visible after a switch or a new round.
        React.useEffect(() => {
          revealActiveRound(scrollRef.current);
          syncStrip();
        }, [selectedRoundNumber, roundCount, syncStrip]);

        if (roundCount === 0) return null;
        const pills = rounds.map((round) =>
          roundPillOf(round, latestRoundNumber, latestText, latestTone, published, t));
        const scrollButton = (side, label) =>
          h(
            'button',
            {
              type: 'button',
              className: 'prr-roundscroll',
              'data-side': side,
              'aria-label': label,
              title: label,
              tabIndex: strip.overflow ? 0 : -1,
              disabled: strip.overflow !== true || (side === 'prev' ? strip.atStart : strip.atEnd),
              onClick: () => {
                scrollRoundStrip(scrollRef.current, side === 'prev' ? -1 : 1);
              },
            },
            h(ChevronIcon, { direction: side }),
          );
        return h(
          'div',
          {
            className: 'prr-roundpills',
            'data-overflow': strip.overflow ? 'true' : 'false',
            'data-at-start': strip.atStart ? 'true' : 'false',
            'data-at-end': strip.atEnd ? 'true' : 'false',
          },
          scrollButton('prev', t('roundScrollPrev')),
          h(
            'div',
            {
              className: 'prr-roundpills-scroll',
              role: 'tablist',
              'aria-label': t('roundTabsLabel'),
              ref: scrollRef,
              onScroll: syncStrip,
            },
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
          scrollButton('next', t('roundScrollNext')),
        );
      }

      /** Inline chevron for the round-strip arrows (no icon library in the project). */
      function ChevronIcon(props) {
        return h(
          'svg',
          {
            className: 'prr-roundscroll-icon',
            width: 12,
            height: 12,
            viewBox: '0 0 16 16',
            'aria-hidden': 'true',
            focusable: 'false',
          },
          h('path', {
            d: props.direction === 'prev' ? 'M9.8 3.5 5.3 8l4.5 4.5' : 'M6.2 3.5 10.7 8l-4.5 4.5',
            fill: 'none',
            stroke: 'currentColor',
            'stroke-width': 1.8,
            'stroke-linecap': 'round',
            'stroke-linejoin': 'round',
          }),
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

      /** Workspace comparison: the baseline findings vs this round (review-delta spec v6). */
      function DeltaBlock(props) {
        const { delta, t } = props;
        if (delta === null || delta === undefined) return null;
        const resolved = Array.isArray(delta.resolved) ? delta.resolved : [];
        const stillOpen = Array.isArray(delta.stillOpen) ? delta.stillOpen : [];
        const undetermined = Array.isArray(delta.undetermined) ? delta.undetermined : [];
        const pending = Array.isArray(delta.pending) ? delta.pending : [];
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
              `${fill(t('deltaBaseline'), { round: String(delta.baselineRound ?? '?') })}：${t('deltaResolved')} ${resolved.length} · ${t('deltaStillOpen')} ${stillOpen.length + undetermined.length}${pending.length > 0 ? ` · ${t('deltaPending')} ${pending.length}` : ''}`,
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
                    h('li', { key: `s-${index}` }, `${t('deltaStillOpen')}：${describe(item.previous ?? item)}`),
                  ),
                ),
            undetermined.length === 0
              ? null
              : h(
                  'ul',
                  { className: 'prr-delta-list' },
                  undetermined.map((item, index) =>
                    h('li', { key: `u-${index}` }, `${describe(item)}（${t('deltaUnjudged')}）`),
                  ),
                ),
            pending.length === 0
              ? null
              : h(
                  'ul',
                  { className: 'prr-delta-list' },
                  pending.map((item, index) =>
                    h('li', { key: `p-${index}` }, `${describe(item)}（${t('deltaPending')}）`),
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
          showReview,
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
          h(Btn, {
            icon: h(RefreshIcon),
            iconOnly: true,
            ariaLabel: listBusy ? t('refreshing') : t('refresh'),
            title: t('refreshHint').replace('{time}', lastPoll ?? ''),
            small: true,
            busy: listBusy === true,
            disabled: listBusy === true,
            onClick: onRefresh,
          }),
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
          showReview === false
            ? null
            : h(Btn, {
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

      return {
        DetailHeader, TopBar, RoundPills, RoundMeta, DeltaBlock,
      };
    };
  },
});

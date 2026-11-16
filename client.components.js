// Package-local browser chunk. Registered by __ModuleLoader__.load and materialized on
// first require.async from client.js; it shares no scope with the entry.
window.__ModuleLoader__.load({
  id: '@modouai/dsh-pr-review',
  chunk: 'client.components.js',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Reusable chrome: top bar, round strip and version controls, risk/order lists. */
    return function createComponents({ core }) {
      const {
        Btn, VerdictPill, text, fill, formatStamp, shortSha, roundPillOf,
      } = core;

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

      function RiskList(props) {
        const list = props.risks ?? [];
        if (list.length === 0) {
          // An empty list has three different meanings; say which one so "no risks found"
          // cannot hide triage work that the verifier threw away.
          const raised = typeof props.raised === 'number' ? props.raised : 0;
          const discarded = typeof props.discarded === 'number' ? props.discarded : 0;
          const unverifiedCount = typeof props.unverifiedCount === 'number' ? props.unverifiedCount : 0;
          const label = raised > 0
            ? fill(props.t('noInitialRisksDetail'), { raised, unverified: unverifiedCount, discarded })
            : props.t('noInitialRisks');
          return h('div', { className: 'prr-subtle' }, label);
        }
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

      return {
        DetailHeader, TopBar, RoundPills, VersionSelector, RoundMeta, DeltaBlock, RiskList,
      };
    };
  },
});

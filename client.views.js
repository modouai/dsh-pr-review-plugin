// Package-local browser chunk. Registered by __ModuleLoader__.load and materialized on
// first require.async from client.js; it shares no scope with the entry.
window.__ModuleLoader__.load({
  id: '@modouai/dsh-pr-review',
  chunk: 'client.views.js',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Pane content: file list, diff and full-file views, overview and the diff column. */
    return function createViews({
      core, components, conclusion,
    }) {
      const {
        Btn, FileRow, VerdictPill, isAnalyzing, fill, text, suggestionText, cleanStepTitle,
        parseUnifiedDiff, hunkRange, mapWalkthroughToHunks, publishedOfRound, roundsOf,
        staleInfoOf, versionsOf, isRoundVersionPublished, STATUS_KEY, actionsBridge,
      } = core;
      const {
        OrderList, RiskList, RoundMeta, DeltaBlock, VersionSelector,
      } = components;
      const {
        ConclusionBlock, FeedbackBlock, PublishedBlock, conclusionMetaLine, overviewFooter,
      } = conclusion;

      /**
       * Left column: the overview entry, the changed-file header, then the file list. The review
       * detail area switches between the overview and a file; that entry lives here so it stays
       * in one place instead of moving with the pane headers.
       */
      function FilesPane(props) {
        const { t, overviewMode, onSelectOverview, files, filePath, review, onOpenFile } = props;
        const width = typeof props.width === 'number' && props.width > 0 ? props.width : 0;
        const style = width === 0 ? undefined : { flex: `0 0 ${width}px`, minWidth: `${width}px` };
        // A batch always reports a positive total; anything else is not usable progress and
        // falls back to the plain file count instead of showing "0/0".
        const analyzing = isAnalyzing(props.analyzing) ? props.analyzing : null;
        const done = analyzing === null ? 0 : Math.min(Math.max(analyzing.done ?? 0, 0), analyzing.total);
        const failed = analyzing === null ? 0 : Math.min(Math.max(analyzing.failed ?? 0, 0), analyzing.total);
        const countLabel = analyzing === null
          ? `${files.length} ${t('fileUnit')}`
          : fill(t('analyzingFiles'), { done, total: analyzing.total })
            + (failed > 0 ? fill(t('analyzingFailed'), { failed }) : '');
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
            h('span', { className: 'prr-count', title: analyzing === null ? undefined : analyzing.current }, countLabel),
            props.manual === true && analyzing === null && files.length > 0
              ? h(Btn, {
                  small: true,
                  label: props.analyzeAllBusy === true ? t('explaining') : t('analyzeAll'),
                  title: t('analyzeAllHint'),
                  disabled: props.analyzeAllBusy === true,
                  onClick: () => props.onAnalyzeAll(),
                })
              : null,
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
        const unverified = (detail.unverified ?? []).length === 0
          ? null
          : h(
              'div',
              null,
              h('div', { className: 'prr-h2' }, t('unverified')),
              h(
                'div',
                { className: 'prr-card prr-unverified' },
                h('div', { className: 'prr-subtle' }, t('unverifiedHint')),
                detail.unverified.map((item, index) =>
                  h(
                    'div',
                    { className: 'prr-rowitem', key: index },
                    h(
                      'div',
                      { className: 'prr-rowmain' },
                      h('div', { className: 'prr-text' }, item.point),
                      item.missing === ''
                        ? null
                        : h('div', { className: 'prr-subtle' }, `${t('unverifiedMissing')}${item.missing}`),
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
                detail.suggestions.map((item, index) => {
                  const text = suggestionText(item);
                  return text === '' ? null : h(
                    'div',
                    { className: 'prr-rowitem', key: index },
                    h('div', { className: 'prr-rowmain prr-text' }, text),
                  );
                }),
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
          unverified,
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
          hasVersion: versions.length > 0,
          selectedPublished: selectedVersion !== null
            && isRoundVersionPublished(publishedEntries, roundNumber, selectedVersion.version),
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
          (report.unverified ?? []).length === 0
            ? null
            : h(
                'div',
                null,
                h('div', { className: 'prr-h2' }, t('unverified')),
                h(
                  'div',
                  { className: 'prr-card prr-unverified' },
                  h('div', { className: 'prr-subtle' }, t('unverifiedHint')),
                  report.unverified.map((item, index) =>
                    h(
                      'div',
                      { className: 'prr-rowitem', key: index },
                      h(
                        'div',
                        { className: 'prr-rowmain' },
                        h('div', { className: 'prr-text' }, item.point),
                        item.missing === ''
                          ? null
                          : h('div', { className: 'prr-subtle' }, `${t('unverifiedMissing')}${item.missing}`),
                      ),
                    ),
                  ),
                ),
              ),
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
                    (group.suggestions ?? []).map((item, index) => {
                      const text = suggestionText(item);
                      return text === '' ? null : h(
                        'div',
                        { className: 'prr-rowitem', key: `suggestion-${index}` },
                        h('span', { className: 'prr-tag' }, t('suggestionTag')),
                        h('div', { className: 'prr-rowmain prr-text' }, text),
                      );
                    }),
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

      /** Content pane: one of the empty states, the review error, or the open file's diff. */
      function WorkspaceCenter({ model }) {
        const {
          t, prNumber, list, review, filePath, startReview,
          currentLogic, currentWalkthrough, openWalkFloat,
          showFullFile, fileContentBusy, fileContent, toggleFullFile, wrap, setWrap,
          fileDiff, diffScrollRef, activeHunk, expandedHunks, collapseHunkContext, setActiveHunk,
        } = model;
        const reviewing = review !== null && review.status === 'reviewing';
        const selectedFile = review?.files?.find((file) => file.path === filePath) ?? null;

        if (prNumber === null && (list === null || (list.prs ?? []).length === 0)) {
          return h('div', { className: 'prr-zero' }, list === null ? t('loading') : t('emptyPr'));
        }
        if (reviewing) {
          return h('div', { className: 'prr-zero' }, t('reviewing'));
        }
        if (review !== null && review.status === 'error') {
          return h(
            'div',
            { className: 'prr-zero' },
            h('div', { className: 'prr-banner', style: { margin: '0 0 8px' } }, review.error ?? t('statusError')),
            h(Btn, { label: t('retry'), onClick: () => void startReview(true) }),
          );
        }
        if (filePath === '') {
          return h('div', { className: 'prr-zero' }, review === null || review.report === null ? t('emptyReview') : t('emptyFile'));
        }

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
        return h('div', { className: 'prr-diffcol' }, head, body);
      }

      return {
        FilesPane, DiffView, FullFileView, FileDetailPanel, ChatBox, OverviewPanel, WorkspaceCenter,
      };
    };
  },
});

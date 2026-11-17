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
        staleInfoOf, versionsOf, isRoundVersionPublished, STATUS_KEY, actionsBridge, shortSha,
        phaseStateText, conclusionBadgeText, fileLineLabel,
      } = core;
      const {
        RoundMeta, DeltaBlock, VersionSelector,
      } = components;
      const {
        ConclusionBlock, FeedbackBlock, PublishedBlock, conclusionMetaLine, overviewFooter,
        ConcludingProgress,
      } = conclusion;

      /**
       * Left column: the overview entry, the changed-file header, the file list, and — pinned
       * to the bottom regardless of list length — the conclusion entry. The rail order is the
       * review's reading order: overview, files, conclusion; badges carry the live state.
       */
      function FilesPane(props) {
        const {
          t, overviewMode, conclusionMode, onSelectOverview, onSelectConclusion,
          files, filePath, review, onOpenFile, phase,
        } = props;
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
            h('span', { className: 'prr-navrow-badge' }, phaseStateText(phase, t)),
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
          h(
            'div',
            { className: 'prr-files-tail' },
            h(
              'button',
              {
                type: 'button',
                className: 'prr-navrow',
                'data-active': conclusionMode === true ? 'true' : 'false',
                onClick: () => onSelectConclusion(),
              },
              h('span', { className: 'prr-navrow-mark' }),
              t('conclusionNav'),
              h('span', { className: 'prr-navrow-badge' }, conclusionBadgeText(phase, t)),
            ),
          ),
        );
      }

      /** One shared status line: the round plus the single derived phase. */
      function PhaseBar(props) {
        const { phase, round, t } = props;
        if (phase === null || phase === undefined) return null;
        return h(
          'div',
          { className: 'prr-phasebar' },
          h('span', null, fill(t('phaseRound'), { round: round ?? 1 })),
          h('span', null, phaseStateText(phase, t)),
        );
      }

      /**
       * Flatten the per-file findings into the page's single ordered list: block first, then
       * suggest, then suggestions; ties break by path and line. This is the one place the
       * overview speaks about findings — detail pages and the conclusion reference, not repeat.
       */
      function findingsOf(groups) {
        const rows = [];
        for (const group of Array.isArray(groups) ? groups : []) {
          if (group === null || typeof group !== 'object') continue;
          const file = typeof group.file === 'string' ? group.file : '';
          for (const issue of Array.isArray(group.issues) ? group.issues : []) {
            if (issue === null || typeof issue !== 'object') continue;
            const point = typeof issue.point === 'string' ? issue.point.trim() : '';
            if (point === '') continue;
            rows.push({
              kind: 'issue',
              severity: issue.severity === 'block' ? 'block' : 'suggest',
              file,
              line: Number.isFinite(issue.line) && issue.line > 0 ? Math.floor(issue.line) : 0,
              point,
            });
          }
          for (const suggestion of Array.isArray(group.suggestions) ? group.suggestions : []) {
            const point = suggestionText(suggestion).trim();
            if (point === '') continue;
            rows.push({ kind: 'suggestion', severity: 'suggestion', file, line: 0, point });
          }
        }
        const rank = { block: 0, suggest: 1, suggestion: 2 };
        rows.sort((a, b) => rank[a.severity] - rank[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
        return rows;
      }

      /** The expandable findings list: one row per finding, detail unfolds in place. */
      function FindingList(props) {
        const { groups, t, onOpenFile } = props;
        const rows = findingsOf(groups);
        const [openKey, setOpenKey] = React.useState(null);
        if (rows.length === 0) return h('div', { className: 'prr-subtle' }, t('findingListEmpty'));
        return h(
          'div',
          { className: 'prr-card' },
          rows.map((row, index) => {
            const key = `${row.kind}-${row.file}-${row.line}-${index}`;
            const open = openKey === key;
            const label = row.file === '' ? row.point : `${fileLineLabel(row.file, row.line)} — ${row.point}`;
            return h(
              'div',
              { className: 'prr-finding', key },
              h(
                'button',
                {
                  type: 'button',
                  className: 'prr-finding-head',
                  'data-open': open ? 'true' : 'false',
                  title: row.point,
                  onClick: () => setOpenKey(open ? null : key),
                },
                row.kind === 'suggestion'
                  ? h('span', { className: 'prr-tag' }, t('suggestionTag'))
                  : h(VerdictPill, { verdict: row.severity, t }),
                h('span', { className: 'prr-finding-point' }, label),
                h('span', { className: 'prr-finding-caret', 'aria-hidden': 'true' }, open ? '▾' : '▸'),
              ),
              open
                ? h(
                    'div',
                    { className: 'prr-finding-detail' },
                    h('div', { className: 'prr-text' }, row.point),
                    row.file === ''
                      ? null
                      : h(
                          'button',
                          {
                            type: 'button',
                            className: 'prr-linklike',
                            onClick: () => onOpenFile(row.file, row.line),
                          },
                          t('findingOpenContext'),
                        ),
                  )
                : null,
            );
          }),
        );
      }

      /** How many finished analyses found no issues: the review's visible negative result. */
      function cleanCountOf(review) {
        const entries = Array.isArray(review?.explanations) ? review.explanations : [];
        let done = 0;
        let clean = 0;
        for (const entry of entries) {
          if (entry === null || typeof entry !== 'object') continue;
          if (entry.status !== 'done' || entry.explanation === null || entry.explanation === undefined) continue;
          done += 1;
          const issues = Array.isArray(entry.explanation.issues) ? entry.explanation.issues : [];
          if (issues.length === 0) clean += 1;
        }
        return { done, clean };
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

      /**
       * Points the verifier could not confirm: they get their own block so they are never
       * mistaken for findings. Malformed entries are dropped instead of leaking "undefined".
       */
      function UnverifiedBlock(props) {
        const { t } = props;
        const list = (Array.isArray(props.items) ? props.items : []).filter(
          (item) => item !== null && typeof item === 'object' && typeof item.point === 'string' && item.point.trim() !== '',
        );
        if (list.length === 0) return null;
        return h(
          'div',
          null,
          h('div', { className: 'prr-h2' }, t('unverified')),
          h(
            'div',
            { className: 'prr-card prr-unverified' },
            h('div', { className: 'prr-subtle' }, t('unverifiedHint')),
            list.map((item, index) =>
              h(
                'div',
                { className: 'prr-rowitem', key: index },
                h(
                  'div',
                  { className: 'prr-rowmain' },
                  h('div', { className: 'prr-text' }, item.point),
                  typeof item.missing === 'string' && item.missing !== ''
                    ? h('div', { className: 'prr-subtle' }, `${t('unverifiedMissing')}${item.missing}`)
                    : null,
                ),
              ),
            ),
          ),
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
        const unverified = h(UnverifiedBlock, { t, items: detail.unverified });
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
       * Overview page: the fix record first (round >= 2), then the change digest, the single
       * findings list and the completeness line. Only verified facts and pending actions live
       * here — initial-screen risks, unverified notes and the report verdict are pipeline
       * internals and never render; the only decision surface is the conclusion page.
       */
      function OverviewPage(props) {
        const { review, t } = props;
        const report = review.report;
        const rounds = React.useMemo(() => roundsOf(review), [review]);
        const latestRound = rounds.length === 0 ? null : rounds[rounds.length - 1];
        const requestedRound = typeof props.selectedRoundNumber === 'number' ? props.selectedRoundNumber : null;
        const selectedRound = requestedRound === null
          ? latestRound
          : (rounds.find((entry) => entry.round === requestedRound) ?? latestRound);
        const roundNumber = selectedRound === null ? 1 : selectedRound.round;
        const isCurrent = latestRound === null || selectedRound === null || selectedRound.round === latestRound.round;
        const feedback = isCurrent ? (review.feedback ?? selectedRound?.feedback ?? null) : (selectedRound?.feedback ?? null);
        const delta = isCurrent ? (review.delta ?? selectedRound?.delta ?? null) : (selectedRound?.delta ?? null);
        const anyPublished = Array.isArray(review.published) && review.published.length > 0;

        // The whole-review footer (conclusion/publish actions plus notices) is rendered above
        // the composer by whichever surface owns it; both surfaces read it from `actionsBridge`.
        // Hooks run unconditionally and BEFORE any early return: `overviewFooter` answers
        // `{ actions: null, notice: null }` for pending and historical rounds, so the dock
        // clears there instead of going stale — and the hook count never varies by path.
        const footer = overviewFooter(props, {
          report,
          pull: review.pull ?? {},
          selectedVersion: null,
          staleInfo: null,
          isCurrent,
          isOlderVersion: false,
          hasVersion: false,
          selectedPublished: false,
          page: 'overview',
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
        // its own feedback/delta even though `record.report` is reset on a new round.
        if ((report === null || report === undefined) && isCurrent) {
          return h('div', { className: 'prr-zero' }, review.status === 'reviewing' ? t('reportPending') : t('noReport'));
        }

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

        if (!isCurrent) {
          return h(
            'div',
            null,
            roundTop,
            h('div', { className: 'prr-zero' }, t('historyNoReport')),
          );
        }

        const findingCount = (props.fileFindings ?? []).reduce(
          (sum, group) => sum + (group.issues?.length ?? 0) + (group.suggestions?.length ?? 0),
          0,
        );
        const clean = cleanCountOf(review);
        const coverage = review.coverage ?? null;
        const analyzed = coverage !== null && typeof coverage.analyzed === 'number'
          ? coverage.analyzed
          : (typeof props.explainedCount === 'number' ? props.explainedCount : clean.done);
        const total = coverage !== null && typeof coverage.total === 'number' ? coverage.total : (props.totalFiles ?? 0);

        return h(
          'div',
          null,
          roundTop,
          h('div', { className: 'prr-h2' }, t('digestTitle')),
          h('div', { className: 'prr-card' }, h('div', { className: 'prr-text' }, report.summary)),
          h('div', { className: 'prr-h2' }, `${t('findingList')} · ${findingCount}`),
          h(FindingList, { groups: props.fileFindings ?? [], t, onOpenFile: props.onOpenFile }),
          h('div', { className: 'prr-h2' }, t('completenessTitle')),
          h(
            'div',
            { className: 'prr-completeness' },
            fill(t('completenessCoverage'), { analyzed, total }),
            clean.clean > 0 ? ` · ${fill(t('completenessClean'), { clean: clean.clean })}` : null,
          ),
        );
      }

      /** Collapsible live comment preview: what the current selection will post. */
      function PublishPreviewSection(props) {
        const { preview, busy, refreshing, t } = props;
        const [open, setOpen] = React.useState(false);
        if (preview === null || preview === undefined) return null;
        return h(
          'div',
          { className: 'prr-preview-section' },
          h(
            'button',
            { type: 'button', className: 'prr-dock-toggle', onClick: () => setOpen(!open) },
            h('span', { 'aria-hidden': 'true' }, open ? '▾' : '▸'),
            t('publishPreviewSection'),
            busy === true || refreshing === true
              ? h('span', { className: 'prr-subtle' }, refreshing === true ? t('previewRefreshing') : t('previewLoading'))
              : null,
          ),
          open ? h('pre', { className: 'prr-markdown' }, text(preview.markdown)) : null,
        );
      }

      /**
       * Conclusion page: the versioned decision (card, items with publish toggles, next
       * steps), the live comment preview, published records and the action footer. Dialogue
       * records (author replies, cross-round delta) live on the overview page.
       */
      function ConclusionPage(props) {
        const { review, t } = props;
        const rounds = React.useMemo(() => roundsOf(review), [review]);
        const latestRound = rounds.length === 0 ? null : rounds[rounds.length - 1];
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
        const feedback = isCurrent ? (review.feedback ?? selectedRound?.feedback ?? null) : (selectedRound?.feedback ?? null);
        const feedbackStates = feedback?.states ?? {};

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
            : h('span', { className: 'prr-tag' }, t(selectedVersion.source === 'human' ? 'versionSourceHuman' : 'versionSourceModel')),
          isOlderVersion === true ? h('span', { className: 'prr-tag' }, t('versionReadOnly')) : null,
        );

        const footer = overviewFooter(props, {
          report: review.report ?? null,
          pull: review.pull ?? {},
          selectedVersion,
          staleInfo: props.staleInfo ?? null,
          isCurrent,
          isOlderVersion,
          hasVersion: versions.length > 0,
          selectedPublished: isRoundVersionPublished(
            publishedEntries,
            roundNumber,
            selectedVersion === null ? 0 : selectedVersion.version,
          ),
          page: 'conclusion',
        });
        React.useEffect(() => {
          actionsBridge.set(footer.actions);
          actionsBridge.setNotice(footer.notice);
          return undefined;
        }, [footer.actions, footer.notice]);
        React.useEffect(() => () => {
          actionsBridge.set(null);
          actionsBridge.setNotice(null);
        }, []);

        if (!isCurrent) {
          return h(
            'div',
            null,
            h(RoundMeta, { round: selectedRound, t }),
            selectedVersion === null || selectedVersion === undefined
              ? h('div', { className: 'prr-subtle' }, t('historyNoConclusion'))
              : h(ConclusionBlock, {
                  conclusion: selectedVersion.conclusion,
                  t,
                  onOpenFile: props.onOpenFile,
                  feedbackStates,
                  headerExtra: versionHeader,
                  metaLine: selectedVersion === null ? null : conclusionMetaLine(review, roundNumber, selectedVersion, publishedEntries, isCurrent, t),
                }),
            roundNumber >= 2 ? h(DeltaBlock, { delta: selectedRound?.delta ?? null, t }) : null,
            h(PublishedBlock, { entries: publishedEntries, t }),
            h('div', { className: 'prr-subtle', style: { marginTop: '10px' } }, t('historyReadOnly')),
          );
        }

        if (selectedVersion === null || selectedVersion === undefined) {
          const concluding = props.concluding ?? null;
          const coverage = review.coverage ?? null;
          return h(
            'div',
            null,
            h(
              'div',
              { className: 'prr-card' },
              concluding !== null
                ? h(ConcludingProgress, { concluding, t, cancelBusy: props.cancelBusy, onCancel: props.onCancelConclude })
                : h('div', { className: 'prr-zero' }, t('conclusionPendingCard')),
            ),
            h(
              'div',
              { className: 'prr-completeness' },
              coverage !== null && coverage !== undefined
                ? fill(t('metaCoverage'), { analyzed: coverage.analyzed ?? 0, total: coverage.total ?? 0 })
                : fill(t('metaCoverage'), { analyzed: props.explainedCount ?? 0, total: props.totalFiles ?? 0 }),
            ),
            concluding === null
              ? h(Btn, {
                  label: t('conclude'),
                  primary: true,
                  disabled: props.concludeBusy === true || props.reviewBusy === true,
                  onClick: props.onConclude,
                })
              : null,
          );
        }

        const selectedIds = props.preview !== null && props.preview !== undefined && Array.isArray(props.preview.selectedIds)
          ? props.preview.selectedIds
          : null;
        // An older version's publish is disabled: leaving its checkboxes live would let a
        // toggle write an id the next preview (always the newest version) never asked for.
        const includeControl = props.preview !== null && props.preview !== undefined
          && props.preview.selectionSupported === true
          && isOlderVersion !== true
          ? {
              isSelected: (id) => (selectedIds === null ? true : selectedIds.includes(id)),
              onToggle: props.onToggleInclude,
            }
          : null;
        const metaLine = conclusionMetaLine(review, roundNumber, selectedVersion, publishedEntries, isCurrent, t);

        return h(
          'div',
          null,
          h(ConclusionBlock, {
            conclusion: selectedVersion.conclusion,
            t,
            onOpenFile: props.onOpenFile,
            feedbackStates,
            headerExtra: versionHeader,
            metaLine,
            includeControl,
          }),
          h(PublishPreviewSection, {
            preview: props.preview,
            busy: props.previewBusy,
            refreshing: props.previewRefreshBusy,
            t,
          }),
          roundNumber >= 2
            ? h(DeltaBlock, { delta: review.delta ?? selectedRound?.delta ?? null, t })
            : null,
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
        FilesPane, PhaseBar, FindingList, findingsOf, cleanCountOf, DiffView, FullFileView,
        FileDetailPanel, ChatBox, OverviewPage, ConclusionPage, PublishPreviewSection, WorkspaceCenter,
      };
    };
  },
});

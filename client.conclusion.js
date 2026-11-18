// Package-local browser chunk. Registered by __ModuleLoader__.load and materialized on
// first require.async from client.js; it shares no scope with the entry.
window.__ModuleLoader__.load({
  id: '@modouai/dsh-pr-review',
  chunk: 'client.conclusion.js',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Conclusion, feedback and coverage rendering, plus the markdown renderer they share. */
    return function createConclusion({ core }) {
      const {
        Btn, fill, formatClock, shortSha, text, fileLineLabel, FEEDBACK_LABEL_KEYS,
        findingKey, STAGE_KEY,
      } = core;

      /** Inline markdown for platform text: code, bold, italic and http(s) links only. */
      function inlineMarkdown(source) {
        const nodes = [];
        const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\(https?:\/\/[^)\s]+\))|(\*[^*\n]+\*)/g;
        let last = 0;
        let match = pattern.exec(source);
        while (match !== null) {
          if (match.index > last) nodes.push(source.slice(last, match.index));
          const token = match[0];
          if (token.startsWith('`')) {
            nodes.push(h('code', { key: nodes.length }, token.slice(1, -1)));
          } else if (token.startsWith('**')) {
            nodes.push(h('strong', { key: nodes.length }, token.slice(2, -2)));
          } else if (token.startsWith('[')) {
            const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(token);
            nodes.push(link === null
              ? token
              : h('a', { key: nodes.length, href: link[2], target: '_blank', rel: 'noreferrer' }, link[1]));
          } else {
            nodes.push(h('em', { key: nodes.length }, token.slice(1, -1)));
          }
          last = match.index + token.length;
          match = pattern.exec(source);
        }
        if (last < source.length) nodes.push(source.slice(last));
        return nodes.length === 0 ? [source] : nodes;
      }

      /**
       * Minimal markdown renderer for text copied from the code platform (comments): headings,
       * lists, quotes, code fences, rules and paragraphs. It builds React nodes only, so platform
       * text is never injected as HTML — markup such as `<script>` stays literal.
       */
      function renderMarkdown(source) {
        const raw = typeof source === 'string' ? source.replace(/\r\n?/g, '\n') : '';
        if (raw.trim() === '') return null;
        const blocks = [];
        let paragraph = [];
        let list = null;
        let fence = null;
        const flushParagraph = () => {
          if (paragraph.length === 0) return;
          blocks.push(h('p', { key: `p${blocks.length}` }, inlineMarkdown(paragraph.join(' '))));
          paragraph = [];
        };
        const flushList = () => {
          if (list === null) return;
          blocks.push(h(
            list.ordered ? 'ol' : 'ul',
            { key: `l${blocks.length}`, className: 'prr-md-list' },
            list.items.map((item, index) => h('li', { key: index }, inlineMarkdown(item))),
          ));
          list = null;
        };
        for (const line of raw.split('\n')) {
          if (fence !== null) {
            if (/^\s*```/.test(line)) {
              blocks.push(h('pre', { key: `c${blocks.length}` }, fence.join('\n')));
              fence = null;
            } else {
              fence.push(line);
            }
            continue;
          }
          if (/^\s*```/.test(line)) {
            flushParagraph();
            flushList();
            fence = [];
            continue;
          }
          if (/^\s*$/.test(line)) {
            flushParagraph();
            flushList();
            continue;
          }
          if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
            flushParagraph();
            flushList();
            blocks.push(h('hr', { key: `h${blocks.length}` }));
            continue;
          }
          const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
          if (heading !== null) {
            flushParagraph();
            flushList();
            blocks.push(h(
              `h${Math.min(3, heading[1].length)}`,
              { key: `t${blocks.length}`, className: 'prr-md-h' },
              inlineMarkdown(heading[2]),
            ));
            continue;
          }
          const quote = /^\s*>\s?(.*)$/.exec(line);
          if (quote !== null) {
            flushParagraph();
            flushList();
            blocks.push(h('blockquote', { key: `q${blocks.length}` }, inlineMarkdown(quote[1])));
            continue;
          }
          const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
          if (ordered !== null) {
            flushParagraph();
            if (list === null || list.ordered !== true) {
              flushList();
              list = { ordered: true, items: [] };
            }
            list.items.push(ordered[1]);
            continue;
          }
          const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
          if (bullet !== null) {
            flushParagraph();
            if (list === null || list.ordered !== false) {
              flushList();
              list = { ordered: false, items: [] };
            }
            list.items.push(bullet[1]);
            continue;
          }
          flushList();
          paragraph.push(line.trim());
        }
        if (fence !== null) blocks.push(h('pre', { key: `c${blocks.length}` }, fence.join('\n')));
        flushParagraph();
        flushList();
        return blocks.length === 0 ? null : h('div', { className: 'prr-md' }, blocks);
      }

      /**
       * Full per-verdict labels for the mirrored conclusion title, matching the host's
       * comment heading (## PR 审查结论：<label> in llm.js COMMENT_VERDICT_LABELS).
       */
      const VERDICT_FULL_KEYS = {
        block: 'verdictFullBlock',
        suggest: 'verdictFullSuggest',
        pass: 'verdictFullPass',
      };

      function ConclusionBlock(props) {
        const conclusion = props.conclusion;
        if (conclusion === null || conclusion === undefined) return null;
        const states = props.feedbackStates ?? {};
        const include = props.includeControl ?? null;
        const pull = props.pull ?? null;
        const pullNumber = typeof pull?.number === 'number' && pull.number > 0 ? pull.number : 0;
        const pullTitle = typeof pull?.title === 'string' ? pull.title.trim() : '';
        // The chapter structure mirrors the published comment: items numbered continuously
        // across 阻塞项 → 修改建议 (llm.js commentItems), an explicit empty line where the
        // comment says 无阻塞项。/ 暂无。, no per-item verdict pill.
        const blockerList = conclusion.blockers ?? [];
        const section = (title, items, kind, emptyLabel, numberFrom) => {
          const list = items ?? [];
          return h(
            'div',
            null,
            h('div', { className: 'prr-h2' }, title),
            list.length === 0
              ? h('div', { className: 'prr-card' }, h('div', { className: 'prr-subtle' }, emptyLabel))
              : h(
                  'div',
                  { className: 'prr-card' },
                  list.map((item, index) => {
                    const idKey = typeof item.id === 'string' && item.id !== '' ? item.id : '';
                    const pointKey = findingKey(kind, item.file ?? '', item.point ?? '');
                    const state = states[idKey] ?? states[pointKey] ?? null;
                    const itemLine = Number.isFinite(item.line) && item.line > 0 ? Math.floor(item.line) : 0;
                    const fileLabel = fileLineLabel(item.file, itemLine);
                    return h(
                      'div',
                      { className: 'prr-rowitem', key: index },
                      include !== null && idKey !== ''
                        ? h(
                            'label',
                            { className: 'prr-include', title: props.t('publishInclude') },
                            h('input', {
                              type: 'checkbox',
                              checked: include.isSelected(idKey),
                              onChange: () => include.onToggle(idKey),
                            }),
                          )
                        : null,
                      h('span', { className: 'prr-rownum' }, `${(numberFrom ?? 1) + index}.`),
                      h(
                        'div',
                        { className: 'prr-rowmain' },
                        item.file === ''
                          ? null
                          : h(
                              'button',
                              {
                                type: 'button',
                                className: 'prr-linklike prr-filetag',
                                onClick: () => props.onOpenFile(item.file, itemLine),
                                title: fileLabel,
                              },
                              fileLabel,
                            ),
                        h(
                          'div',
                          { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
                          h('div', { className: 'prr-text', style: { flex: 1 } }, item.point),
                          state === null
                            ? null
                            : h(
                                'span',
                                { className: 'prr-fb-pill', 'data-status': state.status, title: state.reason ?? '' },
                                props.t(FEEDBACK_LABEL_KEYS[state.status] ?? 'fbQuestion'),
                              ),
                        ),
                        state === null || state.reason === '' ? null : h('div', { className: 'prr-fb-reason' }, state.reason),
                      ),
                    );
                  }),
                ),
          );
        };
        const nextSteps = conclusion.nextSteps ?? [];
        return h(
          'div',
          null,
          h(
            'div',
            { className: 'prr-conclusion-head' },
            h(
              'div',
              { className: 'prr-conclusion-title' },
              fill(props.t('conclusionTitle'), {
                verdict: props.t(VERDICT_FULL_KEYS[conclusion.verdict] ?? 'verdictFullSuggest'),
              }),
            ),
          ),
          pullNumber > 0 || pullTitle !== ''
            ? h(
                'div',
                { className: 'prr-conclusion-ref' },
                pullNumber > 0 ? `#${pullNumber}${pullTitle === '' ? '' : ` ${pullTitle}`}` : pullTitle,
              )
            : null,
          h(
            'div',
            { className: 'prr-card' },
            // The comment puts its commit/round/version line above the summary body; mirror that.
            props.metaLine === undefined || props.metaLine === null
              ? null
              : h('div', { className: 'prr-conclusion-meta' }, props.metaLine),
            h('div', { className: 'prr-text' }, conclusion.summary),
          ),
          section(props.t('blockers'), blockerList, 'blocker', props.t('noBlockers'), 1),
          section(props.t('suggestions'), conclusion.suggestions, 'suggestion', props.t('noneYet'), blockerList.length + 1),
          h(
            'div',
            null,
            h('div', { className: 'prr-h2' }, props.t('nextSteps')),
            nextSteps.length === 0
              ? h('div', { className: 'prr-card' }, h('div', { className: 'prr-subtle' }, props.t('noneYet')))
              : h(
                  'div',
                  { className: 'prr-card' },
                  nextSteps.map((step, index) =>
                    h(
                      'div',
                      { className: 'prr-rowitem', key: index },
                      h('span', { className: 'prr-nextbox', 'aria-hidden': 'true' }),
                      h('div', { className: 'prr-rowmain prr-text' }, step),
                    ),
                  ),
                ),
          ),
        );
      }

      /** Developer feedback on the published comment of the previous round. */
      function FeedbackBlock(props) {
        const { feedback, t, canCheck, onCheckFeedback, feedbackBusy, hasBaseline } = props;
        const comments = Array.isArray(feedback?.comments) ? feedback.comments : [];
        const notes = Array.isArray(feedback?.notes) ? feedback.notes : [];
        const emptyText = hasBaseline === true ? t('feedbackEmpty') : t('feedbackNoBaseline');
        return h(
          'div',
          null,
          h(
            'div',
            { style: { display: 'flex', gap: '8px', alignItems: 'center' } },
            h('div', { className: 'prr-h2', style: { margin: 0 } }, t('feedbackTitle')),
            canCheck === true
              ? h(Btn, {
                  label: feedbackBusy ? t('feedbackChecking') : t('feedbackCheck'),
                  small: true,
                  disabled: feedbackBusy === true,
                  onClick: onCheckFeedback,
                })
              : null,
          ),
          comments.length === 0 && notes.length === 0
            ? h('div', { className: 'prr-subtle', style: { marginTop: '6px' } }, emptyText)
            : h(
                'div',
                { className: 'prr-card', style: { marginTop: '6px' } },
                comments.map((comment, index) =>
                  h(
                    'div',
                    { className: 'prr-fb-comment', key: comment.id ?? index },
                    h('div', { className: 'prr-fb-meta' }, `${comment.author} · ${comment.createdAt}`),
                    h(
                      'div',
                      { className: 'prr-fb-body' },
                      renderMarkdown(comment.body) ?? h('span', null, text(comment.body)),
                    ),
                  ),
                ),
                notes.map((note, index) =>
                  h('div', { className: 'prr-fb-reason', key: `note-${index}` }, note),
                ),
              ),
        );
      }

      /** Published review comments that belong to one round. */
      function PublishedBlock(props) {
        const { entries, t } = props;
        if (!Array.isArray(entries) || entries.length === 0) return null;
        return h(
          'div',
          null,
          h('div', { className: 'prr-h2' }, t('publishedTitle')),
          h(
            'div',
            { className: 'prr-card' },
            entries.map((entry, index) =>
              h(
                'div',
                { className: 'prr-rowitem', key: entry.id ?? index },
                h(
                  'div',
                  { className: 'prr-rowmain' },
                  h(
                    'div',
                    { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
                    h(
                      'span',
                      { className: 'prr-subtle' },
                      [
                        typeof entry.round === 'number' ? `#${entry.round}` : '',
                        typeof entry.publishedAt === 'number' && entry.publishedAt > 0
                          ? formatClock(entry.publishedAt)
                          : '',
                      ]
                        .filter((part) => part !== '')
                        .join(' · '),
                    ),
                    typeof entry.url === 'string' && entry.url !== ''
                      ? h(
                          'a',
                          {
                            className: 'prr-linklike',
                            style: { width: 'auto', fontSize: '12px' },
                            href: entry.url,
                            target: '_blank',
                            rel: 'noreferrer',
                          },
                          t('commentLink'),
                        )
                      : null,
                  ),
                ),
              ),
            ),
          ),
        );
      }

      /**
       * Expanded body of the stale warning: which files (and the report) changed after the latest
       * conclusion, plus the analysis-coverage line when both apply.
       */
      function staleDetailOf(info, coverageIncomplete, autoReconclude, t) {
        const shown = info.files.slice(0, 5);
        const more = info.files.length - shown.length;
        return h(
          React.Fragment,
          null,
          info.reportNewer === true ? h('div', { className: 'prr-dock-tip' }, t('staleReport')) : null,
          shown.length === 0
            ? null
            : h(
                'ul',
                null,
                shown.map((file) => h('li', { key: file }, file)),
              ),
          more > 0 ? h('div', { className: 'prr-dock-tip' }, fill(t('staleMore'), { count: more })) : null,
          coverageIncomplete === true ? h('div', { className: 'prr-dock-tip' }, t('coverageIncomplete')) : null,
          autoReconclude === true ? h('div', { className: 'prr-dock-tip' }, t('autoReconcludeOn')) : null,
        );
      }

      /** Inline generation progress (stage text) with a cancel button. */
      function ConcludingProgress(props) {
        const { concluding, t, onCancel, cancelBusy } = props;
        const stageKey = typeof concluding?.stage === 'string' ? STAGE_KEY[concluding.stage] : undefined;
        return h(
          'div',
          { className: 'prr-progress' },
          h('span', { className: 'prr-spinner' }),
          h('span', null, stageKey === undefined
            ? t('concluding')
            : fill(t('concludingStage'), { stage: t(stageKey) })),
          h(Btn, {
            label: cancelBusy === true ? t('cancelBusy') : t('cancel'),
            small: true,
            disabled: cancelBusy === true,
            onClick: onCancel,
          }),
        );
      }

      /**
       * One-line conclusion metadata: commit, round, generated time, coverage,
       * human/published. The commit leads like the published comment's meta line and renders
       * only when the caller passes a non-empty sha (both ConclusionPage call sites pass it
       * explicitly: the historical round's own head, the current round's review head).
       */
      function conclusionMetaLine(review, roundNumber, version, publishedEntries, isCurrent, t, headSha) {
        const parts = [];
        if (typeof headSha === 'string' && headSha !== '') parts.push(`commit ${shortSha(headSha)}`);
        parts.push(fill(t('metaRound'), { round: roundNumber }));
        const rawCreated = version.createdAt ?? review?.conclusionAt ?? 0;
        const stamp = formatClock(typeof rawCreated === 'number' ? rawCreated : 0);
        if (stamp !== '') parts.push(fill(t('metaGeneratedAt'), { time: stamp }));
        const coverage = version.coverage ?? review?.coverage ?? null;
        if (
          coverage !== null
          && coverage !== undefined
          && typeof coverage.total === 'number'
          && coverage.total > 0
        ) {
          parts.push(
            fill(t('metaCoverage'), {
              analyzed: typeof coverage.analyzed === 'number' ? coverage.analyzed : 0,
              total: coverage.total,
            }),
          );
        }
        const humanEdited = version.source === 'human'
          || (isCurrent === true
            && (review?.conclusionEditedAt ?? 0) > (typeof version.createdAt === 'number' ? version.createdAt : 0));
        if (humanEdited) parts.push(t('metaHumanEdited'));
        const published = publishedEntries.some(
          (entry) => typeof entry.version !== 'number' || entry.version === version.version,
        );
        if (published) parts.push(t('metaPublished'));
        return parts.join(' · ');
      }

      /**
       * Whole-review footer: the conclusion/publish actions plus the coverage and staleness
       * notices. Rendered above the composer (session takeover or embedded footer), never inside
       * the overview scroll, so it stays reachable while reading. Returns nulls for historical
       * rounds and for a round without a report — nothing to act on or qualify there.
       */
      function overviewFooter(props, derived) {
        const { report, pull, selectedVersion, staleInfo, isCurrent, page } = derived;
        const t = props.t;
        const review = props.review;
        const onConclusion = page !== 'overview';
        if (report === null || report === undefined || isCurrent !== true) {
          return { actions: null, notice: null };
        }
        const link = typeof pull.url === 'string' && pull.url !== ''
          ? h(
              'a',
              {
                className: 'prr-btn prr-btn-sm',
                href: pull.url,
                target: '_blank',
                rel: 'noreferrer',
                style: { textDecoration: 'none', display: 'inline-flex', alignItems: 'center' },
              },
              t('openPlatform'),
            )
          : null;
        const concludeLabel = derived.hasVersion === true ? t('reconclude') : t('conclude');
        const selectedPublished = derived.selectedPublished === true;
        const publishLabel = props.publishBusy === true || review.publishing === true
          ? t('publishing')
          : (props.previewBusy === true
            ? t('previewLoading')
            : (selectedPublished ? t('appendComment') : t('publishComment')));
        const progressActive = props.concluding !== null && props.concluding !== undefined;
        const publishTitle = selectedPublished
          ? t(staleInfo !== null ? 'appendStaleHint' : 'appendCommentHint')
          : staleInfo !== null
            ? t('publishStaleHint')
            : (progressActive === true ? t('publishConcludingHint') : undefined);
        const actions = h(
          'div',
          { className: 'prr-actions' },
          progressActive === true || props.concludeBusy === true
            ? h(ConcludingProgress, {
                concluding: progressActive === true ? props.concluding : null,
                t,
                cancelBusy: props.cancelBusy,
                onCancel: props.onCancelConclude,
              })
            : h(Btn, {
                label: props.concludeBusy ? t('concluding') : concludeLabel,
                // Regenerating is the next step only when there is nothing to publish: a stale
                // conclusion or no conclusion at all — the footer must never end up with no
                // primary action.
                primary: selectedVersion === null || staleInfo !== null,
                disabled: props.concludeBusy === true || props.reviewBusy === true,
                onClick: props.onConclude,
              }),
          onConclusion === false || selectedVersion === null
            ? null
            : h(Btn, {
                label: publishLabel,
                // Publishing (or appending) is the step that reaches the PR; it steps back only
                // while the conclusion is stale and regenerating is what the reviewer wants.
                primary: staleInfo === null,
                disabled: props.publishBusy === true || props.previewBusy === true
                  || review.publishing === true,
                title: publishTitle,
                onClick: props.onPublish,
              }),
          props.comment !== null && props.comment !== undefined && typeof props.comment.url === 'string' && props.comment.url !== ''
            ? h(
                'a',
                {
                  className: 'prr-btn prr-btn-sm',
                  href: props.comment.url,
                  target: '_blank',
                  rel: 'noreferrer',
                  style: { textDecoration: 'none', display: 'inline-flex', alignItems: 'center' },
                },
                t('commentLink'),
              )
            : null,
          link,
        );
        const coverageMissing = (props.explainedCount ?? 0) < (props.totalFiles ?? 0);
        // One collapsible panel in the dock: the coverage line merges into the stale warning when
        // both apply, and the whole thing folds to a single summary row. The action button does not
        // repeat the count. The overview page carries state in its status bar instead, so notices
        // render only on the conclusion page.
        const notice = onConclusion === false
          ? null
          : (staleInfo !== null
              ? {
                  tone: 'warn',
                  summary: fill(t('staleSummary'), { count: staleInfo.count }),
                  detail: staleDetailOf(staleInfo, coverageMissing === true, props.autoReconclude === true, t),
                }
              : (coverageMissing === true
                  ? { tone: 'note', summary: t('coverageIncomplete'), detail: null }
                  : null));
        return { actions, notice };
      }

      return {
        inlineMarkdown, renderMarkdown, ConclusionBlock, FeedbackBlock, PublishedBlock, staleDetailOf, ConcludingProgress, conclusionMetaLine, overviewFooter,
      };
    };
  },
});

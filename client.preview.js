// Package-local browser chunk. Registered by __ModuleLoader__.load and materialized on
// first require.async from client.js; it shares no scope with the entry.
window.__ModuleLoader__.load({
  id: '@modouai/dsh-pr-review',
  chunk: 'client.preview.js',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Publish preview dialog. */
    return function createPreview({ core }) {
      const {
        Btn, fill, fileLineLabel, text,
      } = core;

      /** Publish preview dialog: exact markdown, per-item selection, confirm/cancel. */
      function PublishPreviewModal(props) {
        const { preview, t, busy, error, onConfirm, onCancel } = props;
        const conflict = typeof preview?.conflict === 'string' ? preview.conflict : '';
        const items = Array.isArray(preview?.items) ? preview.items : [];
        const selectionSupported = preview?.selectionSupported === true;
        const selectedCount = Array.isArray(preview?.selectedIds) ? preview.selectedIds.length : 0;
        const nothingSelected = selectionSupported === true && selectedCount === 0;
        const selectedIds = Array.isArray(preview?.selectedIds) ? preview.selectedIds : [];
        const selected = new Set(selectedIds);
        const refreshing = props.refreshing === true;
        const toggleItem = typeof props.onToggleItem === 'function' ? props.onToggleItem : () => {};
        const selectAll = typeof props.onSelectAll === 'function' ? props.onSelectAll : () => {};
        const selectNone = typeof props.onSelectNone === 'function' ? props.onSelectNone : () => {};
        const title = preview !== null && preview !== undefined && typeof preview.round === 'number'
          ? fill(t('previewRoundMeta'), {
              round: preview.round,
              version: typeof preview.version === 'number' ? preview.version : 1,
            })
          : t('previewTitle');
        const itemList = selectionSupported
          ? h(
              'div',
              { className: 'prr-preview-items' },
              h(
                'div',
                { className: 'prr-preview-items-head' },
                h(
                  'span',
                  { className: 'prr-preview-items-title' },
                  `${t('previewItems')} · ${fill(t('previewItemsCount'), {
                    selected: selectedIds.length,
                    total: items.length,
                  })}`,
                ),
                h(Btn, {
                  label: t('selectAll'),
                  small: true,
                  disabled: selectedIds.length >= items.length,
                  onClick: selectAll,
                }),
                h(Btn, {
                  label: t('selectNone'),
                  small: true,
                  disabled: selectedIds.length === 0,
                  onClick: selectNone,
                }),
              ),
              items.map((item) =>
                h(
                  'label',
                  { className: 'prr-preview-item', key: item.id },
                  h('input', {
                    type: 'checkbox',
                    checked: selected.has(item.id),
                    onChange: () => toggleItem(item.id),
                  }),
                  h(
                    'div',
                    { className: 'prr-preview-item-body' },
                    h(
                      'div',
                      { className: 'prr-preview-item-meta' },
                      h(
                        'span',
                        { className: 'prr-tag' },
                        t(item.kind === 'suggestion' ? 'suggestions' : 'blockers'),
                      ),
                      item.file === ''
                        ? null
                        : h(
                            'span',
                            { className: 'prr-filetag', title: fileLineLabel(item.file, item.line) },
                            fileLineLabel(item.file, item.line),
                          ),
                    ),
                    h('div', { className: 'prr-preview-item-text' }, item.point),
                  ),
                ),
              ),
            )
          : h('div', { className: 'prr-modal-note' }, t('previewFullFallback'));
        return h(
          'div',
          { className: 'prr-modal-backdrop', onClick: onCancel },
          h(
            'div',
            {
              className: 'prr-modal',
              role: 'dialog',
              'aria-label': t('previewTitle'),
              onClick: (event) => event.stopPropagation(),
            },
            h(
              'div',
              { className: 'prr-modal-head' },
              h('span', { className: 'prr-modal-title' }, title),
              h('button', {
                type: 'button',
                className: 'prr-float-close',
                title: t('close'),
                onClick: onCancel,
              }, '✕'),
            ),
            h(
              'div',
              { className: 'prr-modal-body' },
              itemList,
              selectionSupported
                ? h('div', { className: 'prr-modal-note' }, t('previewItemsHint'))
                : null,
              nothingSelected
                ? h('div', { className: 'prr-modal-warn' }, t('previewSelectNoneHint'))
                : null,
              refreshing ? h('div', { className: 'prr-preview-refreshing' }, t('previewRefreshing')) : null,
              h('pre', { className: 'prr-markdown' }, text(preview?.markdown)),
              conflict === 'already-published'
                ? h('div', { className: 'prr-modal-warn' }, t('alreadyPublished'))
                : null,
              conflict === 'publishing'
                ? h('div', { className: 'prr-modal-warn' }, t('publishingBusy'))
                : null,
              error === '' || error === undefined || error === null
                ? null
                : h('div', { className: 'prr-modal-error' }, error),
            ),
            h(
              'div',
              { className: 'prr-modal-foot' },
              h(Btn, { label: t('cancel'), onClick: onCancel }),
              conflict === 'already-published'
                ? h(Btn, {
                    label: t('previewConfirmAppend'),
                    primary: true,
                    disabled: busy === true || refreshing === true || nothingSelected === true,
                    onClick: () => onConfirm(true),
                  })
                : h(Btn, {
                    label: busy === true
                      ? t('publishing')
                      : (conflict === 'publishing' ? t('retry') : t('previewConfirm')),
                    primary: true,
                    disabled: busy === true || refreshing === true || nothingSelected === true,
                    onClick: () => onConfirm(false),
                  }),
            ),
          ),
        );
      }

      return {
        PublishPreviewModal,
      };
    };
  },
});

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
        Btn, fill, text,
      } = core;

      /** Publish preview dialog: exact markdown plus conflict warnings; confirm/cancel only. */
      function PublishPreviewModal(props) {
        const { preview, t, busy, error, onConfirm, onCancel } = props;
        const conflict = typeof preview?.conflict === 'string' ? preview.conflict : '';
        const refreshing = props.refreshing === true;
        const title = preview !== null && preview !== undefined && typeof preview.round === 'number'
          ? fill(t('previewRoundMeta'), {
              round: preview.round,
              version: typeof preview.version === 'number' ? preview.version : 1,
            })
          : t('previewTitle');
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
                    disabled: busy === true || refreshing === true,
                    onClick: () => onConfirm(true),
                  })
                : h(Btn, {
                    label: busy === true
                      ? t('publishing')
                      : (conflict === 'publishing' ? t('retry') : t('previewConfirm')),
                    primary: true,
                    disabled: busy === true || refreshing === true,
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

import { styled } from 'styled-components';

export const EditorWrapperBase = styled.div<{ hideEditor: boolean }>`
  position: relative;
  background-color: ${p => p.theme.colors.bg};

  &:not(:focus-within) {
    & .tiptap p.is-editor-empty:first-child::before {
      color: ${p => p.theme.colors.textLight};
      content: attr(data-placeholder);
      float: left;
      height: 0;
      pointer-events: none;
    }
  }

  & .tiptap {
    :first-child {
      margin-top: 0;
    }
    display: ${p => (p.hideEditor ? 'none' : 'block')};
    outline: none;
    width: min(100%, 75ch);

    .tiptap-image {
      max-width: 100%;
      height: auto;
    }

    /* Remote-peer caret + name label. The Loro ProseMirror plugin (replacing
     * the old TipTap Collaboration / Yjs setup) emits a wrapping span with
     * class \`ProseMirror-loro-cursor\` and an inline \`border-color\` set to the
     * peer's color — but without \`border-style\` / \`border-width\` the caret
     * is invisible. The inner \`<div>\` carries the peer's name with an inline
     * \`background-color\`, and needs positioning to float above the caret.
     * \`.loro-selection\` highlights the peer's text selection range. */
    .ProseMirror-loro-cursor {
      border-left-style: solid;
      border-right-style: solid;
      border-left-width: 1px;
      border-right-width: 1px;
      margin-left: -1px;
      margin-right: -1px;
      pointer-events: none;
      position: relative;
      word-break: normal;

      > div {
        position: absolute;
        top: -1.4em;
        left: -1px;
        border-radius: 3px 3px 3px 0;
        color: #0d0d0d;
        font-size: 12px;
        font-style: normal;
        font-weight: 600;
        line-height: normal;
        padding: 0.1rem 0.3rem;
        user-select: none;
        white-space: nowrap;
        pointer-events: none;
      }
    }

    .loro-selection {
      /* Plugin sets a hardcoded yellow background inline; allow the caret
       * color to bleed through a touch on top so the selection feels
       * peer-attached. */
      mix-blend-mode: multiply;
    }

    pre {
      padding: 0.75rem 1rem;
      background-color: ${p => p.theme.colors.bg1};
      border-radius: ${p => p.theme.radius};
      font-family: monospace;

      code {
        white-space: pre;
        color: inherit;
        padding: 0;
        background: none;
        font-size: 0.8rem;
      }
    }

    blockquote {
      margin-inline-start: 0;
      border-inline-start: 3px solid ${p => p.theme.colors.textLight2};
      color: ${p => p.theme.colors.textLight};
      padding-inline-start: 1rem;
    }

    /* List styles */
    ul,
    ol {
      padding: 0 1rem;
      li {
        margin-bottom: 0;
      }
      li p {
        margin-top: 0.25em;
        margin-bottom: 0.25em;
      }
    }
    /* Task list specific styles */
    ul[data-type='taskList'] {
      list-style: none;
      margin-left: 0;
      padding: 0;

      li {
        align-items: flex-start;
        display: flex;

        > label {
          flex: 0 0 auto;
          margin-right: 0.5rem;
          user-select: none;
        }

        > div {
          flex: 1 1 auto;
        }
      }

      input[type='checkbox'] {
        cursor: pointer;
      }

      ul[data-type='taskList'] {
        margin: 0;
      }
    }
    table {
      border-collapse: collapse;
      td,
      th {
        border: 1px solid ${p => p.theme.colors.bg2};
        padding: ${p => p.theme.size(2)};
      }
    }
  }
`;

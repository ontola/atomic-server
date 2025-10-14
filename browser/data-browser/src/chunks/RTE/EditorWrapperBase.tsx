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
    display: ${p => (p.hideEditor ? 'none' : 'block')};
    outline: none;
    width: min(100%, 75ch);

    .tiptap-image {
      max-width: 100%;
      height: auto;
    }

    /* Give a remote user a caret */
    .collaboration-carets__caret {
      border-left: 1px solid #0d0d0d;
      border-right: 1px solid #0d0d0d;
      margin-left: -1px;
      margin-right: -1px;
      pointer-events: none;
      position: relative;
      word-break: normal;
    }

    /* Render the username above the caret */
    .collaboration-carets__label {
      border-radius: 3px 3px 3px 0;
      color: #0d0d0d;
      font-size: 12px;
      font-style: normal;
      font-weight: 600;
      left: -1px;
      line-height: normal;
      padding: 0.1rem 0.3rem;
      position: absolute;
      top: -1.4em;
      user-select: none;
      white-space: nowrap;
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
  }
`;

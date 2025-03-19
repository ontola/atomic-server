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

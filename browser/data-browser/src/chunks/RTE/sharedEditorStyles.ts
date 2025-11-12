// Textareas do not automatically grow when the content exceeds the height of the textarea.

import { styled } from 'styled-components';
import { EditorWrapperBase } from './EditorWrapperBase';
import { ToggleButton } from './ToggleButton';
import { transition } from '../../helpers/transition';

const MIN_EDITOR_HEIGHT = '10rem';
// The lineheight of a textarea.
const LINE_HEIGHT = 1.15;

// This function calculates the height of the textarea based on the number of lines in the content.
const calcHeight = (value: string) => {
  const lines = value.split('\n').length;

  return `calc(${lines * LINE_HEIGHT}em + 5px)`;
};

export const StyledEditorWrapper = styled(EditorWrapperBase)`
  min-height: ${MIN_EDITOR_HEIGHT};
  border-radius: ${p => p.theme.radius};
  box-shadow: 0 0 0 1px ${p => p.theme.colors.bg2};
  min-height: ${MIN_EDITOR_HEIGHT};
  padding: ${p => p.theme.size()};
  ${transition('box-shadow')}

  &:focus-within {
    box-shadow: 0 0 0 2px ${p => p.theme.colors.main};
  }

  & .tiptap {
    width: min(100%, 75ch);
    min-height: ${MIN_EDITOR_HEIGHT};

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

export const RawEditor = styled.textarea.attrs(p => ({
  style: { height: calcHeight((p.value as string) ?? '') },
}))`
  border: none;
  width: 100%;
  min-height: ${MIN_EDITOR_HEIGHT};
  outline: none;
  overflow: visible;
  height: fit-content;
  background-color: transparent;
  color: ${p => p.theme.colors.text};
  resize: none;
`;

export const FloatingMenuText = styled.span`
  color: ${p => p.theme.colors.textLight};
`;

export const FloatingCodeButton = styled(ToggleButton)`
  position: absolute;
  top: 0.5rem;
  right: 0.5rem;
`;

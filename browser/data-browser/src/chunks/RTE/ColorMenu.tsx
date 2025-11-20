import { Column, Row } from '@components/Row';
import { useTipTapEditor } from './TiptapContext';
import { MdFormatColorFill, MdFormatColorText } from 'react-icons/md';
import { useLocalStorage } from '@hooks/useLocalStorage';
import styled from 'styled-components';
import { transition } from '@helpers/transition';
import { useState, useRef, useEffect } from 'react';
import { useEditorState } from '@tiptap/react';
import { FaPencil } from 'react-icons/fa6';
import { desaturate, readableColor, setLightness } from 'polished';

const MAX_LAST_USED_COLORS = 9;
const defaultColors = [
  '#7c8c04',
  '#333333',
  '#000080',
  '#800000',
  '#014421',
  '#008080',
  '#4B0082',
  '#eb3535',
  '#148a12',
];
const defaultBackgroundColors = defaultColors.map(color =>
  desaturate(0.5, setLightness(0.7, color)),
);

// Add a good highlight color to the first position.
defaultBackgroundColors[0] = '#e9ff70';

export const ColorMenu: React.FC = () => {
  const editor = useTipTapEditor();
  const { selectedTextColor, selectedBackgroundColor } = useEditorState({
    editor,
    selector: snapshot => {
      return {
        selectedTextColor: snapshot.editor.getAttributes('textStyle').color,
        selectedBackgroundColor:
          snapshot.editor.getAttributes('textStyle').backgroundColor,
      };
    },
  });

  const [lastUsedTextColors = [], setLastUsedTextColors] = useLocalStorage<
    string[]
  >('atomic.rte.lastUsedTextColors', defaultColors);

  const [lastUsedBackgroundColor = [], setLastUsedBackgroundColor] =
    useLocalStorage<string[]>(
      'atomic.rte.lastUsedBackgroundColor',
      defaultBackgroundColors,
    );

  const setTextColor = (color: string) => {
    editor.chain().setColor(color).run();
    setLastUsedTextColors(prev => [
      color,
      ...(prev.includes(color)
        ? prev.filter(c => c !== color)
        : prev.slice(0, MAX_LAST_USED_COLORS - 1)),
    ]);
  };

  const setBackgroundColor = (color: string) => {
    editor.chain().setBackgroundColor(color).run();
    setLastUsedBackgroundColor(prev => [
      color,
      ...(prev.includes(color)
        ? prev.filter(c => c !== color)
        : prev.slice(0, MAX_LAST_USED_COLORS - 1)),
    ]);
  };

  const [handleTextColorInputChange, handleTextColorInputBlur] = useColor(
    selectedTextColor,
    setTextColor,
  );

  const [handleBackgroundColorInputChange, handleBackgroundColorInputBlur] =
    useColor(selectedBackgroundColor, setBackgroundColor);

  const preventDefault = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
  };

  useEffect(() => {
    // The bubble menu might need to be repositioned if this component is shown.
    editor.commands.setMeta('bubbleMenu', 'updatePosition');
  }, [editor]);

  return (
    <Column>
      <Row center>
        <MdFormatColorText size={20} />
        <ColorInput
          label='Edit text color'
          value={selectedTextColor}
          onChange={handleTextColorInputChange}
          onBlur={handleTextColorInputBlur}
        />
        {lastUsedTextColors.map(color => (
          <ColorButton
            key={color}
            color={color}
            type='button'
            onClick={() => setTextColor(color)}
            onMouseDown={preventDefault}
          />
        ))}
        <ColorButton
          color='#ffffff'
          type='button'
          className='unset'
          onClick={() => editor.chain().focus().unsetColor().run()}
          onMouseDown={preventDefault}
        />
      </Row>
      <Row center>
        <MdFormatColorFill size={20} />
        <ColorInput
          label='Edit background color'
          value={selectedBackgroundColor}
          onChange={handleBackgroundColorInputChange}
          onBlur={handleBackgroundColorInputBlur}
        />
        {lastUsedBackgroundColor.map(color => (
          <ColorButton
            key={color}
            color={color}
            type='button'
            onClick={() => setBackgroundColor(color)}
            onMouseDown={preventDefault}
          />
        ))}
        <ColorButton
          color='#ffffff'
          type='button'
          className='unset'
          onClick={() => editor.chain().focus().unsetBackgroundColor().run()}
          onMouseDown={preventDefault}
        />
      </Row>
    </Column>
  );
};

const useColor = (initialColor: string, onSelect: (color: string) => void) => {
  const [isChanging, setIsChanging] = useState(false);
  const colorRef = useRef(initialColor);

  const onInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const color = event.target.value;
    colorRef.current = color;
    setIsChanging(true);
  };

  const onInputBlur = () => {
    if (!isChanging) {
      return;
    }

    setIsChanging(false);
    onSelect(colorRef.current);
  };

  return [onInputChange, onInputBlur];
};

const ColorButton = styled.button<{ color: string }>`
  background-color: ${p => p.color};
  border: none;
  height: 1.5rem;
  aspect-ratio: 1/1;
  border-radius: 50%;
  cursor: pointer;
  ${transition('transform')};
  &:hover,
  &:focus-visible {
    outline: none;
    transform: scale(1.3);
  }

  &:active {
    transform: scale(1.1);
  }

  &.unset {
    position: relative;
    border: 1px solid ${p => p.theme.colors.textLight};
    display: grid;
    place-items: center;
    &::before {
      content: '';
      position: absolute;
      height: 100%;
      width: 2px;
      background-color: ${p => p.theme.colors.alert};
      transform: rotate(45deg);
      transform-origin: center;
    }
  }
`;

interface ColorInputProps {
  label: string;
  value: string;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onBlur: (event: React.FocusEvent<HTMLInputElement>) => void;
}

const ColorInput: React.FC<ColorInputProps> = ({
  label,
  value,
  onChange,
  onBlur,
}) => {
  return (
    <ColorInputLabel color={value}>
      <div aria-label={label}>
        <FaPencil />
      </div>
      <HiddenColorInput
        type='color'
        value={value ?? '#ffffff'}
        onChange={onChange}
        onBlur={onBlur}
      />
    </ColorInputLabel>
  );
};

const HiddenColorInput = styled.input`
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  height: 1px;
  overflow: hidden;
  position: absolute;
  white-space: nowrap;
  width: 1px;
`;

const ColorInputLabel = styled.label<{ color: string }>`
  --CIL_foreground: ${p => readableColor(p.color ?? p.theme.colors.bg)};
  cursor: pointer;
  position: relative;
  gap: 0.5rem;
  background-color: ${p => p.color};
  height: 1.5rem;
  width: 1.5rem;
  border-radius: 50%;
  border: 1px solid var(--CIL_foreground);
  &:focus-within {
    outline: solid ${p => p.theme.colors.main};
  }
  div {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: grid;
    place-items: center;

    svg {
      fill: var(--CIL_foreground);
      width: 0.75rem;
      height: 0.75rem;
    }
  }
`;

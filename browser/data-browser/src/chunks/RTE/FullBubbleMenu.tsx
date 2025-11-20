import { ButtonGroup } from '@components/ButtonGroup';
import {
  FaAlignLeft,
  FaAlignCenter,
  FaAlignRight,
  FaPalette,
} from 'react-icons/fa6';
import { BubbleMenu } from './BubbleMenu';
import { styled } from 'styled-components';
import { useTipTapEditor } from './TiptapContext';
import { useEditorState } from '@tiptap/react';
import { ToggleButton } from './ToggleButton';
import { useState } from 'react';
import { ColorMenu } from './ColorMenu';

export const FullBubbleMenu: React.FC = () => {
  const editor = useTipTapEditor();
  const [colorMenuOpen, setColorMenuOpen] = useState(false);
  const { alignedLeft, alignedCenter, alignedRight } = useEditorState({
    editor,
    selector: snapshot => ({
      alignedLeft: snapshot.editor.isActive({ textAlign: 'left' }),
      alignedCenter: snapshot.editor.isActive({ textAlign: 'center' }),
      alignedRight: snapshot.editor.isActive({ textAlign: 'right' }),
    }),
  });

  const alignTextOptions = [
    {
      icon: <FaAlignLeft />,
      label: 'Left',
      value: 'left',
      checked: alignedLeft,
    },
    {
      icon: <FaAlignCenter />,
      label: 'Center',
      value: 'center',
      checked: alignedCenter,
    },
    {
      icon: <FaAlignRight />,
      label: 'Right',
      value: 'right',
      checked: alignedRight,
    },
  ];

  if (!editor.view) {
    return null;
  }

  return (
    <BubbleMenu
      extraItems={<>{colorMenuOpen && <ColorMenu />}</>}
      onShow={() => {
        const style = editor.getAttributes('textStyle');
        setColorMenuOpen(!!style.color || !!style.backgroundColor);
      }}
    >
      <Separator />
      <ButtonGroup
        name='align'
        options={alignTextOptions}
        onChange={value => {
          editor.chain().focus().setTextAlign(value).run();
        }}
        value={
          alignedLeft
            ? 'left'
            : alignedCenter
              ? 'center'
              : alignedRight
                ? 'right'
                : 'left'
        }
      />
      <Separator />
      <ToggleButton
        onClick={() => {
          setColorMenuOpen(!colorMenuOpen);
          requestAnimationFrame(() => {
            editor.commands.setMeta('bubbleMenu', 'updatePosition');
          });
        }}
        $active={colorMenuOpen}
        type='button'
      >
        <FaPalette />
      </ToggleButton>
    </BubbleMenu>
  );
};

const Separator = styled.div`
  width: 1px;
  height: 2rem;
  background-color: ${p => p.theme.colors.bg2};
`;

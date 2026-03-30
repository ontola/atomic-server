import { FaPalette } from 'react-icons/fa6';
import { BubbleMenu } from './BubbleMenu';
import { styled } from 'styled-components';
import { useTipTapEditor } from './TiptapContext';
import { ToggleButton } from './ToggleButton';

export const FullBubbleMenu: React.FC = () => {
  const editor = useTipTapEditor();

  if (!editor.view) {
    return null;
  }

  return <BubbleMenu />;
};

const Separator = styled.div`
  width: 1px;
  height: 2rem;
  background-color: ${p => p.theme.colors.bg2};
`;

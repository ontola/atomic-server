import { BubbleMenu } from './BubbleMenu';
import { useTipTapEditor } from './TiptapContext';

export const FullBubbleMenu: React.FC = () => {
  const editor = useTipTapEditor();

  if (!editor.view) {
    return null;
  }

  return <BubbleMenu />;
};

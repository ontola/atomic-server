import { useEffect } from 'react';
import { useTipTapEditor } from './TiptapContext';

interface EditorEventsProps {
  onChange?: () => void;
  disable?: boolean;
}

export function EditorEvents({ onChange, disable }: EditorEventsProps): null {
  const editor = useTipTapEditor();

  useEffect(() => {
    if (!editor) return;

    const callback = () => {
      if (!disable) {
        onChange?.();
      }
    };

    editor.on('update', callback);

    return () => {
      if (editor) {
        editor.off('update', callback);
      }
    };
  }, [editor, onChange, disable]);

  return null;
}

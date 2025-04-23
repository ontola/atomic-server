import { useEffect } from 'react';
import { useTipTapEditor } from './TiptapContext';

interface EditorEventsProps {
  onChange?: () => void;
}

export function EditorEvents({ onChange }: EditorEventsProps): null {
  const editor = useTipTapEditor();

  useEffect(() => {
    if (!editor) return;

    const callback = () => {
      onChange?.();
    };

    if (editor) {
      editor.on('update', callback);
    }

    return () => {
      if (editor) {
        editor.off('update', callback);
      }
    };
  }, [editor, onChange]);

  return null;
}

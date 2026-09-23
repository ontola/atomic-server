import { BasicSelect } from '../../components/forms/BasicSelect';
import { useTipTapEditor } from './TiptapContext';
import { useEditorState, type Editor } from '@tiptap/react';

const getSelectedNode = (editor: Editor): string => {
  if (editor.isDestroyed) return 'paragraph';
  if (editor.isActive('codeBlock')) return 'codeBlock';
  if (editor.isActive('orderedList')) return 'orderedList';
  if (editor.isActive('bulletList')) return 'bulletList';
  if (editor.isActive('taskList')) return 'taskList';
  if (editor.isActive('heading', { level: 1 })) return 'heading-1';
  if (editor.isActive('heading', { level: 2 })) return 'heading-2';
  if (editor.isActive('heading', { level: 3 })) return 'heading-3';
  if (editor.isActive('heading', { level: 4 })) return 'heading-4';
  if (editor.isActive('heading', { level: 5 })) return 'heading-5';
  if (editor.isActive('heading', { level: 6 })) return 'heading-6';

  return 'paragraph';
};

const nodeData = (name: string): [title: string, level?: number] => {
  if (name.startsWith('heading')) {
    return ['heading', parseInt(name.split('-')[1])];
  }

  return [name];
};

// Keep command getters inside the event handler. Compiler-inferred callback
// dependencies otherwise read them during render, after TipTap teardown.
function changeNodeType(editor: Editor, nodeType: string) {
  if (editor.isDestroyed) return;
  const [targetNodeTitle, level] = nodeData(nodeType);

  // Choosing an option leaves focus on the `<select>`, so the next keystroke
  // would change the block type again instead of typing. Hand focus back.
  const chain = editor.chain().focus();

  if (nodeType === 'orderedList') {
    chain.toggleOrderedList().run();
  } else if (nodeType === 'bulletList') {
    chain.toggleBulletList().run();
  } else if (nodeType === 'taskList') {
    chain.toggleTaskList().run();
  } else {
    chain.setNode(targetNodeTitle, level ? { level } : undefined).run();
  }
}

export function NodeSelectMenu(): React.JSX.Element | null {
  const editor = useTipTapEditor();
  const { activeNode } = useEditorState({
    editor,
    selector: snapshot => ({
      activeNode: getSelectedNode(snapshot.editor),
    }),
  });

  if (!editor || editor.isDestroyed) return null;

  return (
    <BasicSelect
      value={activeNode}
      disabled={editor.isActive('image')}
      onChange={e => changeNodeType(editor, e.target.value)}
    >
      <option value='paragraph'>Paragraph</option>
      <option value='codeBlock'>Codeblock</option>
      <option value='orderedList'>Ordered List</option>
      <option value='bulletList'>Bullet List</option>
      <option value='taskList'>Task List</option>
      <option value='heading-1'>Heading 1</option>
      <option value='heading-2'>Heading 2</option>
      <option value='heading-3'>Heading 3</option>
      <option value='heading-4'>Heading 4</option>
      <option value='heading-5'>Heading 5</option>
      <option value='heading-6'>Heading 6</option>
    </BasicSelect>
  );
}

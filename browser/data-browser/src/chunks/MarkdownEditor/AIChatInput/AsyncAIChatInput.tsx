import { EditorContent, useEditor, type JSONContent } from '@tiptap/react';
import { styled } from 'styled-components';
import StarterKit from '@tiptap/starter-kit';
import Mention from '@tiptap/extension-mention';
import { TiptapContextProvider } from '../TiptapContext';
import { EditorWrapperBase } from '../EditorWrapperBase';
import { searchSuggestionBuilder } from './resourceSuggestions';
import { useEffect, useRef, useState } from 'react';
import { EditorEvents } from '../EditorEvents';
import { Markdown } from 'tiptap-markdown';
import { useStore } from '@tomic/react';
import { useSettings } from '../../../helpers/AppSettings';
import type { Node } from '@tiptap/pm/model';
import Placeholder from '@tiptap/extension-placeholder';

// Modify the Mention extension to allow serializing to markdown.
const SerializableMention = Mention.extend({
  addStorage() {
    return {
      markdown: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        serialize(state: any, node: Node) {
          state.write('@' + (node.attrs.label || ''));
          state.renderContent(node);
          state.flushClose(1);
          state.closeBlock(node);
        },
      },
    };
  },
});

interface AsyncAIChatInputProps {
  onMentionUpdate: (mentions: string[]) => void;
  onChange: (markdown: string) => void;
  onSubmit: () => void;
}

const AsyncAIChatInput: React.FC<AsyncAIChatInputProps> = ({
  onMentionUpdate,
  onChange,
  onSubmit,
}) => {
  const store = useStore();
  const { drive } = useSettings();
  const [markdown, setMarkdown] = useState('');
  const markdownRef = useRef(markdown);
  const onSubmitRef = useRef(onSubmit);

  const editor = useEditor({
    extensions: [
      Markdown.configure({
        html: true,
      }),
      StarterKit.extend({
        addKeyboardShortcuts() {
          return {
            Enter: () => {
              // Check if the cursor is in a code block, if so allow the user to press enter.
              // Pressing shift + enter will exit the code block.
              if ('language' in this.editor.getAttributes('codeBlock')) {
                return false;
              }

              // The content has to be read from a ref because this callback is not updated often leading to stale content.
              onSubmitRef.current();
              setMarkdown('');
              this.editor.commands.clearContent();

              return true;
            },
          };
        },
      }).configure({
        blockquote: false,
        bulletList: false,
        orderedList: false,
        // paragraph: false,
        heading: false,
        listItem: false,
        horizontalRule: false,
        bold: false,
        strike: false,
        italic: false,
      }),
      SerializableMention.configure({
        HTMLAttributes: {
          class: 'ai-chat-mention',
        },
        suggestion: searchSuggestionBuilder(store, drive),
        renderText({ options, node }) {
          return `${options.suggestion.char}${node.attrs.title}`;
        },
      }),
      Placeholder.configure({
        placeholder: 'Ask me anything...',
      }),
    ],
    autofocus: true,
  });

  const handleChange = (value: string) => {
    setMarkdown(value);
    markdownRef.current = value;
    onChange(value);

    if (!editor) {
      return;
    }

    const mentions = digForMentions(editor.getJSON());
    onMentionUpdate(Array.from(new Set(mentions)));
  };

  useEffect(() => {
    markdownRef.current = markdown;
    onSubmitRef.current = onSubmit;
  }, [markdown, onSubmit]);

  return (
    <EditorWrapper hideEditor={false}>
      <TiptapContextProvider editor={editor}>
        <EditorContent editor={editor} />
        <EditorEvents onChange={handleChange} />
      </TiptapContextProvider>
    </EditorWrapper>
  );
};

export default AsyncAIChatInput;

const EditorWrapper = styled(EditorWrapperBase)`
  padding: ${p => p.theme.size(2)};
  font-size: 16px;
  line-height: 1.5;

  .ai-chat-mention {
    background-color: ${p => p.theme.colors.mainSelectedBg};
    color: ${p => p.theme.colors.mainSelectedFg};
    border-radius: 5px;
    padding-inline: ${p => p.theme.size(1)};
  }
`;

function digForMentions(data: JSONContent): string[] {
  if (data.type === 'mention') {
    return [data.attrs!.id];
  }

  if (data.content) {
    return data.content.flatMap(digForMentions);
  }

  return [];
}

import { EditorContent, useEditor } from '@tiptap/react';
import { FloatingMenu } from '@tiptap/react/menus';
import { StarterKit } from '@tiptap/starter-kit';
import { Link } from '@tiptap/extension-link';
import { Placeholder } from '@tiptap/extension-placeholder';
import { Typography } from '@tiptap/extension-typography';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import TextAlign from '@tiptap/extension-text-align';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import DragHandle from '@tiptap/extension-drag-handle-react';
import {
  Color,
  BackgroundColor,
  TextStyle,
} from '@tiptap/extension-text-style';
import { useEffect, useState } from 'react';
import { TiptapContextProvider } from './TiptapContext';
import { SlashCommands, buildSuggestion } from './SlashMenu/CommandsExtension';
import {
  ResourceCommands,
  buildResourceSuggestion,
} from './ResourceExtension/ResourceExtention';
import { ExtendedImage } from './ImagePicker';
import { usePopoverContainer } from '../../components/Popover';
import { FloatingMenuText } from './sharedEditorStyles';
import * as Y from 'yjs';
import {
  useDebouncedSave,
  useResource,
  useStore,
  type Core,
  type Resource,
} from '@tomic/react';
import { EditorEvents } from './EditorEvents';
import { useYSync } from './useYSync';
import { randomItem } from '@helpers/randomItem';
import { EditorWrapperBase } from './EditorWrapperBase';
import styled from 'styled-components';
import { transition } from '@helpers/transition';
import { useSettings } from '@helpers/AppSettings';
import { FullBubbleMenu } from './FullBubbleMenu';
import {
  ResourceNode,
  ResourceNodeInline,
} from './ResourceExtension/ResourceNode';
import { IsInRTEContex } from '@hooks/useIsInRTE';
import { FaGripVertical } from 'react-icons/fa6';

export type CollaborativeEditorProps = {
  placeholder?: string;
  doc: Y.Doc;
  autoFocus?: boolean;
  resource: Resource;
  property: string;
  id?: string;
  labelId?: string;
  onBlur?: () => void;
};

const COLORS = ['#70d6ff', '#ff70a6', '#ff9770', '#ffd670', '#e9ff70'];

export default function CollaborativeEditor({
  placeholder,
  autoFocus,
  doc,
  property,
  id,
  labelId,
  resource,
  onBlur,
}: CollaborativeEditorProps): React.JSX.Element {
  const store = useStore();
  const [save] = useDebouncedSave(resource, 2000);
  const { agent, drive } = useSettings();
  const agentResource = useResource<Core.Agent>(agent?.subject);
  const containerRef = usePopoverContainer();
  const color = randomItem(COLORS);
  const container = containerRef.current ?? document.body;

  const awareness = useYSync(resource, property, doc);

  const [extensions] = useState(() => [
    StarterKit.configure({
      undoRedo: false,
      link: false,
    }),
    Typography,
    Link.configure({
      autolink: true,
      openOnClick: true,
      protocols: [
        'http',
        'https',
        'mailto',
        {
          scheme: 'tel',
          optionalSlashes: true,
        },
      ],
      HTMLAttributes: {
        class: 'tiptap-link',
        rel: 'noopener noreferrer',
        target: '_blank',
      },
    }),
    ExtendedImage.configure({
      HTMLAttributes: {
        class: 'tiptap-image',
      },
    }),
    Placeholder.configure({
      placeholder: placeholder ?? 'Start typing...',
    }),
    SlashCommands.configure({
      suggestion: buildSuggestion(container),
    }),
    ResourceCommands.configure({
      suggestion: buildResourceSuggestion(container, store, drive),
    }),
    ResourceNode,
    ResourceNodeInline,
    Collaboration.configure({
      document: doc,
      field: 'content',
    }),
    CollaborationCaret.configure({
      provider: {
        awareness,
      },
      user: {
        name: agentResource.title,
        color,
      },
    }),
    TextAlign.configure({
      types: ['heading', 'paragraph'],
    }),
    TaskList,
    TaskItem.configure({
      nested: true,
    }),
    TextStyle,
    Color,
    BackgroundColor,
  ]);

  const editor = useEditor({
    extensions,
    onBlur,
    autofocus: !!autoFocus,
    editorProps: {
      attributes: {
        ...(id && { id }),
        ...(labelId && { 'aria-labelledby': labelId }),
        spellcheck: 'true',
      },
    },
  });

  useEffect(() => {
    if (agentResource) {
      editor.commands.updateUser({
        name: agentResource.props.name ?? 'Untitled Agent',
        color,
      });
    }
  }, [agentResource]);

  return (
    <IsInRTEContex value={true}>
      <TiptapContextProvider editor={editor}>
        <StyledEditorWrapper hideEditor={false}>
          <DragHandle editor={editor}>
            <FaGripVertical />
          </DragHandle>
          <EditorContent key='rich-editor' editor={editor}>
            <FloatingMenu editor={editor}>
              <FloatingMenuText>
                Type &apos;/&apos; for options or &apos;@&apos; for resources
              </FloatingMenuText>
            </FloatingMenu>
            <FullBubbleMenu />
            <EditorEvents onChange={save} />
          </EditorContent>
        </StyledEditorWrapper>
      </TiptapContextProvider>
    </IsInRTEContex>
  );
}

export const StyledEditorWrapper = styled(EditorWrapperBase)`
  box-shadow: none;
  min-height: 10rem;
  border-radius: ${p => p.theme.radius};
  min-height: 10rem;
  padding: ${p => p.theme.size()};
  width: 100%;
  margin-bottom: 10rem;
  ${transition('box-shadow')}

  & .tiptap {
    width: 100%;
    min-height: 10rem;
    ::spelling-error {
      text-decoration: wavy red underline;
    }
  }
  .drag-handle {
    align-items: center;
    border-radius: 0.25rem;
    cursor: grab;
    display: flex;
    height: 1.5rem;
    justify-content: center;
    width: 1.5rem;
    color: ${p => p.theme.colors.textLight2};

    /* svg {
      width: 1.25rem;
      height: 1.25rem;
    } */
  }
`;

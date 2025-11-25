import { EditorContent, useEditor, type Editor } from '@tiptap/react';
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
import * as Y from 'yjs';
import {
  dataBrowser,
  useCanWrite,
  useDebouncedSave,
  useResource,
  useStore,
  type Core,
  type Resource,
  type Server,
} from '@tomic/react';
import { EditorEvents } from './EditorEvents';
import { useYSync } from './useYSync';
import { randomItem } from '@helpers/randomItem';
import { EditorWrapperBase } from './EditorWrapperBase';
import styled, { useTheme } from 'styled-components';
import { useSettings } from '@helpers/AppSettings';
import { FullBubbleMenu } from './FullBubbleMenu';
import {
  ResourceNode,
  ResourceNodeInline,
} from './ResourceExtension/ResourceNode';
import { IsInRTEContex } from '@hooks/useIsInRTE';
import { FaCircleInfo, FaGripVertical, FaLink, FaTable } from 'react-icons/fa6';
import { useUpload } from '@hooks/useUpload';
import FileHandler from '@tiptap/extension-file-handler';
import { supportedImageTypes } from '@views/File/fileTypeUtils';
import type { SuggestionItem } from './types';
import { useNewResourceUI } from '@components/forms/NewForm/useNewResourceUI';
import { addIf } from '@helpers/addIf';
import toast from 'react-hot-toast';
import { Row } from '@components/Row';
import { Button } from '@components/Button';
import { Note } from './NoteExtention/NoteExtention';
import { FloatingHint } from './FloatingHint';
import { TableKit } from '@tiptap/extension-table';
import { useCustomBodyColor } from '@hooks/useCustomBodyColor';

export type CollaborativeEditorProps = {
  placeholder?: string;
  doc: Y.Doc;
  resource: Resource;
  property: string;
  id?: string;
  onBlur?: () => void;
};

const COLORS = ['#70d6ff', '#ff70a6', '#ff9770', '#ffd670', '#e9ff70'];

export default function CollaborativeEditor({
  placeholder,
  doc,
  property,
  id,
  resource,
  onBlur,
}: CollaborativeEditorProps): React.JSX.Element {
  const store = useStore();
  const [color] = useState(randomItem(COLORS));
  const showNewResourceUI = useNewResourceUI();
  const [save] = useDebouncedSave(resource, 2000);
  const { agent, drive } = useSettings();
  const agentResource = useResource<Core.Agent>(agent?.subject);
  const { upload } = useUpload(resource);
  const awareness = useYSync(resource, property, doc);
  const canWrite = useCanWrite(resource);

  const theme = useTheme();
  useCustomBodyColor(theme.colors.bg);

  const uploadAndInsertImage = async (
    currentEditor: Editor,
    files: File[],
    pos: number,
  ) => {
    const subjects = await upload(files);

    for (const imageSubject of subjects) {
      const image = await store.getResource<Server.File>(imageSubject);

      currentEditor.commands.insertContentAt(pos, {
        type: 'image',
        attrs: { src: image.props.downloadUrl },
      });
    }
  };

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          undoRedo: false,
          link: false,
          codeBlock: {
            enableTabIndentation: true,
          },
        }),
        Note,
        Typography,
        Link.extend({
          parseHTML: () => [
            {
              tag: 'a[href]',
              getAttrs: node => {
                // Links with a data-type are custom nodes that should be ignored by the link extension
                if (node.getAttribute('data-type')) {
                  return false;
                }

                // Default link parsing
                return {
                  href: node.getAttribute('href'),
                  target: node.getAttribute('target'),
                };
              },
            },
          ],
        }).configure({
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
          uploadImage: upload,
          HTMLAttributes: {
            class: 'tiptap-image',
          },
        }),
        Placeholder.configure({
          placeholder: placeholder ?? 'Start typing...',
        }),
        SlashCommands.configure({
          suggestion: buildSuggestion(document.body, [
            {
              title: 'Note',
              id: 'note',
              icon: FaCircleInfo,
              command: ({ range, editor: internalEditor }) => {
                internalEditor
                  .chain()
                  .focus()
                  .deleteRange(range)
                  .toggleNote()
                  .run();
              },
            },
            {
              title: 'Resource',
              id: 'resource',
              icon: FaLink,
              command: ({ range, editor: internalEditor }) =>
                internalEditor
                  .chain()
                  .focus()
                  .deleteRange(range)
                  .insertContent('@')
                  .run(),
            } as SuggestionItem,
            {
              title: 'Data Table',
              id: 'data-table',
              icon: FaTable,
              command: ({ range, editor: internalEditor }) => {
                showNewResourceUI(dataBrowser.classes.table, resource.subject, {
                  skipNavigation: true,
                  onCreated: table => {
                    internalEditor
                      .chain()
                      .focus()
                      .deleteRange(range)
                      .setResource({ subject: table.subject })
                      .run();
                  },
                });
              },
            },
          ]),
        }),
        ResourceCommands.configure({
          suggestion: buildResourceSuggestion(document.body, store, drive),
        }),
        ResourceNode.configure({
          store,
        }),
        ResourceNodeInline.configure({
          store,
        }),
        Collaboration.configure({
          document: doc,
          field: 'content',
        }),
        ...addIf(
          canWrite,
          CollaborationCaret.configure({
            provider: {
              awareness,
            },
            user: {
              name: agentResource.title,
              color,
            },
          }),
        ),
        TextAlign.configure({
          types: ['heading', 'paragraph'],
        }),
        TaskList,
        TaskItem.configure({
          nested: true,
        }),
        TextStyle,
        TableKit,
        Color,
        BackgroundColor,
        FileHandler.configure({
          allowedMimeTypes: Array.from(supportedImageTypes),
          onDrop: (currentEditor, files, pos) => {
            uploadAndInsertImage(currentEditor, files, pos);
          },
          onPaste: (currentEditor, files, htmlContent) => {
            if (htmlContent) {
              // if there is htmlContent, stop manual insertion & let other extensions handle insertion via inputRule
              // you could extract the pasted file from this url string and upload it to a server for example

              return false;
            }

            uploadAndInsertImage(
              currentEditor,
              files,
              currentEditor.state.selection.anchor,
            );
          },
        }),
      ],
      editable: canWrite,
      enableContentCheck: true,
      onBlur,
      editorProps: {
        attributes: {
          ...(id && { id }),
          'aria-label': 'Rich Text Editor',
          'aria-multiline': 'true',
          'aria-readonly': canWrite ? 'true' : 'false',
          spellcheck: 'true',
        },
      },
      onContentError({ editor: currentEditor, error, disableCollaboration }) {
        // Removes the collaboration extension.
        disableCollaboration();

        // Since the content is invalid, we don't want to emit an update
        // Preventing synchronization with other editors or to a server
        const emitUpdate = false;

        // Disable the editor to prevent further user input
        currentEditor.setEditable(false, emitUpdate);

        console.error(error);
        // Maybe show a notification to the user that they need to refresh the app
        toast.error(
          <Row wrapItems>
            There was an error in the editor, please refresh the page to
            continue.{' '}
            <Button subtle onClick={() => window.location.reload()}>
              Refresh
            </Button>
          </Row>,
          { duration: Infinity },
        );
      },
    },
    [canWrite, drive],
  );

  useEffect(() => {
    if (agentResource) {
      editor.commands.updateUser?.({
        name: agentResource.props.name ?? 'Untitled Agent',
        color,
      });
    }
  }, [agentResource, editor.commands, color, canWrite]);

  return (
    <IsInRTEContex value={true}>
      <TiptapContextProvider editor={editor}>
        <StyledEditorWrapper hideEditor={false}>
          <DragHandle editor={editor}>
            <FaGripVertical />
          </DragHandle>
          <EditorContent key='rich-editor' editor={editor}>
            <FloatingHint editor={editor}>
              Type &apos;/&apos; for options or &apos;@&apos; for resources
            </FloatingHint>
            <FullBubbleMenu />
            <EditorEvents onChange={save} />
          </EditorContent>
          <ClickUnderHandler onClick={() => editor?.commands.focus('end')} />
        </StyledEditorWrapper>
      </TiptapContextProvider>
    </IsInRTEContex>
  );
}

const ClickUnderHandler = styled.div`
  flex: 1;
  width: 100%;
  min-height: 10rem;
`;

export const StyledEditorWrapper = styled(EditorWrapperBase)`
  box-shadow: none;
  min-height: 100%;
  border-radius: ${p => p.theme.radius};
  min-height: 10rem;
  width: 100%;
  flex: 1;
  display: flex;
  flex-direction: column;

  & .tiptap {
    width: 100%;
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
  }
`;

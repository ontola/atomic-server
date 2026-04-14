import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { Placeholder } from '@tiptap/extension-placeholder';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import DragHandle from '@tiptap/extension-drag-handle-react';
import { useEffect, useState } from 'react';
import { TiptapContextProvider } from './TiptapContext';
import { SlashCommands, buildSuggestion } from './SlashMenu/CommandsExtension';
import {
  ResourceCommands,
  buildResourceSuggestion,
} from './ResourceExtension/ResourceExtention';
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
import { FloatingHint } from './FloatingHint';
import { useCustomBodyColor } from '@hooks/useCustomBodyColor';
import {
  getDocumentCollaborationCoreExtensions,
  getDocumentCollaborationResourceAndFormattingExtensions,
} from './documentCollaborationExtensions';
import { useAIChanges } from '@components/AIChangesContext';
import { ComparePlugin } from './comparePlugin';
import { useOnValueChange } from '@helpers/useOnValueChange';
import { getProsemirrorObjFromYDoc } from './prosemirrorObjFromYDoc';
import { registerCollaborativeDocumentEditor } from './collaborativeDocumentEditorRegistry';

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
  const [editorReady, setEditorReady] = useState(false);

  const { oldResources, hasAIChanges } = useAIChanges();
  const oldResource = oldResources[resource.subject] as Resource | undefined;

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
      onCreate() {
        setEditorReady(true);
      },
      extensions: [
        ...getDocumentCollaborationCoreExtensions({
          uploadImage: upload,
        }),
        Placeholder.configure({
          placeholder: placeholder ?? 'Start typing...',
        }),
        ComparePlugin.configure({
          comparisonContent: '',
          classAdded: 'diff-added',
          classRemoved: 'diff-removed',
          classRemovedNode: 'diff-removed-node',
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
        ...getDocumentCollaborationResourceAndFormattingExtensions(store),
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
    if (!editor || !editorReady) {
      return;
    }

    return registerCollaborativeDocumentEditor(resource.subject, editor);
  }, [editor, editorReady, resource.subject]);

  useEffect(() => {
    if (agentResource) {
      editor.commands.updateUser?.({
        name: agentResource.props.name ?? 'Untitled Agent',
        color,
      });
    }
  }, [agentResource, editor.commands, color, canWrite]);

  useOnValueChange(
    () => {
      if (!editorReady) return;

      if (hasAIChanges(resource.subject)) {
        if (!oldResource) return;

        const oldYDoc = oldResource.get(dataBrowser.properties.documentContent);
        const oldDoc = getProsemirrorObjFromYDoc(oldYDoc, editor.schema);

        editor.commands.setComparisonContent(oldDoc);
      } else {
        editor.commands.setComparisonContent('');
      }
    },
    [hasAIChanges(resource.subject), editorReady, oldResource],
    true,
  );

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
            <EditorEvents
              onChange={save}
              disable={hasAIChanges(resource.subject)}
            />
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

    .diff-added {
      background-color: ${p => p.theme.colors.diff.addedBg};
      color: ${p => p.theme.colors.diff.addedFg};
    }

    .diff-removed,
    .diff-removed-node {
      background-color: ${p => p.theme.colors.diff.removedBg};
      color: ${p => p.theme.colors.diff.removedFg};
      text-decoration: line-through;
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

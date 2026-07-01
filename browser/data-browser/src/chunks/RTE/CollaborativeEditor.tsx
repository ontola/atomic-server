import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { Extension } from '@tiptap/core';
import {
  LoroSyncPlugin,
  LoroUndoPlugin,
  LoroEphemeralCursorPlugin,
  redo as loroRedo,
  undo as loroUndo,
  type LoroDocType,
} from 'loro-prosemirror';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import {
  TextStyle,
  Color,
  BackgroundColor,
} from '@tiptap/extension-text-style';
import { TableKit } from '@tiptap/extension-table';
import {
  ResourceNode,
  ResourceNodeInline,
} from './ResourceExtension/ResourceNode';
import DragHandle from '@tiptap/extension-drag-handle-react';
import { useEffect, useState } from 'react';
import { TiptapContextProvider } from './TiptapContext';
import { SlashCommands, buildSuggestion } from './SlashMenu/CommandsExtension';
import {
  ResourceCommands,
  buildResourceSuggestion,
} from './ResourceExtension/ResourceExtention';
import type { LoroDoc } from 'loro-crdt';
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
import { useLoroSync } from './useLoroSync';
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
import toast from 'react-hot-toast';
import { Row } from '@components/Row';
import { Button } from '@components/Button';
import { FloatingHint } from './FloatingHint';
import { useCustomBodyColor } from '@hooks/useCustomBodyColor';
import { getDocumentCollaborationCoreExtensions } from './documentCollaborationExtensions';
import { useAIChanges } from '@components/AIChangesContext';
import { ComparePlugin } from './comparePlugin';
import { useOnValueChange } from '@helpers/useOnValueChange';
import { registerCollaborativeDocumentEditor } from './collaborativeDocumentEditorRegistry';

export type CollaborativeEditorProps = {
  placeholder?: string;
  doc: LoroDoc;
  resource: Resource;
  property: string;
  id?: string;
  onBlur?: () => void;
};

const COLORS = ['#70d6ff', '#ff70a6', '#ff9770', '#ffd670', '#e9ff70'];

const UNDO_KEYS = 'Mod-z';
const REDO_KEYS = 'Mod-Shift-z';
const REDO_WINDOWS_KEYS = 'Mod-y';

export default function CollaborativeEditor({
  placeholder,
  doc,
  id,
  resource,
  onBlur,
}: CollaborativeEditorProps): React.JSX.Element {
  const store = useStore();
  const [color] = useState(randomItem(COLORS));
  const showNewResourceUI = useNewResourceUI();
  const [save] = useDebouncedSave(resource, 500);
  const { agent, drive } = useSettings();
  const agentResource = useResource<Core.Agent>(agent?.subject);
  const { upload } = useUpload(resource);
  const ephemeralStore = useLoroSync(resource, doc);
  const canWrite = useCanWrite(resource);
  const [editorReady, setEditorReady] = useState(false);

  const { oldDocumentSnapshots, hasAIChanges } = useAIChanges();
  const comparisonBaseline = oldDocumentSnapshots[resource.subject];

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
        // NOTE: @tiptap/extension-placeholder was removed — its empty-node
        // decoration formed a DecorationGroup with loro-prosemirror's cursor
        // plugin that crashes prosemirror-view@1.41 (`DecorationGroup.eq` on a
        // null member). The placeholder is now rendered with CSS instead (see
        // `data-placeholder` in editorProps + StyledEditorWrapper below).
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
        ResourceNode.configure({
          store,
        }),
        ResourceNodeInline.configure({
          store,
        }),
        Extension.create({
          name: 'loroSync',
          addProseMirrorPlugins() {
            return [
              LoroSyncPlugin({ doc: doc as unknown as LoroDocType }),
              LoroUndoPlugin({ doc: doc as unknown as LoroDocType }),
              LoroEphemeralCursorPlugin(ephemeralStore, {
                user: agentResource
                  ? {
                      name: agentResource.props.name ?? 'Untitled Agent',
                      color,
                    }
                  : undefined,
              }),
            ];
          },
          // `LoroUndoPlugin` exposes the undo manager + ProseMirror
          // `undo` / `redo` commands but does NOT register any
          // keybindings. With `StarterKit`'s `undoRedo: false` above (we
          // disable it because Loro is supposed to own undo history),
          // `Mod-z` / `Mod-Shift-z` end up unhandled and the browser's
          // native page-undo fires instead. Wire the commands here.
          addKeyboardShortcuts() {
            const exec =
              (cmd: typeof loroUndo) =>
              ({ editor: e }: { editor: Editor }) =>
                cmd(e.state, e.view.dispatch.bind(e.view));

            return {
              [UNDO_KEYS]: exec(loroUndo),
              [REDO_KEYS]: exec(loroRedo),
              // Common Windows redo binding kept in sync.
              [REDO_WINDOWS_KEYS]: exec(loroRedo),
            };
          },
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
          // CSS-only placeholder (see StyledEditorWrapper). Replaces
          // @tiptap/extension-placeholder, whose decoration crashed pm@1.41
          // when grouped with the loro cursor plugin's decorations.
          'data-placeholder': placeholder ?? 'Click to focus document…',
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
    // Keep canWrite OUT of the deps. useEditor with canWrite in deps will
    // destroy + recreate the editor every time the permission check flips
    // (initial false → async true). The destroy loses focus + cursor state,
    // so a test that focuses → types → asserts text races the recreate and
    // the typing lands on a stale editor that immediately unmounts. We use
    // setEditable below to flip read-only on the SAME editor instance.
    //
    // Do include `doc`: the loro-prosemirror plugins close over the LoroDoc
    // passed at editor construction time. If the Resource hydrates a newer doc
    // instance after mount, keeping the editor alive would make remote sync
    // import into one doc while ProseMirror renders another.
    [drive, doc],
  );

  useEffect(() => {
    if (editor && editor.isEditable !== canWrite) {
      editor.setEditable(canWrite);
    }
  }, [editor, canWrite]);

  useEffect(() => {
    if (!editor || !editorReady) {
      return;
    }

    return registerCollaborativeDocumentEditor(resource.subject, editor);
  }, [editor, editorReady, resource.subject]);

  useEffect(() => {
    if (!agentResource) return;

    const local = ephemeralStore.getLocal();
    ephemeralStore.setLocal({
      anchor: local?.anchor,
      focus: local?.focus,
      user: {
        name: agentResource.props.name ?? 'Untitled Agent',
        color,
      },
    });
  }, [agentResource, ephemeralStore, color]);

  // Sync the comparison (AI-diff) content into the editor. This dispatches a
  // ProseMirror transaction, so it MUST NOT run during render (doing so triggers
  // "Cannot update a component while rendering" and cascades into editor
  // instability / detached inputs).
  useOnValueChange(
    () => {
      if (!editor || !editorReady) return;

      if (hasAIChanges(resource.subject)) {
        editor.commands.setComparisonContent(comparisonBaseline ?? '');
      } else {
        editor.commands.setComparisonContent('');
      }
    },
    [hasAIChanges(resource.subject), editorReady, comparisonBaseline, editor],
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
  /* Whole editing area reads as a text field on hover. */
  cursor: text;

  & .tiptap {
    width: 100%;
    position: relative;

    /* CSS-only placeholder: shown when the doc is a single empty paragraph.
     * Decoration-free (unlike @tiptap/extension-placeholder) so it never forms
     * a DecorationGroup with the loro cursor plugin → avoids the pm@1.41
     * DecorationGroup.eq crash. */
    &[data-placeholder]:not(.ProseMirror-focused):has(
        > p:first-child:last-child > br.ProseMirror-trailingBreak:only-child
      )::before {
      content: attr(data-placeholder);
      position: absolute;
      top: 0;
      left: 0;
      color: ${p => p.theme.colors.textLight2};
      pointer-events: none;
    }

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

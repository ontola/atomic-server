import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { Placeholder } from '@tiptap/extension-placeholder';
import { Typography } from '@tiptap/extension-typography';
import { Extension } from '@tiptap/core';
import {
  LoroSyncPlugin,
  LoroUndoPlugin,
  // LoroEphemeralCursorPlugin — removed: incompatible with
  // prosemirror-view 1.41 (TipTap 3.23). See the editor plugin list.
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
import { ExtendedImage } from './ImagePicker';
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
              // Cursor presence plugin: installed for everyone — readers
              // broadcasting their caret is the same useful "who's
              // looking where" signal the old Yjs awareness gave us, and
              // the server's `LoroEphemeralUpdate` handler has no
              // can-write check (only `LoroSyncUpdate` gates writes), so
              // a reader sharing their cursor is harmless.
              //
              // The earlier `canWrite && ephemeralStore` gate looked
              // safe but interacted badly with the `[drive, doc]` deps
              // on `useEditor` above: `canWrite` is `false` on first
              // render (async permission probe still pending) and the
              // editor is built ONCE, so by the time canWrite resolves
              // to true the plugin set is already frozen and the cursor
              // plugin is silently absent. The visible symptom: zero
              // `LORO_EPHEMERAL_UPDATE` frames on the wire, doc sync
              // works fine, no remote carets ever render.
              // REMOTE-CURSOR PLUGIN REMOVED (2026-05-29).
              //
              // `LoroEphemeralCursorPlugin` (loro-prosemirror 0.4.3 — the
              // latest published) is incompatible with prosemirror-view
              // 1.41 pulled in by the TipTap 3.11→3.23 bump: its
              // remote-caret decorations produce a `DecorationGroup`
              // with an undefined member, and prosemirror-view's
              // `DecorationGroup.eq` then throws `this.members[i] is
              // undefined` during `updateState` — crashing the WHOLE
              // editor on every document (read or write). Confirmed by
              // toggling: editor renders with this off, crashes with it
              // on.
              //
              // We still broadcast our own caret via
              // `ephemeralStore.setLocal` below (harmless, no
              // decorations) so re-enabling remote rendering is a
              // one-liner once loro-prosemirror ships a release
              // compatible with current prosemirror. Until then, live
              // remote carets are disabled; collaborative *editing*
              // (LoroSyncPlugin) is unaffected.
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
    if (agentResource && ephemeralStore) {
      ephemeralStore.setLocal({
        user: {
          name: agentResource.props.name ?? 'Untitled Agent',
          color,
        },
      });
    }
  }, [agentResource, ephemeralStore, color]);

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
          <EditorContent key="rich-editor" editor={editor}>
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

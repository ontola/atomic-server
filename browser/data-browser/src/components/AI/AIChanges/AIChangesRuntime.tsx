import { useCallback, useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import styled from 'styled-components';
import type { JSONContent } from '@tiptap/core';
import { Button } from '@components/Button';
import {
  dataBrowser,
  StoreEvents,
  useResource,
  useStore,
  type Resource,
} from '@tomic/react';
import { Dialog, useDialog } from '@components/Dialog';
import {
  ResourceDiff,
  useResourceDiff,
} from '@components/ResourceDiff/ResourceDiff';
import { Details } from '@components/Details';
import { Column, Row } from '@components/Row';
import toast from 'react-hot-toast';
import {
  IconButton,
  IconButtonVariant,
} from '@components/IconButton/IconButton';
import { FaCheck, FaXmark } from 'react-icons/fa6';
import { plural } from '@helpers/plural';
import { readDocumentV2TiptapJson } from '@chunks/RTE/readDocumentV2TiptapJson';
import { applyPatchedJsonToLoroDocCollaborative } from '@chunks/RTE/applyPatchedJsonToLoroDocCollaborative';
import {
  ensureAIReviewPersistHoldInstalled,
  holdAIReviewEdits,
  releaseAIReviewEdits,
} from '@chunks/AI/aiReviewPersistHold';
import type { AIChangesContextType } from '@components/AIChangesContext';

export const AIChangesRuntime: React.FC<{
  setValue: React.Dispatch<React.SetStateAction<AIChangesContextType>>;
  onRuntimeReady: () => void;
}> = ({ setValue, onRuntimeReady }) => {
  const store = useStore();
  const [changes, setChanges] = useState<string[]>([]);
  const [oldResources, setOldResources] = useState<Record<string, Resource>>(
    {},
  );
  const [oldDocumentSnapshots, setOldDocumentSnapshots] = useState<
    Record<string, JSONContent>
  >({});

  const [dialogProps, showDialog, hideDialog, dialogVisible] = useDialog();

  const hasReportedReadyRef = useRef(false);

  useEffect(() => {
    ensureAIReviewPersistHoldInstalled(store);
  }, [store]);

  const removeTrackedChange = useCallback(
    (subject: string) => {
      releaseAIReviewEdits(store, subject);
      let nextCount = 0;
      flushSync(() => {
        setChanges(prev => {
          const next = prev.filter(c => c !== subject);
          nextCount = next.length;

          return next;
        });
        setOldResources(prev => {
          const newResources = { ...prev };
          delete newResources[subject];

          return newResources;
        });
        setOldDocumentSnapshots(prev => {
          const next = { ...prev };
          delete next[subject];

          return next;
        });
      });

      if (nextCount === 0) {
        hideDialog();
      }
    },
    [hideDialog, store],
  );

  const reportAIEdit = useCallback(
    (originalResource: Resource) => {
      const subject = originalResource.subject;
      holdAIReviewEdits(store, subject);

      let documentSnapshot: JSONContent | undefined;

      if (originalResource.hasClasses(dataBrowser.classes.documentV2)) {
        const read = readDocumentV2TiptapJson(originalResource, store);

        if (read.ok) {
          documentSnapshot = read.docJson;
        }
      }

      flushSync(() => {
        setOldResources(prev => {
          if (prev[subject]) return prev;

          return {
            ...prev,
            [subject]: originalResource,
          };
        });

        if (documentSnapshot) {
          setOldDocumentSnapshots(prev => {
            if (prev[subject]) return prev;

            return {
              ...prev,
              [subject]: documentSnapshot!,
            };
          });
        }

        setChanges(prev => {
          if (prev.includes(subject)) {
            return prev;
          }

          return [...prev, subject];
        });
      });
    },
    [store],
  );

  const revertResource = useCallback(
    async (subject: string) => {
      const currentResource = await store.getResource(subject);
      const snapshotJson = oldDocumentSnapshots[subject];

      if (
        snapshotJson &&
        currentResource.hasClasses(dataBrowser.classes.documentV2)
      ) {
        const loroDoc = currentResource.getLoroDoc();

        if (loroDoc) {
          await applyPatchedJsonToLoroDocCollaborative({
            store,
            loroDoc,
            subject,
            patchedJson: snapshotJson,
          });
        }
      } else {
        await currentResource.refresh();
      }

      removeTrackedChange(subject);
    },
    [store, oldDocumentSnapshots, removeTrackedChange],
  );

  const acceptChanges = useCallback(
    async (resource: Resource) => {
      try {
        releaseAIReviewEdits(store, resource.subject);
        resource.markDirty();
        await resource.save();
      } catch (error) {
        console.error(error);
        toast.error('Failed to save changes');
      }
    },
    [store],
  );

  useEffect(() => {
    setValue({
      changes,
      oldResources,
      oldDocumentSnapshots,
      reportAIEdit,
      revertResource,
      acceptChanges,
    });

    if (!hasReportedReadyRef.current) {
      hasReportedReadyRef.current = true;
      onRuntimeReady();
    }
  }, [
    changes,
    oldResources,
    oldDocumentSnapshots,
    reportAIEdit,
    revertResource,
    acceptChanges,
    setValue,
    onRuntimeReady,
  ]);

  return (
    <>
      {changes.map(subject => (
        <ResourceSavedListener
          key={subject}
          subject={subject}
          onRemove={removeTrackedChange}
        />
      ))}
      {changes.map(subject => (
        <OldSnapshotScalarSyncListener
          key={`scalar-sync-${subject}`}
          subject={subject}
          oldResource={oldResources[subject]}
        />
      ))}
      {changes.length > 0 && (
        <FloatingReviewEditsButton
          onClick={() => {
            showDialog();
          }}
          editCount={changes.length}
        />
      )}
      <Dialog {...dialogProps} width="80ch">
        {dialogVisible && (
          <>
            <Dialog.Title>
              <h1>Review Edits</h1>
            </Dialog.Title>
            <Dialog.Content>
              <Column>
                {changes.map(change => (
                  <DiffItem
                    key={change}
                    originalResource={oldResources[change]}
                    onRevert={() => revertResource(change)}
                    onAccept={acceptChanges}
                  />
                ))}
              </Column>
            </Dialog.Content>
          </>
        )}
      </Dialog>
    </>
  );
};

/**
 * Merges scalar property updates from collaborators into the pre-AI snapshot.
 * Document body is frozen at edit time — never merge Loro doc updates here.
 */
const OldSnapshotScalarSyncListener: React.FC<{
  subject: string;
  oldResource: Resource;
}> = ({ subject, oldResource }) => {
  const store = useStore();

  useEffect(() => {
    return store.subscribe(subject, newR => {
      oldResource.merge(newR, {
        omitKeysFromMerge: [dataBrowser.properties.documentContent],
      });
    });
  }, [subject, store, oldResource]);

  return null;
};

/** Clears AI edit tracking when `StoreEvents.ResourceSaved` fires (save from any UI). */
const ResourceSavedListener: React.FC<{
  subject: string;
  onRemove: (subject: string) => void;
}> = ({ subject, onRemove }) => {
  const store = useStore();

  useEffect(() => {
    return store.on(StoreEvents.ResourceSaved, resource => {
      if (resource.subject === subject) {
        onRemove(subject);
      }
    });
  }, [store, subject, onRemove]);

  return null;
};

interface FloatingReviewEditsButtonProps {
  onClick: () => void;
  editCount: number;
}

const FloatingReviewEditsButton: React.FC<FloatingReviewEditsButtonProps> = ({
  onClick,
  editCount,
}) => {
  return (
    <FloatingWrapper>
      <Button onClick={onClick}>
        Review {editCount} {plural(editCount, ['edit', 'edits'])}
      </Button>
    </FloatingWrapper>
  );
};

interface DiffItemProps {
  originalResource: Resource;
  onRevert: () => void;
  onAccept: (resource: Resource) => void;
}

const DiffItem: React.FC<DiffItemProps> = ({
  originalResource,
  onRevert,
  onAccept,
}) => {
  const currentResource = useResource(originalResource.subject);
  const diff = useResourceDiff(originalResource, currentResource);

  return (
    <Details
      title={
        <Row center justify="space-between">
          <h2>{currentResource.title}</h2>
          <ConfirmChangesButtons
            onRevert={onRevert}
            onConfirm={() => onAccept(currentResource)}
          />
        </Row>
      }
      summaryClickable={false}
      initialState={true}
    >
      <StyledResourceDiff diff={diff} />
    </Details>
  );
};

interface ConfirmChangesButtonsProps {
  onRevert: () => void;
  onConfirm: () => void;
}

const ConfirmChangesButtons: React.FC<ConfirmChangesButtonsProps> = ({
  onRevert,
  onConfirm,
}) => {
  return (
    <Row>
      <IconButton title="Revert Changes" onClick={onRevert}>
        <FaXmark />
      </IconButton>
      <IconButton
        variant={IconButtonVariant.Colored}
        color="main"
        title="Confirm Changes"
        onClick={onConfirm}
      >
        <FaCheck />
      </IconButton>
    </Row>
  );
};

const FloatingWrapper = styled.div`
  position: fixed;
  bottom: 1rem;
  right: 2rem;
  z-index: 1000;
`;

const StyledResourceDiff = styled(ResourceDiff)`
  margin-top: 0.5rem;
`;

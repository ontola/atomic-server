import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import { flushSync } from 'react-dom';
import styled from 'styled-components';
import { Button } from './Button';
import {
  dataBrowser,
  StoreEvents,
  useResource,
  useStore,
  type Resource,
} from '@tomic/react';
import { Dialog, useDialog } from './Dialog';
import { ResourceDiff, useResourceDiff } from './ResourceDiff/ResourceDiff';
import { Details } from './Details';
import { Column, Row } from './Row';
import toast from 'react-hot-toast';
import { IconButton, IconButtonVariant } from './IconButton/IconButton';
import { FaCheck, FaXmark } from 'react-icons/fa6';
import { plural } from '@helpers/plural';

interface AIChangesContextType {
  changes: string[];
  oldResources: Record<string, Resource>;
  reportAIEdit: (originalResource: Resource) => void;
  revertResource: (subject: string) => void;
}

const AIChangesContext = createContext<AIChangesContextType>({
  changes: [],
  oldResources: {},
  reportAIEdit: () => {},
  revertResource: () => {},
});

export const AIChangesProvider: React.FC<React.PropsWithChildren> = ({
  children,
}) => {
  const store = useStore();
  const [changes, setChanges] = useState<string[]>([]);
  const [oldResources, setOldResources] = useState<Record<string, Resource>>(
    {},
  );

  const [dialogProps, showDialog, hideDialog, dialogVisible] = useDialog();

  const removeTrackedChange = useCallback(
    (subject: string) => {
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
      });

      if (nextCount === 0) {
        hideDialog();
      }
    },
    [hideDialog],
  );

  const reportAIEdit = (originalResource: Resource) => {
    const subject = originalResource.subject;
    // Save a clone of the resource before it was edited.
    setOldResources(prev => {
      // Only save the oldest state if we haven't tracked it yet
      if (prev[subject]) return prev;

      return {
        ...prev,
        [subject]: originalResource,
      };
    });

    setChanges(prev => {
      if (prev.includes(subject)) {
        return prev;
      }

      return [...prev, subject];
    });
  };

  const revertResource = async (subject: string) => {
    const currentResource = await store.getResource(subject);

    await currentResource.refresh();
    removeTrackedChange(subject);
  };

  const context = {
    changes,
    oldResources,
    reportAIEdit,
    revertResource,
  };

  return (
    <AIChangesContext value={context}>
      {children}
      {changes.map(subject => (
        <ResourceSavedListener
          key={subject}
          subject={subject}
          onRemove={removeTrackedChange}
        />
      ))}
      {changes.map(subject => (
        <OldSnapshotYSyncListener
          key={`ysync-${subject}`}
          subject={subject}
          oldResource={oldResources[subject]}
          onChange={() => {
            setOldResources(prev => ({
              ...prev,
              [subject]: oldResources[subject].clone(),
            }));
          }}
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
                  />
                ))}
              </Column>
            </Dialog.Content>
          </>
        )}
      </Dialog>
    </AIChangesContext>
  );
};

type useAIChangesResult = {
  hasAIChanges: (subject: string) => boolean;
} & AIChangesContextType;

export function useAIChanges(): useAIChangesResult {
  const context = useContext(AIChangesContext);
  const { changes } = context;

  const hasAIChanges = (subject: string) => {
    return changes.includes(subject);
  };

  return {
    ...context,
    hasAIChanges,
  };
}

/**
 * Merges realtime YSync doc updates into the pre-AI snapshot so revert matches
 * collaborators' unsaved Yjs state (YSync is not persisted on HTTP).
 */
const OldSnapshotYSyncListener: React.FC<{
  subject: string;
  oldResource: Resource;
  onChange: () => void;
}> = ({ subject, oldResource, onChange }) => {
  const store = useStore();

  useEffect(() => {
    // Known issue: Because we sync changes from the server to the old document. Because of the way subscriptions work the new local value is actually set on the old resource when someone else changes the same property.
    const unsub = store.subscribe(subject, newR => {
      // Merge scalar props from the live resource, but never merge the document
      // LoroDoc here: that would CRDT-merge the AI-edited doc into the pre-AI
      // snapshot and clear the diff. Collaborative Loro updates are applied only
      // via subscribeLoroSync below.
      oldResource.merge(newR, {
        omitKeysFromMerge: [dataBrowser.properties.documentContent],
      });
      onChange();
    });

    const unsubLoroSync = store.subscribeLoroSync(subject, loroUpdate => {
      oldResource.importLoroUpdate(loroUpdate);
      onChange();
    });

    return () => {
      unsub();
      unsubLoroSync();
    };
  }, [subject, store, oldResource, onChange]);

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
}

const DiffItem: React.FC<DiffItemProps> = ({ originalResource, onRevert }) => {
  const currentResource = useResource(originalResource.subject);
  const diff = useResourceDiff(originalResource, currentResource);

  const handleConfirm = async () => {
    try {
      await currentResource.save();
    } catch (error) {
      console.error(error);
      toast.error('Failed to save changes');
    }
  };

  return (
    <Details
      title={
        <Row center justify="space-between">
          <h2>{currentResource.title}</h2>
          <ConfirmChangesButtons
            onRevert={onRevert}
            onConfirm={handleConfirm}
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

import type { Property } from '@tomic/react';
import { useEffect, useState, type JSX } from 'react';
import { styled } from 'styled-components';
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  useDialog,
} from '@components/Dialog';
import { Button } from '@components/Button';
import {
  QuickAddFields,
  draftFromSpec,
  isQuickAddDraftComplete,
  specFromDraft,
  type QuickAddDraft,
} from './QuickAddFields';
import type { QuickAddSpec } from './quickAdd';

interface Props {
  open: boolean;
  bindShow: (show: boolean) => void;
  classProperties: Property[];
  /** The spec being edited, if the view already has one. */
  editing?: QuickAddSpec;
  onSave: (spec: QuickAddSpec | undefined) => void;
}

/**
 * Configures a view's create button. The fields themselves are shared with the
 * dashboard block that stores the identical shape — one capability, one form.
 */
export function QuickAddDialog({
  open,
  bindShow,
  classProperties,
  editing,
  onSave,
}: Props): JSX.Element {
  const [dialogProps, show, hide, isOpen] = useDialog({ bindShow });
  const [draft, setDraft] = useState<QuickAddDraft>(() =>
    draftFromSpec(undefined),
  );

  useEffect(() => {
    if (open) {
      show();
    }
  }, [open, show]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setDraft(draftFromSpec(editing));
    // Only on open: re-syncing while the dialog is up would overwrite what is
    // being typed every time a commit lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  return (
    <Dialog {...dialogProps}>
      <DialogTitle>
        <h2>{editing ? 'Edit the add button' : 'Add a create button'}</h2>
      </DialogTitle>
      <DialogContent>
        <Fields>
          <Intro>
            It sits above the rows and creates one. Everything else about the
            row is edited in the table.
          </Intro>
          <QuickAddFields
            draft={draft}
            onChange={setDraft}
            classProperties={classProperties}
          />
        </Fields>
      </DialogContent>
      <DialogActions>
        {editing && (
          <Button
            subtle
            data-testid='quick-add-config-remove'
            onClick={() => {
              onSave(undefined);
              hide();
            }}
          >
            Remove
          </Button>
        )}
        <Button subtle onClick={() => hide()}>
          Cancel
        </Button>
        <Button
          data-testid='quick-add-config-save'
          disabled={!isQuickAddDraftComplete(draft)}
          onClick={() => {
            onSave(specFromDraft(draft));
            hide();
          }}
        >
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

const Fields = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${p => p.theme.size(2)};
`;

const Intro = styled.p`
  margin: 0;
  font-size: 0.85rem;
  color: ${p => p.theme.colors.textLight};
`;

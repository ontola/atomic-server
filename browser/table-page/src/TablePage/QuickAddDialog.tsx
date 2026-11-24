import { resourceTheme } from '@tomic/resource-ui/theme';
import type { Property } from '@tomic/react';
import { useEffect, useState, type JSX } from 'react';
import { styled } from 'styled-components';
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  useDialog,
} from '@tomic/resource-ui/components/Dialog/index';
import { Button } from '@tomic/ui/components/Button';
import { ErrorChip } from '@tomic/resource-ui/components/forms/ErrorChip';
import {
  QuickAddFields,
  draftFromSpec,
  isQuickAddDraftComplete,
  specFromDraft,
  type QuickAddDraft,
} from './QuickAddFields.js';
import type { QuickAddSpec } from './quickAdd.js';
import { useDialogSave } from './helpers/useDialogSave.js';

interface Props {
  open: boolean;
  bindShow: (show: boolean) => void;
  classProperties: Property[];
  /** The spec being edited, if the view already has one. */
  editing?: QuickAddSpec;
  onSave: (spec: QuickAddSpec | undefined) => void | Promise<void>;
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
  const [editingExisting, setEditingExisting] = useState(!!editing);
  const { busy, error, clearError, submit, cancel } = useDialogSave(hide);

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
    setEditingExisting(!!editing);
    clearError();
    // Only on open: re-syncing while the dialog is up would overwrite what is
    // being typed every time a commit lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  return (
    <Dialog
      {...dialogProps}
      aria-busy={busy}
      disableLightDismiss={busy}
      onClose={cancel}
    >
      <DialogTitle>
        <h2>
          {editingExisting ? 'Edit the add button' : 'Add a create button'}
        </h2>
      </DialogTitle>
      <DialogContent>
        <Fields inert={busy}>
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
        {error && <ErrorChip role='alert'>{error}</ErrorChip>}
      </DialogContent>
      <DialogActions>
        {editingExisting && (
          <Button
            subtle
            disabled={busy}
            data-testid='quick-add-config-remove'
            onClick={() => submit(() => onSave(undefined))}
          >
            Remove
          </Button>
        )}
        <Button subtle disabled={busy} onClick={cancel}>
          Cancel
        </Button>
        <Button
          data-testid='quick-add-config-save'
          disabled={busy || !isQuickAddDraftComplete(draft, classProperties)}
          onClick={() =>
            submit(() => onSave(specFromDraft(draft, classProperties)))
          }
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
  gap: ${p => resourceTheme(p.theme).size(2)};
`;

const Intro = styled.p`
  margin: 0;
  font-size: 0.85rem;
  color: ${p => resourceTheme(p.theme).colors.textLight};
`;

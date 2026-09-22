import { core, dataBrowser } from '@tomic/react';
import {
  useCallback,
  useEffect,
  useState,
  type FC,
  type FormEvent,
} from 'react';
import { styled } from 'styled-components';
import { Button } from '../../../../Button';
import {
  Dialog,
  DialogActions,
  DialogContent,
  useDialog,
} from '../../../../Dialog';
import Field from '../../../Field';
import { InputStyled, InputWrapper } from '../../../InputStyles';
import { useCreateAndNavigate } from '../../../../../hooks/useCreateAndNavigate';
import type { CustomResourceDialogProps } from '../../useNewResourceUI';

/**
 * Asks for a name and nothing else.
 *
 * The old Dashboard catalog entry now creates a composed View. Existing
 * Dashboard resources still open, but new block pages share the View model.
 */
export const NewDashboardDialog: FC<CustomResourceDialogProps> = ({
  parent,
  onClose,
  skipNavigation,
  onCreated,
}) => {
  const [name, setName] = useState('');
  const createResourceAndNavigate = useCreateAndNavigate();

  const onSuccess = useCallback(async () => {
    await createResourceAndNavigate(
      dataBrowser.classes.view,
      {
        [core.properties.name]: name.trim() || 'Dashboard',
        [dataBrowser.properties.viewKind]: 'dashboard',
      },
      { parent, skipNavigation, onCreated },
    );

    onClose();
  }, [
    name,
    parent,
    skipNavigation,
    onCreated,
    createResourceAndNavigate,
    onClose,
  ]);

  const [dialogProps, show, hide] = useDialog({ onSuccess, onCancel: onClose });

  useEffect(() => {
    show();
    // Once, on mount — this dialog exists because it was opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Dialog {...dialogProps}>
      <H1>New Dashboard</H1>
      <DialogContent>
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            hide(true);
          }}
        >
          <Field required label='Name'>
            <InputWrapper>
              <InputStyled
                placeholder='Overview'
                data-testid='new-dashboard-name'
                value={name}
                autoFocus
                onChange={e => setName(e.target.value)}
              />
            </InputWrapper>
          </Field>
          <Explanation>
            You add its blocks — numbers, charts, buttons, tables — on the
            dashboard itself.
          </Explanation>
        </form>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => hide(false)} subtle>
          Cancel
        </Button>
        <Button
          onClick={() => hide(true)}
          data-testid='new-dashboard-create'
          disabled={name.trim() === ''}
        >
          Create
        </Button>
      </DialogActions>
    </Dialog>
  );
};

const H1 = styled.h1`
  margin: 0;
`;

const Explanation = styled.p`
  color: ${p => p.theme.colors.textLight};
  max-width: 60ch;
`;

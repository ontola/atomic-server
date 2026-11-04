import type { JSX } from 'react';
import { FaFloppyDisk } from 'react-icons/fa6';
import { styled } from 'styled-components';
import { useCurrentAgent } from '@tomic/react';
import { Button } from '../Button';
import { UiHint } from '../UiHint';
import { openSaveWorkDialog } from '../SaveWork/saveWorkDialogState';
import { useIsLinkedToAccount } from '../../hooks/useIsLinkedToAccount';
import { useKnownPortalUrl } from '../../hooks/useKnownPortalUrl';

/**
 * The next step for a guest, fixed above the account row: the work is saved
 * on this device, and one action makes it safe everywhere. Not a pop-up and
 * not dismissable; it goes away once the identity is saved to an account.
 */
export function GuestSaveRow(): JSX.Element | null {
  const [agent] = useCurrentAgent();
  const linked = useIsLinkedToAccount();
  const portalUrl = useKnownPortalUrl();

  if (!agent || linked) return null;

  return (
    <Wrapper data-testid='guest-save-row'>
      <Label>
        <FaFloppyDisk aria-hidden />
        <span>Saved on this device</span>
      </Label>
      <UiHint target='save-row'>
        <Button
          subtle
          onClick={openSaveWorkDialog}
          data-testid='guest-save-button'
        >
          {portalUrl ? 'Add your email' : 'Connect a device'}
        </Button>
      </UiHint>
    </Wrapper>
  );
}

const Wrapper = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 0.25rem 0.5rem;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  margin-bottom: 0.25rem;
  padding: 0.25rem 0.25rem 0.25rem 0.5rem;
  border-radius: ${p => p.theme.radius};
  background: ${p => p.theme.colors.bg1};
`;

const Label = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  min-width: 0;
  font-size: 0.85rem;
  color: ${p => p.theme.colors.textLight};
`;

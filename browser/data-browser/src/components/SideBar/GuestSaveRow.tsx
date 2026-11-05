import type { JSX } from 'react';
import { LuCloudOff } from 'react-icons/lu';
import { styled } from 'styled-components';
import { useCurrentAgent } from '@tomic/react';
import { UiHint } from '../UiHint';
import { openSaveWorkDialog } from '../SaveWork/saveWorkDialogState';
import { useIsLinkedToAccount } from '../../hooks/useIsLinkedToAccount';
import { useKnownPortalUrl } from '../../hooks/useKnownPortalUrl';
import {
  IconSlot,
  SideBarMenuRow,
  SideBarMenuRowLabel,
} from './SideBarMenuItem';

/**
 * The next step for a guest, a plain sidebar row above the account row: the
 * work is only on this device, and one click makes it safe everywhere. Not a
 * pop-up and not dismissable; it goes away once the identity is saved to an
 * account.
 */
export function GuestSaveRow(): JSX.Element | null {
  const [agent] = useCurrentAgent();
  const linked = useIsLinkedToAccount();
  const portalUrl = useKnownPortalUrl();

  if (!agent || linked) return null;

  return (
    <UiHint target='save-row'>
      <Row
        as='button'
        type='button'
        onClick={openSaveWorkDialog}
        data-testid='guest-save-row'
      >
        <WarnIcon aria-hidden>
          <LuCloudOff />
        </WarnIcon>
        <Text>
          <Action>{portalUrl ? 'Save & register' : 'Connect a device'}</Action>
          <Note>Only saved on this device</Note>
        </Text>
      </Row>
    </UiHint>
  );
}

const Row = styled(SideBarMenuRow)`
  border: 0;
  font: inherit;
  cursor: pointer;
  padding-inline-end: 0.5rem;
  padding-block: 0.25rem;

  &:focus-visible {
    outline: 2px solid ${p => p.theme.colors.main};
    outline-offset: -2px;
  }
`;

const WarnIcon = styled(IconSlot)`
  color: ${p => p.theme.colors.warning};

  svg {
    font-size: 0.95rem;
  }
`;

const Text = styled.span`
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
  text-align: start;
  line-height: 1.25;
`;

const Action = styled(SideBarMenuRowLabel)`
  flex: none;
  color: ${p => p.theme.colors.main};
`;

const Note = styled(SideBarMenuRowLabel)`
  flex: none;
  font-size: 0.75rem;
  color: ${p => p.theme.colors.textLight};
`;

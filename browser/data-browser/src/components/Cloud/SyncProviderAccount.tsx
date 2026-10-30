import { useEffect, useId, useRef, useState } from 'react';
import { styled } from 'styled-components';
import { FaCloud } from 'react-icons/fa6';
import { CardIcon, CARD_SUB_FONT, CARD_TITLE_FONT } from '../cardSurface';
import { PRODUCT_NAME } from '../../helpers/managed/product';
import { openExternal } from '../../helpers/openExternal';
import { isRunningInTauri } from '../../helpers/tauri';
import { canHoldProviderCookie } from '../../helpers/managed/deviceLink';
import { LinkProviderPanel } from '../Vault/LinkProviderPanel';
import { Button } from '../Button';

export interface SyncProviderAccountProps {
  portalUrl: string;
  email: string | null;
  emailRecoveryOn: boolean;
  onLinked: () => void;
}

/** The account entry point in the Sync page's provider card. */
export function SyncProviderAccount({
  portalUrl,
  email,
  emailRecoveryOn,
  onLinked,
}: SyncProviderAccountProps) {
  const signedIn = email !== null;
  const needsLink = !signedIn && !canHoldProviderCookie(portalUrl);
  const [showSignIn, setShowSignIn] = useState(false);
  const panelId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const url = `${portalUrl}/${signedIn ? 'dashboard' : 'signin'}`;

  useEffect(() => {
    if (showSignIn)
      panel.current?.querySelector<HTMLElement>('input, button')?.focus();
  }, [showSignIn]);

  return (
    <>
      <ProviderHeader>
        <CardIcon $tone='provider'>
          <FaCloud />
        </CardIcon>
        <AccountBody>
          <AccountLabel>{PRODUCT_NAME}</AccountLabel>
          <AccountEmail data-testid='provider-account'>
            {signedIn
              ? emailRecoveryOn
                ? `${email} · Email recovery on`
                : email
              : 'Not signed in'}
          </AccountEmail>
        </AccountBody>
        {needsLink ? (
          <SignInButton
            clean
            data-testid='provider-signin-toggle'
            aria-expanded={showSignIn}
            aria-controls={panelId}
            onClick={() => {
              setShowSignIn(true);
              panel.current
                ?.querySelector<HTMLElement>('input, button')
                ?.focus();
            }}
          >
            Sign in →
          </SignInButton>
        ) : (
          <PortalLink
            data-testid='provider-portal-link'
            href={url}
            target={isRunningInTauri() ? undefined : '_blank'}
            rel='noreferrer'
            onClick={event => {
              event.preventDefault();
              void openExternal(url);
            }}
          >
            {signedIn ? 'Manage account →' : 'Sign in →'}
          </PortalLink>
        )}
      </ProviderHeader>
      {needsLink && showSignIn && (
        <SignInPanel id={panelId} ref={panel}>
          <LinkProviderPanel
            compact
            portalUrl={portalUrl}
            onLinked={onLinked}
          />
        </SignInPanel>
      )}
    </>
  );
}

const ProviderHeader = styled.div`
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.9rem 1rem;
`;
const AccountBody = styled.div`
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
`;
const AccountLabel = styled.span`
  font-size: ${CARD_TITLE_FONT};
  font-weight: 600;
`;
const AccountEmail = styled.span`
  color: ${p => p.theme.colors.textLight};
  font-size: ${CARD_SUB_FONT};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;
const PortalLink = styled.a`
  color: ${p => p.theme.colors.main};
  font-size: 0.8rem;
  text-decoration: none;
  margin-top: 0.15rem;
  &:hover {
    text-decoration: underline;
  }
`;

const SignInButton = styled(Button)`
  color: ${p => p.theme.colors.main};
  font-size: 0.8rem;
  margin-top: 0.15rem;
  &:hover {
    text-decoration: underline;
  }
`;
const SignInPanel = styled.div`
  padding: 0 1rem 0.9rem;
`;

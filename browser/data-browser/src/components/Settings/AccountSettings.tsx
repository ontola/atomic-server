import { useEffect, useRef, useState } from 'react';
import { core, urls, useCurrentAgent, useStore } from '@tomic/react';
import { useSettings } from '../../helpers/AppSettings';
import { Button } from '../Button';
import { Column, Row } from '../Row';
import { WarningBlock } from '../WarningBlock';
import { AccountRecoveryCard } from '../AccountRecoveryCard';
import { ConnectedAppsCard } from '../ConnectedAppsCard';
import { AgentProfileHeader } from '../AgentProfileHeader';
import { DeviceLockCard } from '../DeviceLockCard';
import { SignInButton } from '../SignInButton';
import { editURL } from '../../helpers/navigation';
import { useNavigateWithTransition } from '../../hooks/useNavigateWithTransition';
import { useSavedDrives } from '../../hooks/useSavedDrives';
import { useDriveHistory } from '../../hooks/useDriveHistory';
import { usePrivateDrive } from '../../hooks/usePrivateDrive';
import { paths } from '../../routes/paths';
import { signOutEverywhere } from '../../helpers/managed/signOut';
import { clearHeartbeat } from '../../helpers/deviceLock';
import { saveAgentToIDB } from '@helpers/agentStorage';
import { SettingsSection } from './SettingsSection';
import { useSettingsSearch } from './SettingsSearch';

/** Two top-level sections: Profile (name, avatar, sign out) and Account &
 *  security (recovery, connected apps, this device). One component because
 *  both share the sign-out flow. */
export function AccountSettings() {
  const store = useStore();
  const { agent, drive, setAgent, setDrive } = useSettings();
  // Sometimes the settings context can briefly lag behind the store on first
  // navigation. Fall back to the store-backed hook to avoid flashing the
  // logged-out panel for signed-in users.
  const [storeAgent] = useCurrentAgent();
  const effectiveAgent = agent ?? storeAgent ?? store.getAgent();
  const navigate = useNavigateWithTransition();
  const leavingAccount = useRef(false);
  const { section } = useSettingsSearch();

  const { privateDrive, loading: privateDriveLoading } = usePrivateDrive();
  const [savedDrives] = useSavedDrives();
  const [, , removeFromHistory] = useDriveHistory(savedDrives);

  // atomic.place sends someone here to add a passkey (`?add=passkey`): only
  // this app holds the identity, so only here can a new passkey also open the
  // backup. Say so, and open the recovery section.
  const [addPasskey] = useState(
    () => new URLSearchParams(window.location.search).get('add') === 'passkey',
  );

  // Asked for by link while signed out → the one canonical sign-in surface is
  // /app/welcome (GettingStartedFlow), not a second login form here.
  useEffect(() => {
    if (
      !effectiveAgent &&
      (section === 'account' || section === 'profile') &&
      !leavingAccount.current
    ) {
      navigate({ to: `${paths.welcome}?return_to=agent`, replace: true });
    }
  }, [effectiveAgent, section, navigate]);

  /**
   * Lock, not sign out: drops the usable agent from this device so the next
   * load needs a passkey (or the secret), while deliberately keeping the
   * control-plane session and the cached backup — it's still your machine and
   * your account, you're just closing the door behind you.
   */
  function handleLockNow() {
    leavingAccount.current = true;
    clearHeartbeat();
    setAgent(undefined);
    setDrive('');
    void saveAgentToIDB(undefined);
    navigate({ to: paths.welcome, replace: true });
  }

  /**
   * `forget` also drops this device's cached copy of the encrypted backup, so
   * signing back in needs the full route again (email, then a passkey or
   * recovery code) rather than just a fingerprint. For shared or borrowed
   * machines.
   */
  async function handleSignOut({ forget = false } = {}) {
    const currentDrive = drive;
    // Finish clearing the cookie before a subsequent sign-in can set a new one.
    // A late logout response otherwise invalidates the newly-created session.
    await signOutEverywhere({ agentSubject: effectiveAgent?.subject, forget });

    // Everything that makes the UI say "signed out" happens now, synchronously.
    // `store.setAgent` drives a `useSyncExternalStore`, so the app re-renders
    // this tick; the private workspace is no longer readable, so clear the
    // active drive rather than leave it on screen; and go to the one sign-in
    // surface. The signed-out redirect above must not replace our destination.
    leavingAccount.current = true;
    setAgent(undefined);
    // Empty, not the server origin: a drive is a workspace, and the origin is
    // the pre-DID default standing in for one. Signed out, there is no
    // workspace — say that, don't fall back to the server's own.
    setDrive('');
    navigate({ to: paths.welcome, replace: true });

    // Best-effort: if the drive we just left was private, forget it from
    // history too, so it does not reappear as a suggestion to a signed-out
    // browser. Failure here changes nothing the user can see.
    void store
      .getResource(currentDrive)
      .then(driveResource => {
        const readRight = driveResource.get(core.properties.read);
        const readArray = Array.isArray(readRight) ? readRight : [];

        if (!readArray.includes(urls.instances.publicAgent)) {
          removeFromHistory?.(currentDrive);
        }
      })
      .catch(() => undefined);
  }

  if (!effectiveAgent) {
    return (
      <SettingsSection
        label='Account & security'
        id='account'
        childSearchKeywords='sign in account'
      >
        <SignInButton />
      </SettingsSection>
    );
  }

  return (
    <>
      <SettingsSection
        label='Profile'
        id='profile'
        childSearchKeywords='profile name avatar picture user agent sign out log out'
      >
        <Column>
          {effectiveAgent.subject?.startsWith('http://localhost') && (
            <WarningBlock>
              <WarningBlock.Title>Warning:</WarningBlock.Title>
              {
                "You're using a local Agent, which cannot authenticate on other domains, because its URL does not resolve."
              }
            </WarningBlock>
          )}
          <AgentProfileHeader subject={effectiveAgent.subject!} />
          <Row>
            <Button
              subtle
              onClick={() => navigate(editURL(effectiveAgent.subject!))}
            >
              More profile fields
            </Button>
            <Button
              subtle
              title='Sign out of this device.'
              onClick={() => void handleSignOut()}
              data-test='sign-out'
            >
              Sign out
            </Button>
          </Row>
        </Column>
      </SettingsSection>
      <SettingsSection
        label='Account & security'
        id='account'
        childSearchKeywords='account recovery passkey backup agent secret connected apps mcp device lock idle forget'
      >
        <Column>
          <SettingsSection
            label='Account recovery'
            initialState
            {...(addPasskey && { open: true })}
            childSearchKeywords='recovery passkey backup agent secret new device'
          >
            {addPasskey && (
              <p
                ref={el => el?.scrollIntoView({ block: 'start' })}
                data-test='add-passkey-landing'
              >
                Add your passkey here. A passkey added in the app also unlocks
                your encrypted backup, which only the app can do.
              </p>
            )}
            <AccountRecoveryCard agentSubject={effectiveAgent.subject} />
          </SettingsSection>
          {!privateDriveLoading && (privateDrive ?? drive) && (
            <SettingsSection
              label='Connected apps'
              initialState
              childSearchKeywords='apps ai assistant mcp key revoke'
            >
              <ConnectedAppsCard home={(privateDrive ?? drive)!} />
            </SettingsSection>
          )}
          <SettingsSection
            label='This device'
            initialState
            childSearchKeywords='device lock idle close browser sign out forget backup'
          >
            <DeviceLockCard
              agentSubject={effectiveAgent.subject}
              onLockNow={handleLockNow}
            />
            {/* Here rather than beside "Sign out", because what it does is to
                this device: it drops the copy of the encrypted backup held
                here. */}
            <Row>
              <Button
                subtle
                title='Sign out and remove this device’s copy of your encrypted backup'
                onClick={() => void handleSignOut({ forget: true })}
                data-test='sign-out-forget'
              >
                Sign out &amp; forget this device
              </Button>
            </Row>
          </SettingsSection>
        </Column>
      </SettingsSection>
    </>
  );
}

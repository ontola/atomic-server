import { useEffect, useState, type MouseEvent } from 'react';
import { styled } from 'styled-components';
import { FaKey } from 'react-icons/fa6';
import { StoreEvents, useStore } from '@tomic/react';
import {
  cardSurface,
  CardIcon,
  CARD_BODY_GAP,
  CARD_SUB_FONT,
  CARD_TITLE_FONT,
} from './cardSurface';
import { useSettings } from '../helpers/AppSettings';
import { fetchManagedInfo } from '../helpers/managedServer';
import { getManagedPortalUrl } from '../helpers/managed/cloudSync';
import {
  getRememberedManagedPortalUrl,
  safePortalUrl,
} from '../helpers/managed/api';
import {
  getManagedAccount,
  type ManagedAccount,
} from '../helpers/managed/session';
import {
  envelopeWrapperKinds,
  getRecoverySecret,
  readCachedBackups,
  sameAgent,
} from '../helpers/managed/recovery';
import { PRODUCT_NAME } from '../helpers/managed/product';
import { openExternal } from '../helpers/openExternal';
import { isRunningInTauri } from '../helpers/tauri';

/**
 * Where this account's encrypted backup actually is.
 *
 * Three answers, not two, because a backup on this device is not the thing
 * this row promises. `stored` means the control plane holds the sealed
 * envelope, which is what lets an email get you back in on hardware you do
 * not own yet. `device-only` means the sealed copy is in this browser and
 * nowhere else: a passkey still unlocks it here, and a lost laptop still
 * loses the account.
 *
 * `passkey-only` is stored, but the only thing that opens it is a passkey.
 * That is the default onboarding leaves behind, and a browser the passkey
 * never synced to (Firefox next to Safari, say) cannot get back in with it —
 * so it must not be drawn as covered.
 *
 * `null` until asked, and on failure — "we could not check" is not "you have
 * none", and telling someone their recovery is missing when the control
 * plane was merely unreachable is the one wrong answer this row can give.
 */
type RecoveryBackup = 'stored' | 'passkey-only' | 'device-only' | 'none';

/**
 * Whether an email gets this account back in on a new device.
 *
 * Lived on the Sync page as a row in the provider card, where it sat between
 * two storage tiers and read as a third one. It is about the account, not the
 * workspace, so it sits here above the recovery controls that act on it:
 * {@link AccountRecoveryCard} does the setting up, this answers "am I covered".
 *
 * Renders nothing when no provider portal is known, so a self-hosted install
 * is never told about a service it has not asked about.
 */
export function EmailRecoveryStatus({
  agentSubject,
}: {
  agentSubject?: string;
}) {
  const store = useStore();
  const { baseURL } = useSettings();
  const [portalUrl, setPortalUrl] = useState<string | null>(null);
  const [account, setAccount] = useState<ManagedAccount | null>(null);
  const [recovery, setRecovery] = useState<{
    account: ManagedAccount;
    value: RecoveryBackup | null;
  } | null>(null);
  const recoveryBackup =
    recovery?.account === account ? (recovery?.value ?? null) : null;

  useEffect(() => {
    let cancelled = false;

    fetchManagedInfo(baseURL)
      .catch(() => null)
      .then(info => {
        if (cancelled) return;

        setPortalUrl(
          safePortalUrl(
            getManagedPortalUrl(info) ?? getRememberedManagedPortalUrl(),
          ) ?? null,
        );
      });

    return () => {
      cancelled = true;
    };
  }, [baseURL]);

  // Re-asked on focus: signing in happens in the portal, in another tab or
  // window, and coming back should show the answer without a reload.
  useEffect(() => {
    let cancelled = false;
    let generation = 0;

    const refresh = async () => {
      const requestGeneration = ++generation;

      try {
        const next = await getManagedAccount();

        if (!cancelled && requestGeneration === generation) setAccount(next);
      } catch {
        if (!cancelled && requestGeneration === generation) setAccount(null);
      }
    };

    const onFocus = () => void refresh();

    void refresh();
    window.addEventListener('focus', onFocus);
    const unsubscribe = store.on(StoreEvents.AgentChanged, onFocus);

    return () => {
      cancelled = true;
      unsubscribe();
      window.removeEventListener('focus', onFocus);
    };
  }, [store]);

  useEffect(() => {
    if (!account) return;

    let cancelled = false;

    const set = (value: RecoveryBackup | null) => {
      if (!cancelled) setRecovery({ account, value });
    };

    void (async () => {
      try {
        const stored = await getRecoverySecret();

        if (stored) {
          const { hasPasskey, hasCode } = envelopeWrapperKinds(stored);
          set(hasPasskey && !hasCode ? 'passkey-only' : 'stored');

          return;
        }

        // Nothing on the server. Before calling that "no backup", ask whether
        // this browser is holding one: the recovery card below reads that
        // copy too, and the two must not contradict each other.
        const subject = agentSubject ?? store.getAgent()?.subject;
        const cached = readCachedBackups();
        const mine = subject
          ? cached.some(entry => sameAgent(entry.agent_subject, subject))
          : cached.length > 0;

        set(mine ? 'device-only' : 'none');
      } catch {
        set(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [account, agentSubject, store]);

  if (!portalUrl) return null;

  const signInUrl = `${portalUrl}/signin`;

  return (
    <Row data-testid='recovery-row'>
      {/* Blue only when it is actually set up. Neutral while unknown too, since
          a failed check must not be drawn as a missing backup. */}
      <CardIcon
        $tone={account && recoveryBackup === 'stored' ? 'provider' : 'neutral'}
      >
        <FaKey />
      </CardIcon>
      <Body>
        <Title>Email recovery</Title>
        <Sub>
          {!account
            ? `Sign in to your ${PRODUCT_NAME} account to check email recovery. Signing in to this workspace with a passkey or secret does not by itself connect your cloud account.`
            : recoveryBackup === null
              ? `Signed in as ${account.email}.`
              : recoveryBackup === 'stored'
                ? `${account.email}. We hold your key sealed, so this email gets you back in on a new device.`
                : recoveryBackup === 'passkey-only'
                  ? `${account.email}. We hold your key sealed, but only your passkey opens it. A browser your passkey has not synced to cannot get you back in — a recovery code would.`
                  : recoveryBackup === 'device-only'
                    ? `${account.email}. Your backup is sealed in this browser and nowhere else, so it unlocks here but a new device could not get you back in.`
                    : `${account.email}. No recovery backup stored, so losing every device loses this workspace.`}
        </Sub>
        {/* Signed in, the controls that fix any gap are in the recovery card
            right below, so this row only answers whether you are covered. */}
        {!account && (
          <SignInLink
            href={signInUrl}
            target={isRunningInTauri() ? undefined : '_blank'}
            rel='noreferrer'
            onClick={(e: MouseEvent) => {
              e.preventDefault();
              void openExternal(signInUrl);
            }}
          >
            Sign in to check recovery
          </SignInLink>
        )}
      </Body>
    </Row>
  );
}

const Row = styled.div`
  ${cardSurface}
`;

const Body = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${CARD_BODY_GAP};
  min-width: 0;
`;

const Title = styled.span`
  font-size: ${CARD_TITLE_FONT};
  font-weight: 600;
`;

const Sub = styled.span`
  color: ${p => p.theme.colors.textLight};
  font-size: ${CARD_SUB_FONT};
  line-height: 1.5;
`;

const SignInLink = styled.a`
  margin-top: 0.4rem;
  color: ${p => p.theme.colors.main};
  font-size: ${CARD_SUB_FONT};
`;

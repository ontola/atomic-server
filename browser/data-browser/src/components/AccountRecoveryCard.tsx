import { useEffect, useState } from 'react';
import { styled } from 'styled-components';
import { FaKey } from 'react-icons/fa6';
import { Button } from './Button';
import { Column, Row } from './Row';
import { CodeBlock } from './CodeBlock';
import { SecretCodeBlock } from './SecretCodeBlock';
import { ErrorLook } from './ErrorLook';
import { InputStyled, InputWrapper } from './forms/InputStyles';
import { getManagedAccount, PRODUCT_NAME } from '../helpers/managed';
import { useSettings } from '../helpers/AppSettings';
import { fetchManagedInfo } from '../helpers/managedServer';
import { getManagedPortalUrl } from '../helpers/managed/cloudSync';
import { getRememberedManagedPortalUrl } from '../helpers/managed/api';
import {
  addRecoveryCodeWrapper,
  envelopeWrapperKinds,
  getUnlockableRecoverySecret,
  revealSecretFromBackup,
  type RecoverySecret,
} from '../helpers/managed/recovery';

type BackupState =
  | { phase: 'loading' }
  | { phase: 'none' }
  | { phase: 'ready'; secret: RecoverySecret };

/**
 * Account recovery, for the managed (AtomicCloud) case: what currently
 * protects this account, plus the two actions that need the stored backup.
 *
 * Onboarding no longer displays the agent secret when a backup exists, so
 * this is where it lives. It's recoverable here because the backup blob holds
 * the secret encrypted under the DEK — the local keypair is non-extractable
 * (`agentStorage.ts`), but the blob is an independent copy, which is exactly
 * what it's for.
 */
export function AccountRecoveryCard({
  agentSubject,
}: {
  /** Picks this account's backup out of a device holding several. */
  agentSubject?: string;
}) {
  const [backup, setBackup] = useState<BackupState>({ phase: 'loading' });
  const [secret, setSecret] = useState<string | null>(null);
  const [newCode, setNewCode] = useState<string | null>(null);
  const [codeInput, setCodeInput] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  // Adding a wrapper is a *write* to the control plane, so unlike revealing
  // the secret it can't work from the local cache alone. Known up front so
  // the UI can offer a way in rather than failing on click.
  const { baseURL } = useSettings();
  const [hasSession, setHasSession] = useState<boolean | null>(null);
  const [portalUrl, setPortalUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const [session, info] = await Promise.all([
        getManagedAccount().catch(() => null),
        fetchManagedInfo(baseURL).catch(() => null),
      ]);

      if (cancelled) return;

      setHasSession(!!session);
      // Resolve the portal the same way every other surface does, rather than
      // reading `info.portalUrl` straight off the connected node.
      //
      // That direct read meant only a *managed* node could produce a portal
      // link, so this card hid "Sign in to add a recovery code" on exactly the
      // devices that need it — a browser pointed at a self-hosted or local
      // node, or a desktop app on its own embedded one. Worse, the hint below
      // still told the reader to sign in, because it keys off `hasSession`
      // alone: instructions to do something with no way to do it.
      setPortalUrl(
        getManagedPortalUrl(info) ?? getRememberedManagedPortalUrl(),
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [baseURL]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        // Server copy when a session can reach it, otherwise this device's
        // cached one. Using the server alone was wrong: after signing in with
        // a passkey off the local cache there's no portal session, so a
        // perfectly good backup reported itself as "nothing protects this
        // account" — and refused to show a secret it could plainly decrypt.
        const stored = await getUnlockableRecoverySecret(agentSubject);

        if (cancelled) return;

        setBackup(
          stored ? { phase: 'ready', secret: stored } : { phase: 'none' },
        );
      } catch {
        // Nothing reachable anywhere — the same as having no backup here.
        if (!cancelled) setBackup({ phase: 'none' });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [agentSubject]);

  async function handleReveal() {
    setLoading(true);
    setError(undefined);

    try {
      const revealed = await revealSecretFromBackup(
        codeInput.trim() || undefined,
        agentSubject,
      );

      if (revealed === null) {
        // Don't collapse the card to "nothing protects this account" — we
        // know a backup exists (it's what rendered these buttons). Say the
        // reveal failed and leave the other actions in place.
        setError('Could not reach your backup. Try again.');

        return;
      }

      setSecret(revealed);
      setNeedsCode(false);
    } catch (e) {
      const message =
        e instanceof Error ? e.message : 'Could not show your secret.';

      // The helper asks for a code when that's the only way in.
      if (message.toLowerCase().includes('enter your recovery')) {
        setNeedsCode(true);
      }

      setError(message);
    } finally {
      setLoading(false);
    }
  }

  async function handleAddCode() {
    setLoading(true);
    setError(undefined);

    try {
      const { recoveryCode, saved } =
        await addRecoveryCodeWrapper(agentSubject);
      setNewCode(recoveryCode);
      setBackup({ phase: 'ready', secret: saved });
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Could not add a recovery code.',
      );
    } finally {
      setLoading(false);
    }
  }

  if (backup.phase === 'loading') return null;

  if (backup.phase === 'none') {
    return (
      <Column gap='0.5rem'>
        <p>
          Nothing protects this account but the secret you saved during setup.
          That copy is the only one — we can&apos;t show it here, and we
          can&apos;t reset it. Keep it safe.
        </p>
      </Column>
    );
  }

  const { hasPasskey, hasCode } = envelopeWrapperKinds(backup.secret);

  return (
    <Column gap='0.75rem'>
      <Protections>
        You can get back in with:{' '}
        {[hasPasskey && 'your passkey', hasCode && 'your recovery code']
          .filter(Boolean)
          .join(' or ') || 'your recovery password'}
        .
      </Protections>

      {secret ? (
        <Column gap='0.5rem'>
          <p>
            This <strong>is</strong> your account — anyone holding it is you, on
            any device, forever. It can&apos;t be changed or revoked, and
            it&apos;s the only thing that still works if {PRODUCT_NAME}{' '}
            disappears. Store it like a passport, not a password.
          </p>
          <SecretCodeBlock className='revealed-agent-secret' content={secret} />
          <Row>
            <Button subtle onClick={() => setSecret(null)}>
              Hide
            </Button>
          </Row>
        </Column>
      ) : (
        <Column gap='0.5rem'>
          {needsCode ? (
            <InputWrapper hasPrefix>
              <FaKey />
              <InputStyled
                value={codeInput}
                onChange={e => setCodeInput(e.target.value)}
                type='password'
                placeholder='Recovery code'
                aria-label='Recovery code'
              />
            </InputWrapper>
          ) : null}
          <Row gap='1rem' wrapItems>
            <Button
              subtle
              onClick={handleReveal}
              disabled={loading}
              data-test='reveal-secret'
            >
              {loading ? 'Unlocking…' : 'Show my agent secret'}
            </Button>
            {hasPasskey && !hasCode && hasSession !== false ? (
              <Button
                subtle
                onClick={handleAddCode}
                disabled={loading}
                data-test='add-recovery-code'
              >
                Add a recovery code
              </Button>
            ) : null}
            {hasPasskey && !hasCode && hasSession === false && portalUrl ? (
              <Button
                subtle
                data-test='signin-to-add-code'
                onClick={() => window.open(`${portalUrl}/dashboard`, '_blank')}
              >
                Sign in to add a recovery code
              </Button>
            ) : null}
          </Row>
          {hasPasskey && !hasCode ? (
            <Hint>
              A recovery code is a spare key for when your passkey isn&apos;t
              available. You&apos;ll need your email to use it, so it&apos;s
              safe to keep on paper.
              {hasSession === false
                ? ` Creating one changes your stored backup, so it needs you signed in to ${PRODUCT_NAME} — your passkey alone can read the backup, but not change it.`
                : ''}
            </Hint>
          ) : null}
        </Column>
      )}

      {newCode ? (
        <Column gap='0.5rem'>
          <p>
            <strong>Save this recovery code.</strong> It gets you back in if you
            lose your passkey — you&apos;ll need your email too. We can&apos;t
            show it again, but you can generate a new one here any time (which
            retires this one).
          </p>
          <CodeBlock
            className='recovery-code-block'
            wordWrap
            content={newCode}
          />
        </Column>
      ) : null}

      {error && <ErrorLook>{error}</ErrorLook>}
    </Column>
  );
}

const Protections = styled.p`
  margin: 0;
  color: ${p => p.theme.colors.textLight};
`;

const Hint = styled.p`
  margin: 0;
  font-size: 0.9rem;
  color: ${p => p.theme.colors.textLight};
`;

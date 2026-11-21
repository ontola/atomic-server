import { useEffect, useState } from 'react';
import { styled } from 'styled-components';
import { Button } from '@tomic/ui/components/Button';
import { Column, Row } from '@tomic/ui/components/Row';
import { RadioGroup, RadioInput } from '@tomic/ui/components/forms/RadioInput';
import {
  getLockPolicy,
  LOCK_POLICY_LABELS,
  setLockPolicy,
  type LockPolicy,
} from '../helpers/deviceLock';
import {
  envelopeWrapperKinds,
  getUnlockableRecoverySecret,
} from '../helpers/managed/recovery';

const POLICIES: LockPolicy[] = ['never', 'close', 'idle-15m', 'idle-1h'];

/**
 * Lock this account on this machine.
 *
 * Distinct from account recovery: recovery is getting back in from anywhere,
 * this is *not* being signed in by default on a computer you share. Without a
 * policy the stored keypair loads on every page load, so whoever opens the
 * browser is you.
 *
 * Safe at any setting, because the agent secret always opens it — a lock can
 * add friction but never lock anyone out.
 */
export function DeviceLockCard({
  agentSubject,
  onLockNow,
}: {
  agentSubject: string | undefined;
  onLockNow: () => void;
}) {
  const [policy, setPolicy] = useState<LockPolicy>(() =>
    getLockPolicy(agentSubject),
  );
  const [hasPasskey, setHasPasskey] = useState(false);

  useEffect(() => {
    setPolicy(getLockPolicy(agentSubject));

    let cancelled = false;

    void (async () => {
      const backup = await getUnlockableRecoverySecret(agentSubject).catch(
        () => null,
      );

      if (!cancelled) {
        setHasPasskey(!!backup && envelopeWrapperKinds(backup).hasPasskey);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [agentSubject]);

  function choose(next: LockPolicy) {
    if (!agentSubject) return;

    setLockPolicy(agentSubject, next);
    setPolicy(next);
  }

  return (
    <Column gap='0.75rem'>
      <Explanation>
        {policy === 'never'
          ? 'Anyone who opens this browser is signed in as you.'
          : `You’ll unlock with ${hasPasskey ? 'your passkey' : 'your agent secret'}.`}
      </Explanation>

      <RadioGroup role='radiogroup' aria-label='When to lock this device'>
        {POLICIES.map(option => (
          <RadioInput
            key={option}
            name='device-lock-policy'
            value={option}
            checked={policy === option}
            onChange={() => choose(option)}
            data-test={`lock-policy-${option}`}
          >
            {LOCK_POLICY_LABELS[option]}
          </RadioInput>
        ))}
      </RadioGroup>

      {policy !== 'never' ? (
        <Row gap='1rem' wrapItems>
          <Button subtle onClick={onLockNow} data-test='lock-now'>
            Lock now
          </Button>
        </Row>
      ) : null}
    </Column>
  );
}

const Explanation = styled.p`
  margin: 0;
  color: ${p => p.theme.colors.textLight};
`;

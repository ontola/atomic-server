import { useEffect, useState } from 'react';
import { styled } from 'styled-components';
import {
  ServiceBody,
  ServiceDescription,
  ServiceIcon,
  ServiceSection,
  ServiceTitle,
} from '@tomic/service-ui';
import { useAISettings } from '../AI/AISettingsContext';
import { Button } from '../Button';
import {
  canPurchaseHostedAICredits,
  getHostedAIStatus,
  HOSTED_AI_USAGE_EVENT,
  type HostedAIStatus,
} from '../../helpers/managed/ai';
import { managedFetch } from '../../helpers/managed/api';
import { openExternal } from '../../helpers/openExternal';

const credits = (micros: number) =>
  (micros / 1000).toLocaleString(undefined, { maximumFractionDigits: 3 });

/**
 * The account's AI credits, on the Sync page next to the other paid services.
 *
 * Its own service, not part of a plan: every account gets a monthly
 * allowance (a larger one with a paid subscription) and can buy more, with or
 * without a Cloud Server. Hidden when AI is switched off in this app, and
 * when the account server offers no included AI.
 */
export function AICreditsService({
  className,
}: {
  className?: string;
}): React.JSX.Element | null {
  const { enableAI } = useAISettings();
  const [status, setStatus] = useState<HostedAIStatus>();
  const [buying, setBuying] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!enableAI) return;
    let active = true;
    const load = () =>
      getHostedAIStatus().then(
        next => active && setStatus(next),
        () => undefined,
      );

    void load();
    // Refreshed after every AI answer, so the number keeps up while you work.
    window.addEventListener(HOSTED_AI_USAGE_EVENT, load);

    return () => {
      active = false;
      window.removeEventListener(HOSTED_AI_USAGE_EVENT, load);
    };
  }, [enableAI]);

  if (!enableAI || !status?.enabled) return null;

  const allowance = status.allowance_micros;
  const usedPct =
    allowance > 0
      ? Math.min(100, Math.round((status.used_micros / allowance) * 100))
      : 100;
  const purchased = status.purchased_remaining_micros ?? 0;
  const resets = new Date(status.resets_at * 1000).toLocaleDateString(
    undefined,
    { dateStyle: 'medium' },
  );

  async function buy() {
    setBuying(true);
    setError(undefined);

    try {
      const response = await managedFetch('/ai/checkout', { method: 'POST' });
      const body = (await response.json().catch(() => ({}))) as {
        url?: string;
        error?: string;
      };

      if (!response.ok || !body.url) {
        throw new Error(body.error ?? 'Could not open checkout.');
      }

      await openExternal(body.url);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Could not open checkout. Try again.',
      );
    } finally {
      setBuying(false);
    }
  }

  return (
    <ServiceSection className={className} data-testid='ai-credits-row'>
      <ServiceIcon kind='ai' active={usedPct < 100 || purchased > 0} />
      <ServiceBody>
        <ServiceTitle>AI credits</ServiceTitle>
        <ServiceDescription>
          {`${usedPct}% of this month’s ${credits(allowance)} credits used. Resets ${resets}.`}
        </ServiceDescription>
        <Meter
          role='meter'
          aria-label='AI credits used this month'
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={usedPct}
        >
          <Fill $full={usedPct >= 100} style={{ width: `${usedPct}%` }} />
        </Meter>
        {purchased > 0 && (
          <Note>{`${credits(purchased)} purchased credits left. These carry over.`}</Note>
        )}
        {error && <Note role='alert'>{error}</Note>}
        {canPurchaseHostedAICredits(status) && (
          <Actions>
            <Button onClick={() => void buy()} disabled={buying}>
              {buying ? 'Opening checkout…' : 'Buy more credits'}
            </Button>
          </Actions>
        )}
      </ServiceBody>
    </ServiceSection>
  );
}

const Meter = styled.div`
  height: 6px;
  margin-top: 0.5rem;
  border-radius: 3px;
  background: ${p => p.theme.colors.bg2};
  overflow: hidden;
`;

const Fill = styled.div<{ $full: boolean }>`
  height: 100%;
  border-radius: 3px;
  background: ${p => (p.$full ? p.theme.colors.alert : p.theme.colors.main)};
  transition: width 0.3s ease;
`;

const Note = styled.span`
  display: block;
  margin-top: 0.4rem;
  font-size: 0.85rem;
  color: ${p => p.theme.colors.textLight};
`;

const Actions = styled.div`
  margin-top: 0.6rem;
`;

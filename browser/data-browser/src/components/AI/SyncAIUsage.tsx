import { styled } from 'styled-components';
import { Button } from '../Button';
import { openExternal } from '../../helpers/openExternal';
import {
  canPurchaseHostedAICredits,
  type HostedAIStatus,
} from '../../helpers/managed/ai';
import { useAISettings } from './AISettingsContext';

/**
 * Share of the monthly AI allowance that is used, as a whole percent in 0-100.
 *
 * Only the monthly allowance counts: `used_micros` is measured against
 * `allowance_micros`, while purchased credits are a separate balance that
 * carries over (see `HostedAICredits`). Folding them into the denominator
 * would make the number fall when someone buys credits mid-month, and hide
 * that the included allowance is gone. Purchased credits are listed on their
 * own line instead. Undefined when there is no allowance to divide by.
 */
export function aiUsagePercent(status: HostedAIStatus): number | undefined {
  if (!(status.allowance_micros > 0)) return undefined;

  return Math.min(
    100,
    Math.max(
      0,
      Math.round((status.used_micros / status.allowance_micros) * 100),
    ),
  );
}

const credits = (micros: number) =>
  (micros / 1000).toLocaleString(undefined, { maximumFractionDigits: 3 });

/**
 * AI credit usage for the managed server card.
 *
 * Renders nothing unless AI is on for this person: the local switch is off, or
 * the account has no hosted AI (status missing or `enabled: false`), or there
 * is no portal, which is what a self-hosted server looks like.
 */
export function SyncAIUsage({ portalUrl }: { portalUrl?: string | null }) {
  const { enableAI, hostedAI } = useAISettings();

  if (!portalUrl || !enableAI || !hostedAI?.enabled) return null;

  const pct = aiUsagePercent(hostedAI);

  if (pct === undefined) return null;

  const purchased = hostedAI.purchased_remaining_micros ?? 0;
  const label = `${pct}% of AI credits used`;
  const dashboard = `${portalUrl}/dashboard`;

  return (
    <AIUsage data-testid='sync-ai-usage'>
      <AIUsageRow>
        <span>{label}</span>
        {canPurchaseHostedAICredits(hostedAI) && (
          <Button subtle onClick={() => void openExternal(dashboard)}>
            Order more credits
          </Button>
        )}
      </AIUsageRow>
      <Bar
        role='progressbar'
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label={label}
      >
        <Fill style={{ width: `${pct}%` }} $full={pct >= 90} />
      </Bar>
      {purchased > 0 && (
        <Meta>{`${credits(purchased)} purchased credits left · carries over`}</Meta>
      )}
    </AIUsage>
  );
}

const AIUsage = styled.div`
  margin-top: 0.9rem;
  font-size: 0.8rem;
`;

const AIUsageRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem;
  color: ${p => p.theme.colors.textLight};
`;

const Bar = styled.div`
  margin-top: 0.4rem;
  height: 6px;
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

const Meta = styled.div`
  margin-top: 0.3rem;
  color: ${p => p.theme.colors.textLight};
`;

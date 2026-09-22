import { Column } from '@components/Row';
import type { HostedAIStatus } from '@helpers/managed/ai';

const credits = (micros: number) =>
  (micros / 1000).toLocaleString(undefined, { maximumFractionDigits: 3 });

export function HostedAICredits({
  status,
  portalUrl,
}: {
  status: HostedAIStatus;
  portalUrl: string;
}) {
  const purchased = status.purchased_remaining_micros ?? 0;
  const monthly = Math.max(0, status.remaining_micros - purchased);

  const purchasedSummary =
    purchased > 0 ? (
      <span>{`${credits(purchased)} purchased credits · carries over`}</span>
    ) : null;

  return (
    <Column gap='0.35rem'>
      <strong>AI credits</strong>
      <span>{`${credits(monthly)} of ${credits(status.allowance_micros)} monthly credits left`}</span>
      <span>{`Account-wide · resets ${new Date(status.resets_at * 1000).toLocaleDateString(undefined, { dateStyle: 'medium' })}`}</span>
      {purchasedSummary}
      {status.purchases_enabled && (
        <a
          href={`${portalUrl}/dashboard`}
          target='_blank'
          rel='noopener noreferrer'
        >
          Get more credits
        </a>
      )}
    </Column>
  );
}

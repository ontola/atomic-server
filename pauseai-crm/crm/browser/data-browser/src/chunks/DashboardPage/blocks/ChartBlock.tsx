import { useMemo, type JSX } from 'react';
import { styled } from 'styled-components';
import { useProperty } from '@tomic/react';
import {
  formatAggregateValue,
  formatGroupKey,
} from '../../TablePage/tableAggregates';
import { parseBlockAggregate, parseBlockChartSpec } from '../dashboardBlocks';
import { useBlockQuery } from '../useBlockQuery';
import { toBlockAggregation, useBlockAggregate } from '../useBlockAggregate';
import { BlockShell } from './BlockShell';
import type { BlockProps } from './BlockProps';
import { ResourceInline } from '../../../views/ResourceInline';

/**
 * A number per bucket, drawn as horizontal bars.
 *
 * Horizontal on purpose: bucket labels are category names, dates and tag names,
 * and those read left-to-right at any width. A vertical bar chart would need
 * rotated labels to survive a narrow block.
 *
 * The drawing is ours — a grid and a filled div per bar, which is all a bar
 * chart is. The *spec* is Vega-Lite-shaped so an assistant can write one from
 * training it already has, and so a real Vega renderer stays a drop-in later:
 * the grammar is the contract, not the library.
 */
export function ChartBlock({ block, config }: BlockProps): JSX.Element {
  const spec = useMemo(
    () => parseBlockAggregate(config.aggregate),
    [config.aggregate],
  );
  const chart = useMemo(
    () => parseBlockChartSpec(config.chartSpec),
    [config.chartSpec],
  );

  const query = useBlockQuery(config.source, config.view, config.query);

  const aggregation = useMemo(
    () =>
      chart?.field
        ? toBlockAggregation(spec, query, {
            property: chart.field,
            granularity: chart.granularity ?? 'exact',
          })
        : undefined,
    [spec, query, chart],
  );

  const outcome = useBlockAggregate(query, aggregation);
  // A Property, not a plain Resource: the formatter needs its datatype to know
  // whether a min/max is an instant to render as a date.
  const property = useProperty(spec?.property ?? '');
  const derived = spec?.derived
    ? query.derivedColumns.find(c => c.id === spec.derived)
    : undefined;

  const groups = outcome?.groups ?? [];
  // Bars are scaled against the largest value, not against zero-to-max of the
  // axis: a chart of one bucket should still show a full bar.
  const max = groups.reduce((m, g) => Math.max(m, Math.abs(g.value ?? 0)), 0);

  if (!spec || !chart?.field) {
    return (
      <BlockShell block={block} label={config.label}>
        <Empty>Pick a number and something to group it by</Empty>
      </BlockShell>
    );
  }

  return (
    <BlockShell block={block} label={config.label}>
      {groups.length === 0 ? (
        <Empty>No data yet</Empty>
      ) : (
        <Bars>
          {groups.map(group => (
            <Bar key={group.key}>
              <Label title={group.key}>
                <BucketLabel
                  bucketKey={group.key}
                  granularity={chart.granularity ?? 'exact'}
                />
              </Label>
              <Track>
                <Fill
                  style={{
                    width: `${max > 0 ? (Math.abs(group.value ?? 0) / max) * 100 : 0}%`,
                  }}
                />
              </Track>
              <Amount>
                {formatAggregateValue(
                  group.value,
                  spec.function,
                  spec.property ? property : undefined,
                  derived,
                )}
              </Amount>
            </Bar>
          ))}
        </Bars>
      )}
      {outcome?.groups_truncated ? (
        <Note>Showing the largest {groups.length} groups</Note>
      ) : null}
    </BlockShell>
  );
}

/**
 * A bucket key is a date, a literal value, or a Tag subject — a select property
 * groups by tag subject, so those have to resolve to the tag's name rather than
 * render as a DID.
 */
function BucketLabel({
  bucketKey,
  granularity,
}: {
  bucketKey: string;
  granularity: 'exact' | 'day' | 'month';
}): JSX.Element {
  const looksLikeSubject =
    bucketKey.startsWith('http') || bucketKey.startsWith('did:');

  if (looksLikeSubject) {
    return <ResourceInline subject={bucketKey} />;
  }

  return <>{formatGroupKey(bucketKey, granularity)}</>;
}

const Bars = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${p => p.theme.size(1)};
  overflow-y: auto;
  min-height: 0;
`;

const Bar = styled.div`
  display: grid;
  grid-template-columns: minmax(4rem, 8rem) 1fr auto;
  align-items: center;
  gap: ${p => p.theme.size(1)};
  font-size: 0.8rem;
`;

const Label = styled.span`
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: ${p => p.theme.colors.textLight};
`;

const Track = styled.span`
  background-color: ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
  height: 0.75rem;
  min-width: 0;
`;

const Fill = styled.span`
  display: block;
  height: 100%;
  min-width: 2px;
  background-color: ${p => p.theme.colors.main};
  border-radius: ${p => p.theme.radius};
`;

const Amount = styled.span`
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
`;

const Empty = styled.span`
  color: ${p => p.theme.colors.textLight};
  font-style: italic;
`;

const Note = styled.span`
  color: ${p => p.theme.colors.textLight};
  font-size: 0.75rem;
`;

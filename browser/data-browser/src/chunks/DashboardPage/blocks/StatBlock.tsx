import { core, useProperty, useResource, useString } from '@tomic/react';
import { styled } from 'styled-components';
import { useMemo, type JSX } from 'react';
import {
  AGGREGATE_FUNCTION_LABELS,
  formatAggregateValue,
} from '../../TablePage/tableAggregates';
import { parseBlockAggregate } from '../dashboardBlocks';
import { useBlockQuery } from '../useBlockQuery';
import { toBlockAggregation, useBlockAggregate } from '../useBlockAggregate';
import { BlockShell } from './BlockShell';
import type { BlockProps } from './BlockProps';

/**
 * One number over the rows a view matches — "12 open", "€ 430 this month",
 * "5:30:00 logged".
 *
 * The number comes from the store's aggregation pass over every matching row,
 * not from adding up a page here, so it is exact and it is the same code the
 * table's totals footer runs.
 */
export function StatBlock({ block, config }: BlockProps): JSX.Element {
  const spec = useMemo(
    () => parseBlockAggregate(config.aggregate),
    [config.aggregate],
  );

  const query = useBlockQuery(config.source, config.view, config.query);
  const aggregation = useMemo(
    () => toBlockAggregation(spec, query),
    [spec, query],
  );
  const outcome = useBlockAggregate(query, aggregation);

  // A Property, not a plain Resource: the formatter needs its datatype to know
  // whether a min/max is an instant to render as a date.
  const property = useProperty(spec?.property ?? '');
  const derived = spec?.derived
    ? query.derivedColumns.find(c => c.id === spec.derived)
    : undefined;

  const value = outcome?.value;

  return (
    <BlockShell block={block} label={config.label} center>
      {spec ? (
        <>
          <Value>
            {formatAggregateValue(
              value,
              spec.function,
              spec.property ? property : undefined,
              derived,
            )}
          </Value>
          <Caption>
            {config.label ? (
              <StatDescription spec={spec} derived={derived?.label} />
            ) : null}
          </Caption>
        </>
      ) : (
        <Unconfigured>Pick something to measure</Unconfigured>
      )}
    </BlockShell>
  );
}

/** "Sum of Amount" — what the number is, under the number itself. */
function StatDescription({
  spec,
  derived,
}: {
  spec: NonNullable<ReturnType<typeof parseBlockAggregate>>;
  derived: string | undefined;
}): JSX.Element {
  const property = useResource(spec.property ?? '');
  const [shortname] = useString(property, core.properties.shortname);
  const fn = AGGREGATE_FUNCTION_LABELS[spec.function];
  const target = derived ?? shortname;

  return <>{spec.function === 'count' || !target ? fn : `${fn} ${target}`}</>;
}

const Value = styled.span`
  font-size: clamp(1.6rem, 4cqw, 2.4rem);
  font-weight: bold;
  line-height: 1.1;
  overflow-wrap: anywhere;
`;

const Caption = styled.span`
  color: ${p => p.theme.colors.textLight};
  font-size: 0.8rem;
`;

const Unconfigured = styled.span`
  color: ${p => p.theme.colors.textLight};
  font-style: italic;
`;

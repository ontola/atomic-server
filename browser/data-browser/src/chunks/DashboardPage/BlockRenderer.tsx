import {
  core,
  dataBrowser,
  useResource,
  useString,
  useValue,
} from '@tomic/react';
import { useMemo, type JSX } from 'react';
import { styled } from 'styled-components';
import { isBlockKind, type BlockKind } from './dashboardBlocks';
import { StatBlock } from './blocks/StatBlock';
import { ChartBlock } from './blocks/ChartBlock';
import { ViewBlock } from './blocks/ViewBlock';
import { TextBlock } from './blocks/TextBlock';
import { BlockShell } from './blocks/BlockShell';
import type { BlockConfig } from './blocks/BlockProps';

/**
 * Reads one Block's configuration and hands it to the renderer for its kind.
 *
 * Reading happens here rather than in each renderer so every kind sees the same
 * shape, and so an unknown kind can be reported with the block's name instead of
 * rendering nothing.
 */
export function BlockRenderer({ subject }: { subject: string }): JSX.Element {
  const block = useResource(subject);

  const [kind] = useString(block, dataBrowser.properties.blockKind);
  const [label] = useString(block, core.properties.name);
  const [source] = useString(block, dataBrowser.properties.blockSource);
  const [view] = useString(block, dataBrowser.properties.blockView);
  const [text] = useString(block, core.properties.description);
  const [query] = useValue(block, dataBrowser.properties.blockQuery);
  const [aggregate] = useValue(block, dataBrowser.properties.blockAggregate);
  const [chartSpec] = useValue(block, dataBrowser.properties.blockChartSpec);

  // Serialized deps: `useValue` hands back freshly parsed JSON, and these reach
  // a query's identity through the block's aggregation.
  const queryKey = JSON.stringify(query ?? null);
  const aggregateKey = JSON.stringify(aggregate ?? null);
  const chartSpecKey = JSON.stringify(chartSpec ?? null);

  const config: BlockConfig = useMemo(
    () => ({
      kind: (isBlockKind(kind) ? kind : 'text') as BlockKind,
      label: label ?? '',
      source,
      view,
      text,
      query: JSON.parse(queryKey),
      aggregate: JSON.parse(aggregateKey),
      chartSpec: JSON.parse(chartSpecKey),
    }),
    [kind, label, source, view, text, queryKey, aggregateKey, chartSpecKey],
  );

  if (kind !== undefined && !isBlockKind(kind)) {
    // A dashboard written by a newer version of the app, or by an assistant that
    // invented a kind. Say so and keep the rest of the page working.
    return (
      <BlockShell block={block} label={config.label}>
        <Unknown>
          This block is a “{kind}”, which this version can’t show.
        </Unknown>
      </BlockShell>
    );
  }

  switch (config.kind) {
    case 'stat':
      return <StatBlock block={block} config={config} />;
    case 'chart':
      return <ChartBlock block={block} config={config} />;
    case 'view':
      return <ViewBlock block={block} config={config} />;
    default:
      return <TextBlock block={block} config={config} />;
  }
}

const Unknown = styled.span`
  color: ${p => p.theme.colors.textLight};
  font-style: italic;
`;

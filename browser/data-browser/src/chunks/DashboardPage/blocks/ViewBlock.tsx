import { useResource, type DataBrowser, type Resource } from '@tomic/react';
import { styled } from 'styled-components';
import type { JSX } from 'react';
import { TableResource } from '../../TablePage/TableResource';
import { BlockShell } from './BlockShell';
import type { BlockProps } from './BlockProps';
import { AtomicLink } from '../../../components/AtomicLink';

/**
 * An embedded table, board or calendar — the real one, not a preview: cells stay
 * editable, columns sortable, rows addable. That is the whole point of modelling
 * a block over a View rather than over a snapshot of data.
 *
 * It renders without the table page's own chrome (the view tabs, the filter
 * bar): which view a block shows is its configuration, and the tab bar would
 * rewrite the dashboard's own `?view=` param.
 */
export function ViewBlock({ block, config }: BlockProps): JSX.Element {
  const table = useResource<DataBrowser.Table>(config.source ?? '');

  if (!config.source) {
    return (
      <BlockShell block={block} label={config.label}>
        <Empty>Pick a table to show</Empty>
      </BlockShell>
    );
  }

  return (
    <BlockShell
      block={block}
      label={config.label}
      fill
      actions={
        <AtomicLink subject={config.source}>
          <OpenLabel>Open</OpenLabel>
        </AtomicLink>
      }
    >
      <Frame>
        <TableResource
          resource={table as Resource<DataBrowser.Table>}
          viewSubject={config.view}
          embedded
        />
      </Frame>
    </BlockShell>
  );
}

/**
 * The grid inside sizes itself to its container and scrolls internally, so the
 * block gives it a bounded box rather than letting it grow the whole page.
 */
const Frame = styled.div`
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  overflow: hidden;
`;

const OpenLabel = styled.span`
  font-size: 0.8rem;
`;

const Empty = styled.span`
  color: ${p => p.theme.colors.textLight};
  font-style: italic;
`;

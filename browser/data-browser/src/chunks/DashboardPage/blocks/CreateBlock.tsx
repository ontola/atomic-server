import {
  core,
  useResource,
  useString,
  type DataBrowser,
  type Resource,
} from '@tomic/react';
import { useMemo, type JSX } from 'react';
import { styled } from 'styled-components';
import { QuickAddBar } from '../../TablePage/QuickAddBar';
import { parseQuickAdd } from '../../TablePage/quickAdd';
import { useClassProperties } from '../useClassProperties';
import { BlockShell } from './BlockShell';
import type { BlockProps } from './BlockProps';

/**
 * The button a dashboard exists to be pressed: "Log a feed", "Add expense",
 * "Start".
 *
 * The same configuration a table's quick-add bar holds, given somewhere
 * prominent to live — a dashboard's whole point is that the thing you do twenty
 * times a day is the biggest thing on the page, rather than a bar above a grid
 * you had to navigate to first.
 */
export function CreateBlock({ block, config }: BlockProps): JSX.Element {
  const table = useResource<DataBrowser.Table>(config.source ?? '');
  // A subscribing read: `table.props.classtype` during render is memoized by the
  // React Compiler on the resource proxy's identity, which never changes.
  const [classSubject] = useString(table, core.properties.classtype);
  // The ROW class, not the table. A row created with `isA: <table>` is not an
  // instance of anything the table lists, so it silently never appears.
  const rowClass = useResource(classSubject ?? '');
  const classProperties = useClassProperties(classSubject);

  const spec = useMemo(() => parseQuickAdd(config.quickAdd), [config.quickAdd]);

  if (!config.source) {
    return (
      <BlockShell block={block} label={config.label} center>
        <Empty>Pick a table to add to</Empty>
      </BlockShell>
    );
  }

  if (!classSubject) {
    return (
      <BlockShell block={block} label={config.label} center>
        <Empty>That table has no row class yet</Empty>
      </BlockShell>
    );
  }

  if (!spec) {
    return (
      <BlockShell block={block} label={config.label} center>
        <Empty>Say what the button does</Empty>
      </BlockShell>
    );
  }

  return (
    <BlockShell block={block} label={config.label} center>
      <QuickAddBar
        spec={spec}
        tableSubject={config.source}
        tableClass={rowClass as Resource}
        classProperties={classProperties}
        // Nothing here holds a frozen member count the way the grid does, so
        // there is nothing to bump: saving the row already fires
        // `ResourceSaved`, which is what the numbers and charts beside it
        // re-read on.
        onRowCreated={() => undefined}
      />
    </BlockShell>
  );
}

const Empty = styled.span`
  color: ${p => p.theme.colors.textLight};
  font-style: italic;
`;

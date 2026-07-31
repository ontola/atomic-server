import type { JSONValue, Resource } from '@tomic/react';
import type { BlockKind } from '../dashboardBlocks';

/**
 * A block's configuration, read once by the dashboard and handed to every
 * renderer in the same shape — so a renderer never reads the resource itself
 * and every kind sees the same fields.
 */
export interface BlockConfig {
  kind: BlockKind;
  /** The block's name, shown as its heading. */
  label: string;
  /** The Table whose rows it describes. */
  source: string | undefined;
  /** The View whose filters and computed columns it borrows. */
  view: string | undefined;
  /** Extra constraints, in `view-filters` shape. */
  query: JSONValue | undefined;
  aggregate: JSONValue | undefined;
  chartSpec: JSONValue | undefined;
  /** A text block's body. */
  text: string | undefined;
}

export interface BlockProps {
  block: Resource;
  config: BlockConfig;
}

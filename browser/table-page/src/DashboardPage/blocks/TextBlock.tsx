import { resourceTheme } from '@tomic/resource-ui/theme';
import type { JSX } from 'react';
import { styled } from 'styled-components';
import Markdown from '@tomic/resource-ui/components/datatypes/Markdown';
import { BlockShell } from './BlockShell.js';
import type { BlockProps } from './BlockProps.js';

/**
 * A heading or a note. Its body is the block's `description`, so a text block
 * needs no property of its own — and reads as documentation wherever else a
 * Block gets embedded later.
 */
export function TextBlock({ block, config }: BlockProps): JSX.Element {
  return (
    <BlockShell block={block} label={config.label}>
      {config.text ? (
        <Markdown text={config.text} />
      ) : (
        <Empty>Nothing written here yet</Empty>
      )}
    </BlockShell>
  );
}

const Empty = styled.span`
  color: ${p => resourceTheme(p.theme).colors.textLight};
  font-style: italic;
`;

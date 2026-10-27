import { describe, expect, it } from 'vitest';
import { textToBlocks } from './instantiate';

describe('textToBlocks', () => {
  it('builds headings, one bullet list, bold and resource links', () => {
    const blocks = textToBlocks(
      '# Try\n- Open {{a}}\n- **Bold** {{missing}}\nPlain',
      { a: 'did:ad:x' },
    );

    expect(blocks.map(b => b.type)).toEqual([
      'heading',
      'bulletList',
      'paragraph',
    ]);
    expect(blocks[1].content).toHaveLength(2);
    expect(JSON.stringify(blocks[1])).toContain(
      '{"type":"atomic-data-resource-inline","attrs":{"subject":"did:ad:x"}}',
    );
    expect(JSON.stringify(blocks[1])).toContain('"marks":[{"type":"bold"}]');
    expect(JSON.stringify(blocks[1])).toContain('{{missing}}');
  });
});

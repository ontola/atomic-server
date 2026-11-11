import { describe, expect, it } from 'vitest';
import { TEMPLATE_CATALOG } from './catalog';
import { planTemplate } from './model';
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

  it('builds task lists from `- [ ]` and `- [x]` lines, apart from bullets', () => {
    const blocks = textToBlocks(
      '- [ ] Open {{a}}\n- [x] Done\n- Plain bullet\n- [ ] Again',
      { a: 'did:ad:x' },
    );

    expect(blocks.map(b => b.type)).toEqual([
      'taskList',
      'bulletList',
      'taskList',
    ]);
    const items = blocks[0].content as Array<Record<string, unknown>>;
    expect(items.map(i => [i.type, (i.attrs as object) ?? null])).toEqual([
      ['taskItem', { checked: false }],
      ['taskItem', { checked: true }],
    ]);
    expect(JSON.stringify(blocks[0])).toContain('"subject":"did:ad:x"');
    expect(JSON.stringify(blocks[0])).not.toContain('[ ]');
  });

  it('gives every starter and the welcome document a task list', () => {
    for (const id of ['student', 'team', 'personal', 'welcome']) {
      const plan = planTemplate(
        TEMPLATE_CATALOG.find(t => t.id === id)!,
        TEMPLATE_CATALOG,
      );
      const texts = plan.parts.flatMap(p =>
        p.kind === 'document' ? [p.text] : [],
      );

      expect(
        texts.some(t => t.includes('- [ ] ')),
        id,
      ).toBe(true);
    }
  });
});

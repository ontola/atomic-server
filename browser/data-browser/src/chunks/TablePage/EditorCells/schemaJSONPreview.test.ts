import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { schemaJSONPreview } from './schemaJSONPreview';

// Synthetic schema and records. No provider or personal data fixtures.
const textSchema = {
  type: 'object',
  properties: { content: { type: 'string' } },
};
const schema = {
  type: 'object',
  properties: {
    prose: { $ref: '#/$defs/Prose' },
    list: {
      type: 'object',
      properties: {
        entries: { type: 'array', items: { $ref: '#/$defs/Entry' } },
      },
    },
  },
  $defs: {
    Prose: textSchema,
    Entry: {
      type: 'object',
      properties: {
        selected: { type: 'boolean', title: 'Selected' },
        label: { $ref: '#/$defs/Prose' },
        children: { type: 'array', items: { $ref: '#/$defs/Entry' } },
      },
    },
  },
};

describe('schemaJSONPreview', () => {
  it('unwraps a prose body and preserves its line breaks', () => {
    expect(
      schemaJSONPreview(
        { prose: { content: 'First line\nNext line' } },
        schema,
      ),
    ).toEqual({
      text: 'First line\nNext line',
      readable: true,
      truncated: false,
    });
  });

  it('renders list order, explicit boolean states and nested items', () => {
    const result = schemaJSONPreview(
      {
        list: {
          entries: [
            { selected: true, label: { content: 'First item' } },
            {
              selected: false,
              label: { content: 'Second item' },
              children: [{ label: { content: 'Nested item' } }],
            },
          ],
        },
      },
      schema,
    );

    expect(result).toEqual({
      text: '• Selected: ☑\n  label: First item\n• Selected: ☐\n  label: Second item\n  children: • Nested item',
      readable: true,
      truncated: false,
    });
  });

  it('does not invent a checkbox state when a boolean is absent or null', () => {
    expect(
      schemaJSONPreview(
        { label: { content: 'Plain item' } },
        {
          ...schema.$defs.Entry,
          $defs: schema.$defs,
        },
      ).text,
    ).toBe('Plain item');
    expect(
      schemaJSONPreview(
        { selected: null, content: 'Unknown state' },
        {
          type: 'object',
          properties: {
            selected: { type: ['boolean', 'null'] },
            content: { type: 'string' },
          },
        },
      ).text,
    ).toBe('selected: null\ncontent: Unknown state');
  });

  it('resolves escaped JSON pointers and OpenAPI-style local definitions', () => {
    expect(
      schemaJSONPreview(
        { content: 'Readable' },
        {
          $ref: '#/components/schemas/a~1b~0c',
          components: { schemas: { 'a/b~c': textSchema } },
        },
      ).text,
    ).toBe('Readable');
  });

  it('retains empty containers and explicit null values', () => {
    expect(schemaJSONPreview(null, { type: 'null' }).text).toBe('null');
    expect(schemaJSONPreview({}, { type: 'object', properties: {} }).text).toBe(
      '{}',
    );
    expect(
      schemaJSONPreview([], { type: 'array', items: { type: 'string' } }).text,
    ).toBe('[]');
  });

  it('handles schema numeric types and OpenAPI nullable values', () => {
    expect(schemaJSONPreview(42, { type: 'integer' })).toEqual({
      text: '42',
      readable: true,
      truncated: false,
    });
    expect(schemaJSONPreview(null, { type: 'string', nullable: true })).toEqual(
      {
        text: 'null',
        readable: true,
        truncated: false,
      },
    );
  });

  it('falls back to complete raw JSON for unsupported or missing schemas', () => {
    const value = { content: 'Keep me', other: 42 };

    for (const unsupportedSchema of [
      undefined,
      true,
      { oneOf: [textSchema] },
      { $ref: 'https://example.invalid/schema' },
      { $ref: '#/missing' },
      textSchema, // The unknown field must not disappear behind a text wrapper.
      { type: 'array', items: { type: 'string' } },
    ]) {
      const result = schemaJSONPreview(value, unsupportedSchema);
      expect(result.readable).toBe(false);
      expect(result.truncated).toBe(false);
      expect(JSON.parse(result.text)).toEqual(value);
    }
  });

  it('preserves source property order and schema titles', () => {
    expect(
      schemaJSONPreview(
        { second: 'B', first: 'A' },
        {
          type: 'object',
          properties: {
            first: { type: 'string' },
            second: { type: 'string', title: 'Second field' },
          },
        },
      ).text,
    ).toBe('Second field: B\nfirst: A');
  });

  it('still unwraps long prose when its nested value exhausts the budget', () => {
    const result = schemaJSONPreview(
      { prose: { content: `Original opening. ${'x'.repeat(10_000)}` } },
      schema,
    );

    expect(result.readable).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.text).toMatch(/^Original opening\. x/);
    expect(result.text).not.toContain('prose:');
    expect(result.text).not.toContain('content:');
    expect(result.text).toMatch(/…$/);
    expect(result.text.length).toBeLessThanOrEqual(4000);
  });

  it('keeps a multi-field object label when its first long value exhausts the budget', () => {
    const result = schemaJSONPreview(
      {
        first: `Original opening. ${'x'.repeat(10_000)}`,
        second: 'Another field',
      },
      {
        type: 'object',
        properties: {
          first: { type: 'string', title: 'First field' },
          second: { type: 'string' },
        },
      },
    );

    expect(result.readable).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.text).toMatch(/^First field: Original opening\. x/);
    expect(result.text).toMatch(/…$/);
    expect(result.text.length).toBeLessThanOrEqual(4000);
  });

  it('bounds long text, wide arrays and recursive values with an explicit flag', () => {
    const recursiveSchema = {
      type: 'object',
      properties: { child: { $ref: '#' } },
    };
    let nested: unknown = 'Leaf';
    for (let i = 0; i < 100; i++) nested = { child: nested };

    for (const [value, definition] of [
      ['x'.repeat(100_000), { type: 'string' }],
      [
        Array.from({ length: 10_000 }, () => 'x'),
        { type: 'array', items: { type: 'string' } },
      ],
      [nested, recursiveSchema],
      ['x'.repeat(100_000), undefined],
      [nested, undefined],
    ]) {
      const result = schemaJSONPreview(value, definition);
      expect(result.truncated).toBe(true);
      expect(result.text.length).toBeLessThanOrEqual(4000);
      expect(result.text).toContain('…');
    }
  });

  it('terminates cyclic schema references using raw JSON fallback', () => {
    const cyclic = {
      $ref: '#/$defs/self',
      $defs: { self: { $ref: '#/$defs/self' } },
    };
    expect(schemaJSONPreview({ content: 'Safe' }, cyclic).readable).toBe(false);
  });

  it('keeps HTML in values and schema labels as plain React text', () => {
    const result = schemaJSONPreview(
      { content: '<img src=x onerror=alert(1)>', other: 'ok' },
      {
        type: 'object',
        properties: {
          content: { type: 'string', title: '<script>alert(2)</script>' },
          other: { type: 'string' },
        },
      },
    );
    const html = renderToStaticMarkup(createElement('div', null, result.text));

    expect(html).toContain('&lt;img');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
  });
});

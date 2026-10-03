import { describe, expect, it } from 'vitest';
import { pluginConfigFor, pluginConfigProblems } from './plugin-config.js';
import { validateManifest } from './plugin-manifest.js';
import { invokeRun } from './plugin-sandbox.js';
import type { DeclaredConfig } from './plugin-manifest.js';

const declared: DeclaredConfig = {
  key: 'pets',
  properties: {
    table: { type: 'string', description: 'Table the pets are written to' },
    rowClass: { type: 'string' },
    properties: { type: 'object' },
  },
  required: ['table', 'rowClass', 'properties'],
};

const complete = {
  table: 'https://test/table',
  rowClass: 'https://test/pet',
  properties: { 'pet-age': 'https://test/age' },
};

describe('pluginConfigFor', () => {
  it('reads the config out of the key the plugin declared', () => {
    expect(pluginConfigFor({ schemas: { pets: complete } }, declared)).toEqual(
      complete,
    );
  });

  it('parses config that was stored as a JSON string', () => {
    expect(
      pluginConfigFor(
        { schemas: JSON.stringify({ pets: complete }) },
        declared,
      ),
    ).toEqual(complete);
  });

  it('reads a flat config when the plugin declares no key', () => {
    expect(pluginConfigFor({ schemas: complete }, { properties: {} })).toEqual(
      complete,
    );
  });

  it('falls back to the config a connection carries', () => {
    expect(
      pluginConfigFor(
        { schemas: {}, connection: { release: 'r', config: complete } },
        declared,
      ),
    ).toEqual(complete);
  });

  it('is an object even when the installation stored nothing usable', () => {
    for (const schemas of [undefined, null, '', 'not json', 7, ['a']])
      expect(pluginConfigFor({ schemas }, declared)).toEqual({});
  });
});

describe('pluginConfigProblems', () => {
  it('names every missing required field instead of letting run() throw', () => {
    const problems = pluginConfigProblems({}, declared);
    expect(problems).toHaveLength(3);
    expect(problems.every(p => p.severity === 'error')).toBe(true);
    expect(problems[0].message).toContain('`table`');
    expect(problems[0].message).toContain('Table the pets are written to');
    expect(problems.map(p => p.message).join(' ')).not.toContain('TypeError');
  });

  it('treats an empty value as a missing one', () => {
    expect(
      pluginConfigProblems(
        { table: '  ', rowClass: 'https://test/pet', properties: {} },
        declared,
      ).map(p => p.message.match(/`(\w+)`/)?.[1]),
    ).toEqual(['table', 'properties']);
  });

  it('reports a field of the wrong shape', () => {
    expect(
      pluginConfigProblems({ ...complete, properties: 'nope' }, declared)[0]
        .message,
    ).toContain('must be an object');
  });

  it('passes a complete config, and checks nothing a plugin did not declare', () => {
    expect(pluginConfigProblems(complete, declared)).toEqual([]);
    expect(pluginConfigProblems({}, undefined)).toEqual([]);
  });
});

describe('a plugin whose config never arrived', () => {
  // The crash this replaces: `const { table } = ctx.config` on an import with
  // no stored config, reported as "run() threw: TypeError: Cannot destructure
  // property 'table' of 'ctx.config' as it is undefined".
  const source = {
    run: (input: { config?: { table?: string } }) => {
      const { table } = input.config ?? {};

      if (!table) throw new Error('Configure the connection before running it');

      return { intents: [], problems: [] };
    },
  };

  it('is stopped by validation before the sandbox is even started', () => {
    const manifest = validateManifest({
      schemaVersion: 1,
      config: {
        properties: { table: { type: 'string' } },
        required: ['table'],
      },
    });
    const config = pluginConfigFor({ schemas: undefined }, manifest.config);
    const problems = pluginConfigProblems(config, manifest.config);

    expect(config).toEqual({});
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toContain('`table`');
  });

  it('still fails readably if it is run anyway', async () => {
    const result = await invokeRun(source, {
      trigger: { kind: 'manual', at: 1 },
    });

    expect(result.problem?.message).toBe(
      'run() threw: Error: Configure the connection before running it',
    );
    expect(result.problem?.message).not.toContain('TypeError');
  });

  it('runs unchanged once its config is there', async () => {
    const result = await invokeRun(source, {
      trigger: { kind: 'manual', at: 1 },
      config: { table: 'https://test/table' },
    });

    expect(result.problem).toBeUndefined();
    expect(result.json).toBe('{"intents":[],"problems":[]}');
  });
});

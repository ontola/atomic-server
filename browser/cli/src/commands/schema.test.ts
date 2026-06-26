import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '@tomic/lib';

const originalCwd = process.cwd();

describe('schema command', () => {
  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
  });

  it('registers a code schema and generates ontology bindings from the same Store', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const dir = await mkdtemp(path.join(tmpdir(), 'atomic-schema-cli-'));
    const keys = await Agent.generateKeyPair();
    const agentSecret = Agent.buildSecret(
      keys.privateKey,
      `did:ad:agent:${keys.publicKey}`,
    );

    await writeFile(
      path.join(dir, 'atomic.config.json'),
      JSON.stringify(
        {
          outputFolder: './src/ontologies',
          ontologies: [],
          agentSecret,
          _ISLIB_: false,
        },
        null,
        2,
      ),
    );
    await writeFile(
      path.join(dir, 'todo-schema.mjs'),
      `export default {
        name: 'TodoApp',
        version: '1.0.0',
        classes: {
          todo: {
            type: 'object',
            required: ['title'],
            properties: {
              title: { type: 'string', description: 'Task title' },
              done: { type: 'boolean' }
            }
          }
        }
      };`,
    );

    process.chdir(dir);

    const { schemaCommand } = await import('./schema.js');
    await schemaCommand(['./todo-schema.mjs', '--local', '--generate', '--lock']);

    const generated = await readFile(
      path.join(dir, 'src/ontologies/todoApp.ts'),
      'utf8',
    );
    const index = await readFile(
      path.join(dir, 'src/ontologies/index.ts'),
      'utf8',
    );

    expect(generated).toContain('export const todoapp');
    expect(generated).toContain('classes:');
    expect(generated).toContain('properties:');
    expect(generated).toContain('interface PropTypeMapping');
    expect(generated).toContain('did:ad:');
    expect(index).toContain("from './todoapp.js'");

    // The committed, self-verifying lockfile is written and verifies.
    const { verifySchemaLock } = await import('@tomic/lib');
    const lock = JSON.parse(
      await readFile(path.join(dir, 'src/ontologies/TodoApp.schema.lock.json'), 'utf8'),
    );
    expect(verifySchemaLock(lock)).toEqual({ ok: true, errors: [] });
    expect(lock.ontology).toMatch(/^did:ad:frozen:[0-9a-f]{64}$/);
  });
});

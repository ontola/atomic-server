import { describe, it } from 'vitest';

import { buildSchemaLock, verifySchemaLock } from './schema-lock.js';
import { type AtomicSchemaPackage } from './schema.js';

const todoSchema: AtomicSchemaPackage = {
  name: 'TodoApp',
  version: '1.0.0',
  classes: {
    todo: {
      title: 'Todo',
      description: 'A task',
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string', description: 'Task title' },
        done: { type: 'boolean' },
      },
    },
  },
};

describe('buildSchemaLock', () => {
  it('produces a self-verifying lockfile', ({ expect }) => {
    const lock = buildSchemaLock(todoSchema);

    expect(verifySchemaLock(lock)).toEqual({ ok: true, errors: [] });
  });

  it('decodes every frozen id in @index', ({ expect }) => {
    const lock = buildSchemaLock(todoSchema);

    for (const id of Object.keys(lock.frozen)) {
      expect(lock['@index'][id]).toBeDefined();
    }

    expect(lock['@index'][lock.ontology]).toBe('TodoApp');
    expect(
      lock['@index'][lock.presentation.properties['todo.title'].id],
    ).toBe('TodoApp.title');
  });

  it('keeps descriptions in presentation, not in the hashed objects', ({
    expect,
  }) => {
    const lock = buildSchemaLock(todoSchema);
    const titleId = lock.presentation.properties['todo.title'].id;

    expect(lock.presentation.properties['todo.title'].description).toBe(
      'Task title',
    );
    expect(
      JSON.stringify(lock.frozen[titleId]).includes('Task title'),
    ).toBe(false);
  });

  it('is deterministic across runs', ({ expect }) => {
    expect(JSON.stringify(buildSchemaLock(todoSchema))).toBe(
      JSON.stringify(buildSchemaLock(todoSchema)),
    );
  });

  it('keeps frozen ids stable when only a description changes', ({ expect }) => {
    const base = buildSchemaLock(todoSchema);
    const reworded = buildSchemaLock({
      ...todoSchema,
      classes: {
        todo: {
          ...todoSchema.classes.todo,
          properties: {
            ...todoSchema.classes.todo.properties,
            title: { type: 'string', description: 'Different' },
          },
        },
      },
    });

    expect(Object.keys(reworded.frozen).sort()).toEqual(
      Object.keys(base.frozen).sort(),
    );
  });
});

describe('verifySchemaLock', () => {
  it('fails when a frozen object is tampered with', ({ expect }) => {
    const lock = buildSchemaLock(todoSchema);
    const [firstId] = Object.keys(lock.frozen);
    const tampered = {
      ...lock,
      frozen: {
        ...lock.frozen,
        [firstId]: { ...(lock.frozen[firstId] as object), tampered: true },
      },
    };

    const result = verifySchemaLock(tampered as typeof lock);
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain(firstId);
  });
});

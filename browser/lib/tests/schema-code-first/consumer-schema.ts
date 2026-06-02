import { defineSchema, type SchemaHash } from '../../src/schema.js';

export function defineProjectSchema(
  todoOntologySubject: string,
  expectedHash: SchemaHash,
) {
  return defineSchema({
    name: 'ProjectConsumer',
    version: '1.0.0',
    description: 'A consumer schema that reuses a producer property',
    imports: {
      todo: {
        subject: todoOntologySubject,
        expectedHash,
      },
    },
    classes: {
      project: {
        title: 'Project',
        description: 'A project that reuses todo.title',
        type: 'object',
        required: ['title'],
        properties: {
          title: {
            $ref: 'todo.properties.title',
          },
        },
      },
    },
  });
}

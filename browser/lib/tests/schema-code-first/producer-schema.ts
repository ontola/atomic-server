import { defineSchema } from '../../src/schema.js';

export const todoSchema = defineSchema({
  name: 'TodoProject',
  version: '1.0.0',
  description: 'A tiny producer-owned todo schema',
  classes: {
    todo: {
      title: 'Todo',
      description: 'A task in a todo list',
      type: 'object',
      required: ['title'],
      properties: {
        title: {
          type: 'string',
          description: 'Task title',
        },
        done: {
          type: 'boolean',
          description: 'Whether the task is complete',
          default: false,
        },
      },
    },
  },
});

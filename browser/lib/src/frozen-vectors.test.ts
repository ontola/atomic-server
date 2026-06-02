import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'vitest';

import { frozenIdFor, type JsonValue } from './freeze.js';

interface Vector {
  name: string;
  body: JsonValue;
  id: string;
}

const fixturePath = path.resolve(
  process.cwd(),
  '../../test-vectors/frozen.json',
);
const { vectors } = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  vectors: Vector[];
};

describe('cross-language frozen vectors', () => {
  it('has vectors to check', ({ expect }) => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  for (const vector of vectors) {
    it(`reproduces the id for "${vector.name}"`, ({ expect }) => {
      expect(frozenIdFor(vector.body)).toBe(vector.id);
    });
  }
});

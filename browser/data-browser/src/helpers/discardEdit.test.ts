import { describe, expect, it, vi } from 'vitest';
import type { Resource } from '@tomic/react';
import { discardEdit } from './discardEdit';

function fakeResource(current: unknown) {
  return {
    get: vi.fn(() => current),
    set: vi.fn(() => Promise.resolve()),
    remove: vi.fn(),
  } as unknown as Resource & {
    set: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
}

describe('discardEdit', () => {
  it('puts the original value back when it was changed', () => {
    const resource = fakeResource('replacement');

    discardEdit(resource, 'https://example.com/description', 'original');

    expect(resource.set).toHaveBeenCalledWith(
      'https://example.com/description',
      'original',
      false,
    );
  });

  it('removes a value that was not set before editing', () => {
    const resource = fakeResource('typed');

    discardEdit(resource, 'https://example.com/description', undefined);

    expect(resource.remove).toHaveBeenCalledWith(
      'https://example.com/description',
    );
  });

  it('leaves an untouched value alone', () => {
    const resource = fakeResource('original');

    discardEdit(resource, 'https://example.com/description', 'original');

    expect(resource.set).not.toHaveBeenCalled();
    expect(resource.remove).not.toHaveBeenCalled();
  });
});

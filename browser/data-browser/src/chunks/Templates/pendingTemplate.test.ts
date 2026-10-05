import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PENDING_TEMPLATE_KEY,
  clearPendingTemplate,
  pendingTemplateUrl,
  readPendingTemplate,
  savePendingTemplate,
} from './pendingTemplate';

describe('pendingTemplate', () => {
  let items: Map<string, string>;

  beforeEach(() => {
    items = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => items.set(key, value),
      removeItem: (key: string) => items.delete(key),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps the chosen template and name until the account exists', () => {
    savePendingTemplate({ template: 'student', name: 'My studies' }, 1_000);

    expect(readPendingTemplate(2_000)).toEqual({
      template: 'student',
      name: 'My studies',
      examples: false,
      at: 1_000,
    });

    clearPendingTemplate();
    expect(readPendingTemplate(2_000)).toBeUndefined();
  });

  it('forgets a choice made more than a day ago', () => {
    savePendingTemplate({ template: 'student', name: 'Old' }, 0);

    expect(readPendingTemplate(25 * 60 * 60 * 1000)).toBeUndefined();
    expect(items.has(PENDING_TEMPLATE_KEY)).toBe(false);
  });

  it('ignores something that is not a pending template', () => {
    items.set(PENDING_TEMPLATE_KEY, '{"template": 3}');
    expect(readPendingTemplate()).toBeUndefined();

    items.set(PENDING_TEMPLATE_KEY, 'not json');
    expect(readPendingTemplate()).toBeUndefined();
  });

  it('returns to the name step of the same template or a blank drive', () => {
    expect(
      pendingTemplateUrl({
        template: 'student',
        name: 'My studies',
        examples: true,
        at: 0,
      }),
    ).toBe('/app/new-drive?template=student&name=My+studies&examples=1');
    expect(pendingTemplateUrl({ name: 'My drive', at: 0 })).toBe(
      '/app/new-drive?blank=1&name=My+drive',
    );
  });
});

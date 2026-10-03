import { afterEach, expect, it, vi } from 'vitest';
import { leaveTemplatePreview } from './leaveTemplatePreview';
import { TEMPLATE_DEMO_KEY } from './demoSession';

afterEach(() => vi.unstubAllGlobals());

it('returns to the template gallery before slow cleanup finishes', async () => {
  const storage = new Map([[TEMPLATE_DEMO_KEY, 'preview']]);
  vi.stubGlobal('localStorage', {
    removeItem: (key: string) => storage.delete(key),
  });
  const events: string[] = [];
  let finishCleanup!: () => void;
  const cleanup = vi.fn(
    () =>
      new Promise<void>(resolve => {
        events.push('cleanup started');
        finishCleanup = resolve;
      }),
  );
  const store = { setDrive: (drive: string) => events.push(`drive ${drive}`) };
  const navigate = (path: string) => events.push(`navigate ${path}`);

  leaveTemplatePreview(
    store,
    {
      drive: 'did:ad:preview',
      template: 'student',
      previousDrive: 'did:ad:home',
    },
    navigate,
    cleanup,
  );

  expect(events).toEqual([
    'drive did:ad:home',
    'navigate /app/new-drive',
    'cleanup started',
  ]);
  expect(storage.has(TEMPLATE_DEMO_KEY)).toBe(false);
  finishCleanup();
});

import type { Store } from '@tomic/react';
import { TEMPLATE_DEMO_KEY, type TemplateDemo } from './demoSession';

/** Return to the gallery immediately; old preview cleanup can finish later. */
export function leaveTemplatePreview(
  store: Pick<Store, 'setDrive'>,
  preview: TemplateDemo,
  navigate: (path: string) => void,
  cleanup: () => Promise<void>,
): void {
  store.setDrive(preview.previousDrive);
  localStorage.removeItem(TEMPLATE_DEMO_KEY);
  navigate('/app/new-drive');
  void cleanup().catch(error => {
    console.warn('[Template] preview cleanup failed:', error);
  });
}

// @wc-ignore-file
import { hostSnapshot } from './snapshotHost';

for (const element of document.querySelectorAll<HTMLIFrameElement>(
  'iframe[data-snapshot]',
)) {
  const data = document.getElementById(element.dataset.snapshot!);
  if (!data) continue;
  const bridge = hostSnapshot(element, JSON.parse(data.textContent!));
  window.addEventListener('pagehide', () => bridge.close(), { once: true });
  // Activate only after registering the bridge, including on fast cached loads.
  element.src = element.dataset.src!;
}

// Side-effect module: imported by index.tsx before App, so the path it sets is
// the one App.tsx and the router read at startup.
//
// The demo is a scripted scene: its teammates only move while the director
// that started with /app/demo runs, and that director does not survive a page
// load. Reloading in the demo left a still workspace with a half-typed welcome
// document and nobody around. Start the demo fresh instead, the same way
// "Try Atomic" does. Anything the visitor changed in it goes with it; to keep
// that, "Choose a template" offers to carry the demo's content over.
import { readInteractiveDemo } from '../chunks/Templates/demoSession';

function currentDrive(): string | undefined {
  try {
    const stored = localStorage.getItem('drive');

    return stored ? (JSON.parse(stored) as string) : undefined;
  } catch {
    return undefined;
  }
}

const inWorkspace =
  window.location.pathname === '/app/show' || window.location.pathname === '/';
const demo = readInteractiveDemo();

if (inWorkspace && demo && currentDrive() === demo.drive) {
  window.history.replaceState(null, '', '/app/demo');
}

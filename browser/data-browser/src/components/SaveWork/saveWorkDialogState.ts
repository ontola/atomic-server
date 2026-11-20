/**
 * Module-level switch for the Save dialog, like `shareDialogState.ts`: the
 * Getting started card and the sidebar's guest row open it without importing
 * each other. `SaveWorkDialogHost` is the one listener, mounted in the chrome.
 */

const listeners = new Set<() => void>();

export function openSaveWorkDialog(): void {
  listeners.forEach(listener => listener());
}

export function subscribeSaveWorkDialog(listener: () => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

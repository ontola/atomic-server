// @wc-ignore-file
import type { DiagnosticRecorder } from '@tomic/lib';

export interface DiagnosticPreview {
  session: number;
  text: string;
}

export function previewDiagnostics(
  recorder: DiagnosticRecorder,
): DiagnosticPreview {
  return {
    session: recorder.session,
    text: JSON.stringify(
      {
        schema: 1,
        build: `${__APP_VERSION__}+${__GIT_COMMIT__}`,
        runtime: 'browser',
        events: recorder.snapshot(),
      },
      null,
      2,
    ),
  };
}

export function currentDiagnosticText(
  recorder: DiagnosticRecorder,
  preview?: DiagnosticPreview,
): string | undefined {
  // Expiry is checked synchronously too (background tabs can delay timers).
  recorder.snapshot();

  return recorder.active && preview?.session === recorder.session
    ? preview.text
    : undefined;
}

export function downloadDiagnostics(text: string): void {
  const url = URL.createObjectURL(
    new Blob([text], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = 'atomic-diagnostics.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

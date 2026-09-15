import { afterEach, expect, it, vi } from 'vitest';
import { DiagnosticRecorder } from '@tomic/lib';
import { currentDiagnosticText, previewDiagnostics } from './diagnostic-report';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('exports only a frozen preview with build identity, never private input', () => {
  vi.stubGlobal('__APP_VERSION__', 'test');
  vi.stubGlobal('__GIT_COMMIT__', 'abc123');
  const recorder = new DiagnosticRecorder();
  recorder.start();
  recorder.beginSave({ subject: 'SECRET_URL', content: 'PRIVATE_TEXT' })(
    'error',
  );
  const preview = previewDiagnostics(recorder);
  recorder.connection(false);
  const report = currentDiagnosticText(recorder, preview)!;
  expect(report).toContain('test+abc123');
  expect(report).toContain('save-error');
  expect(report).not.toMatch(/SECRET_URL|PRIVATE_TEXT|disconnected/);
  recorder.clear();
  expect(currentDiagnosticText(recorder, preview)).toBeUndefined();
  recorder.start();
  expect(currentDiagnosticText(recorder, preview)).toBeUndefined();
  recorder.clear();
});

it('rejects an expired preview even when background timers did not run', () => {
  vi.useFakeTimers();
  vi.stubGlobal('__APP_VERSION__', 'test');
  vi.stubGlobal('__GIT_COMMIT__', 'abc123');
  const recorder = new DiagnosticRecorder();
  recorder.start();
  const preview = previewDiagnostics(recorder);
  vi.setSystemTime(Date.now() + 31 * 60_000);
  expect(currentDiagnosticText(recorder, preview)).toBeUndefined();
  expect(recorder.active).toBe(false);
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DiagnosticRecorder } from './diagnostics.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('local diagnostic recorder', () => {
  it('is off by default and never retains supplied identities or errors', () => {
    const recorder = new DiagnosticRecorder();
    const resource = {
      subject: 'https://private.example/SECRET',
      title: 'PRIVATE_TEXT',
    };
    recorder.beginSave(resource)('error');
    expect(recorder.snapshot()).toEqual([]);
    recorder.start();
    recorder.beginSave(resource)('error');
    const report = JSON.stringify(recorder.snapshot());
    expect(report).toContain('save-error');
    expect(report).not.toMatch(
      /SECRET|PRIVATE_TEXT|private.example|subject|title/,
    );
    recorder.clear();
  });

  it('bounds events and clears all data when recording expires', () => {
    vi.useFakeTimers();
    const recorder = new DiagnosticRecorder();
    recorder.start();
    for (let i = 0; i < 700; i++) recorder.connection(i % 2 === 0);
    expect(recorder.snapshot()).toHaveLength(500);
    vi.advanceTimersByTime(10 * 60_000 + 10_000);
    expect(recorder.snapshot()).toEqual([]);
    recorder.connection(true);
    vi.advanceTimersByTime(20 * 60_000);
    expect(recorder.active).toBe(false);
    expect(recorder.snapshot()).toEqual([]);
  });

  it('detects a slow save and a non-draining connected queue once', () => {
    vi.useFakeTimers();
    const recorder = new DiagnosticRecorder();
    recorder.start();
    const finish = recorder.beginSave({});
    recorder.queue(2, 0, true);
    vi.advanceTimersByTime(70_000);
    expect(
      recorder.snapshot().filter(e => e.code === 'save-slow'),
    ).toHaveLength(1);
    expect(
      recorder.snapshot().filter(e => e.code === 'queue-stalled'),
    ).toHaveLength(1);
    finish('persisted');
    expect(recorder.snapshot().at(-1)?.code).toBe('save-persisted');
    recorder.clear();
  });

  it('does not call an offline queue stalled and ignores late results after clear', () => {
    vi.useFakeTimers();
    const recorder = new DiagnosticRecorder();
    recorder.start();
    recorder.queue(1, 0, false);
    const finish = recorder.beginSave({});
    vi.advanceTimersByTime(70_000);
    expect(recorder.snapshot().some(e => e.code === 'queue-stalled')).toBe(
      false,
    );
    recorder.clear();
    recorder.start();
    finish('persisted');
    expect(recorder.snapshot()).toEqual([]);
    recorder.clear();
  });
});

describe('recorder integration', () => {
  it('records real save failures without changing rejection or retaining content', async () => {
    const { Store } = await import('./store.js');
    const store = new Store({ serverUrl: 'https://example.com' });
    store.diagnostics.start();
    const { Resource } = await import('./resource.js');
    const resource = new Resource('https://private.example/SECRET', true);
    resource.setStore(store);
    await resource.set(
      'https://atomicdata.dev/properties/name',
      'PRIVATE_TEXT',
      false,
    );
    await expect(resource.save()).rejects.toThrow();
    expect(store.diagnostics.snapshot().map(event => event.code)).toContain(
      'save-error',
    );
    store.diagnostics.clear();
  });

  it('does not let a diagnostic UI listener break saves or resets', () => {
    const recorder = new DiagnosticRecorder();
    recorder.subscribe(() => {
      throw new Error('PRIVATE listener error');
    });
    expect(() => recorder.start()).not.toThrow();
    expect(() => recorder.beginSave({})('persisted')).not.toThrow();
    expect(() => recorder.clear()).not.toThrow();
  });
});

it('clears recording when the Store changes account', async () => {
  const { testStore } = await import('./test-store.js');
  const { store } = await testStore();
  store.diagnostics.start();
  store.diagnostics.connection(true);
  store.setAgent(undefined);
  expect(store.diagnostics.active).toBe(false);
  expect(store.diagnostics.snapshot()).toEqual([]);
});

it('stops collecting after expiry when background timers are delayed', () => {
  vi.useFakeTimers();
  const recorder = new DiagnosticRecorder();
  recorder.start();
  vi.setSystemTime(Date.now() + 31 * 60_000);
  recorder.connection(true);
  expect(recorder.active).toBe(false);
  expect(recorder.snapshot()).toEqual([]);
});

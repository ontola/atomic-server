import type {
  BrowserContext,
  ConsoleMessage,
  WebError,
} from '@playwright/test';

export type DiagnosticKind = 'warning' | 'error' | 'pageerror';
type Entry = {
  kind: DiagnosticKind;
  message: string;
  url: string;
  expected: boolean;
};
type Expected = {
  kind: DiagnosticKind;
  message: RegExp;
  reason: string;
  count: number;
  seen: number;
  url?: RegExp;
  /** Allowed, but not required — see {@link DiagnosticCollector.expect}. */
  optional?: boolean;
};

/** Per-test expectations, with no global allowlist. Disposal preserves evidence. */
export class DiagnosticCollector {
  private entries: Entry[] = [];
  private expected: Expected[] = [];
  private contexts = new Map<BrowserContext, () => void>();

  /**
   * Declare a diagnostic this test causes.
   *
   * Exact by default: seeing it fewer times than declared fails, because a
   * disappeared diagnostic usually means the test stopped exercising what it
   * was written for. `optional` relaxes that to "allowed, up to `count`" —
   * for a diagnostic that depends on how the app is served rather than on
   * what the test does, where requiring it would fail the test on one
   * topology and allowing anything would stop policing it on the other.
   */
  expect(
    kind: DiagnosticKind,
    message: RegExp,
    reason: string,
    count = 1,
    url?: RegExp,
    options: { optional?: boolean } = {},
  ): void {
    if (!reason.trim() || !Number.isInteger(count) || count < 1) {
      throw new Error(
        'Expected diagnostics require a reason and a positive integer count',
      );
    }

    this.expected.push({
      kind,
      message,
      reason,
      count,
      url,
      seen: 0,
      optional: options.optional,
    });
  }

  start(context: BrowserContext): void {
    if (this.contexts.has(context)) return;

    const onConsole = (message: ConsoleMessage) => {
      const kind = message.type();

      if (kind === 'warning' || kind === 'error') {
        this.record({
          kind,
          message: message.text(),
          url: message.location().url,
        });
      }
    };

    const onError = (event: WebError) => {
      this.record({
        kind: 'pageerror',
        message: event.error().stack ?? event.error().message,
        url: event.page()?.url() ?? '',
      });
    };

    context.on('console', onConsole);
    context.on('weberror', onError);
    this.contexts.set(context, () => {
      context.off('console', onConsole);
      context.off('weberror', onError);
    });
  }

  private record(entry: Omit<Entry, 'expected'>): void {
    const match = this.expected.find(rule => {
      rule.message.lastIndex = 0;
      if (rule.url) rule.url.lastIndex = 0;

      return (
        rule.kind === entry.kind &&
        rule.seen < rule.count &&
        rule.message.test(entry.message) &&
        (!rule.url || rule.url.test(entry.url))
      );
    });
    if (match) match.seen++;
    this.entries.push({ ...entry, expected: !!match });
  }

  snapshot() {
    const entries = this.entries.map(entry => ({ ...entry }));
    const expectations = this.expected.map(rule => ({
      ...rule,
      message: rule.message.source,
      url: rule.url?.source,
    }));

    return {
      entries,
      expectations,
      unexpected: entries.filter(entry => !entry.expected),
      missing: expectations.filter(
        rule => !rule.optional && rule.seen !== rule.count,
      ),
    };
  }

  dispose(): void {
    this.contexts.forEach(cleanup => cleanup());
    this.contexts.clear();
  }
}

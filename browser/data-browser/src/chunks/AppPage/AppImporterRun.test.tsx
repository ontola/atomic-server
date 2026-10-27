// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppImporterRun, type ImporterAsk } from './AppImporterRun';

const state = vi.hoisted(() => ({
  execute: vi.fn(async () => ({
    verdict: 'review-this',
    error: undefined as string | undefined,
  })),
}));
vi.mock('@tomic/react', async () => ({
  ...(await vi.importActual<typeof import('@tomic/react')>('@tomic/react')),
  useResource: () => ({ subject: 'atomic:importer', title: 'Statements' }),
  useStore: () => ({}),
  executeServerPlugin: state.execute,
}));
vi.mock('@chunks/PluginRuns/RunPluginDialog', () => ({
  RunPluginDialog: ({
    onFinished,
  }: {
    onFinished: (outcome: unknown) => void;
  }) => (
    <button
      onClick={() =>
        onFinished({
          report: {
            outcomes: [
              { status: 'applied', op: 'create', subject: 'atomic:row' },
            ],
          },
          plan: { changes: [], problems: [], blocked: false },
        })
      }
    >
      Apply reviewed proposal
    </button>
  ),
}));
vi.mock('@components/Row', () => ({
  Row: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Column: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock('@components/Button', () => ({
  Button: ({
    children,
    subtle: _subtle,
    ...props
  }: React.ComponentProps<'button'> & { subtle?: boolean }) => (
    <button {...props}>{children}</button>
  ),
}));

function ask(): ImporterAsk {
  return {
    id: 1,
    reply: vi.fn(),
    resolved: {
      importer: 'atomic:importer',
      title: 'Statements',
      source: 'export function run() {}',
      manifest: {
        secrets: [],
        accepts: [{ extensions: ['.txt'], as: 'text', maxBytes: 100 }],
      },
      config: {},
      upload: {
        name: 'statement.txt',
        mediaType: 'text/plain',
        text: 'fixture',
        size: 7,
      },
    },
  };
}

beforeEach(() => state.execute.mockClear());
afterEach(() => cleanup());

it('does not run before confirmation and reports only after the reviewed apply', async () => {
  const request = ask(),
    done = vi.fn();
  render(<AppImporterRun ask={request} drive='atomic:drive' onDone={done} />);
  expect(state.execute).not.toHaveBeenCalled();
  expect(request.reply).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Preview import' }));
  const apply = await screen.findByRole('button', {
    name: 'Apply reviewed proposal',
  });
  expect(state.execute).toHaveBeenCalledOnce();
  expect(request.reply).not.toHaveBeenCalled();
  fireEvent.click(apply);
  expect(request.reply).toHaveBeenCalledWith({
    id: 1,
    result: {
      status: 'applied',
      importer: 'atomic:importer',
      created: 1,
      updated: 0,
      destroyed: 0,
      failed: 0,
      errors: [],
    },
  });
  expect(done).toHaveBeenCalledOnce();
});

it('cancels without running or writing', () => {
  const request = ask();
  render(
    <AppImporterRun ask={request} drive='atomic:drive' onDone={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(state.execute).not.toHaveBeenCalled();
  expect(request.reply).toHaveBeenCalledWith({
    id: 1,
    result: { status: 'cancelled', importer: 'atomic:importer' },
  });
});

it('reports a refused file without displaying an apply action', async () => {
  state.execute.mockResolvedValueOnce({
    verdict: '',
    error: 'Not a statement',
  });
  const request = ask();
  render(
    <AppImporterRun ask={request} drive='atomic:drive' onDone={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Preview import' }));
  await waitFor(() =>
    expect(request.reply).toHaveBeenCalledWith({
      id: 1,
      result: {
        status: 'blocked',
        importer: 'atomic:importer',
        errors: ['Not a statement'],
      },
    }),
  );
  expect(
    screen.queryByRole('button', { name: 'Apply reviewed proposal' }),
  ).toBeNull();
});

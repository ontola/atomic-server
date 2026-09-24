// @vitest-environment jsdom
// @wc-ignore-file
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from 'styled-components';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  grantsWithRouteWrites,
  routeWriteConfigChange,
  type DeclaredWriteTarget,
} from '@tomic/react';
import { buildTheme } from '../../styling';
import { RouteWriteMoveDialog } from './RouteWriteMoveDialog';
import inbox from '../../../../../testdata/plugin-routes/inbox/manifest.json';

const dialog = vi.hoisted(() => [{}, () => undefined, () => undefined, true]);

vi.mock('@components/Dialog', async original => {
  const Pass = ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  );

  return {
    ...(await original<typeof import('@components/Dialog')>()),
    Dialog: Object.assign(Pass, {
      Title: Pass,
      Content: Pass,
      Actions: Pass,
    }),
    useDialog: () => dialog,
  };
});
vi.mock('@views/ResourceInline', () => ({
  ResourceInline: ({ subject }: { subject: string }) => <span>{subject}</span>,
}));

afterEach(cleanup);

// #1754's fixture: `inbox-items` under `config:inbox`.
const TARGETS = inbox.http.writeTargets as DeclaredWriteTarget[];
const OLD = 'https://atomic.test/inbox';
const NEW = 'https://atomic.test/elsewhere';

function renderMove() {
  const change = routeWriteConfigChange(
    grantsWithRouteWrites(['storage'], TARGETS),
    { inbox: OLD },
    { inbox: NEW },
  )!;
  const onSave = vi.fn(async (_approve: boolean) => undefined);
  render(
    <ThemeProvider theme={buildTheme(false, '#1a4fff')}>
      <RouteWriteMoveDialog
        plugin='fixtures/inbox'
        change={change}
        config={{ inbox: NEW }}
        onSave={onSave}
        onClose={() => undefined}
      />
    </ThemeProvider>,
  );

  return onSave;
}

describe('moving a write target in the config', () => {
  it('shows the new parent as New and asks for approval, unchecked', () => {
    renderMove();

    const target = screen.getByTestId('route-write-target-inbox-items');
    expect(target.textContent).toContain(NEW);
    expect(screen.getByTestId('route-write-new')).toBeTruthy();
    expect(
      (screen.getByTestId('route-write-approval') as HTMLInputElement).checked,
    ).toBe(false);
  });

  it('saves with the approval when it is given', async () => {
    const onSave = renderMove();

    fireEvent.click(screen.getByTestId('route-write-approval'));
    fireEvent.click(screen.getByRole('button', { name: 'Save config' }));

    await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith(true));
  });

  it('saves declined when it is left unchecked', async () => {
    const onSave = renderMove();

    fireEvent.click(screen.getByRole('button', { name: 'Save config' }));

    await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith(false));
  });
});

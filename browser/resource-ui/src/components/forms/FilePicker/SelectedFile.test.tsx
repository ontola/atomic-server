// @vitest-environment jsdom
// @wc-ignore-file
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Resource, Store } from '@tomic/lib';
import { StoreContext } from '@tomic/react';
import { buildTheme, ThemeProvider } from '../../../../test/providers';
import { SelectedFileResource } from './SelectedFile';

const FILE = 'https://example.com/files/gone';

function setup(onClear = () => {}) {
  const store = new Store({ connect: false });
  // A File that finished loading without any file properties, as happens
  // when the fetch failed (404, unauthorized, other server).
  const file = new Resource(FILE);
  file.loading = false;
  file.error = new Error('Not found');
  store.addResource(file);

  return render(
    <StoreContext.Provider value={store}>
      <ThemeProvider theme={buildTheme()}>
        <SelectedFileResource subject={FILE} onClear={onClear} />
      </ThemeProvider>
    </StoreContext.Provider>,
  );
}

afterEach(cleanup);

describe('SelectedFileResource with a file that failed to load', () => {
  it('does not throw while rendering and keeps the clear button usable', () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const onClear = vi.fn();
    setup(onClear);

    expect(screen.getByText(/could not display file preview/i)).toBeTruthy();
    fireEvent.click(screen.getByTitle('clear'));
    expect(onClear).toHaveBeenCalled();
    // An error thrown by useFileInfo is logged by React even when a boundary
    // catches it.
    expect(consoleError.mock.calls.flat().map(String).join(' ')).not.toContain(
      'File resource is missing properties',
    );
    consoleError.mockRestore();
  });
});

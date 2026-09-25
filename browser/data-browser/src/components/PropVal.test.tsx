// @vitest-environment jsdom
// @wc-ignore-file
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from 'styled-components';
import { core, Datatype, Resource, Store } from '@tomic/lib';
import { StoreContext } from '@tomic/react';
import { buildTheme } from '../styling';
// PropVal → ValueComp → NestedResource → AllProps → PropVal is a cycle. Enter it
// at AllProps, as the app does, or AllProps styles a PropVal not yet defined.
import './AllProps';
import PropVal from './PropVal';

// Editing needs an agent with write access; neither is what is under test.
vi.mock('../helpers/AppSettings', () => ({
  useSettings: () => ({ agent: { subject: 'atomic:agent:test' } }),
}));
vi.mock('@tomic/react', async importOriginal => ({
  ...(await importOriginal<typeof import('@tomic/react')>()),
  useCanWrite: () => true,
}));

const BOUGHT = 'https://example.com/properties/bought';
const DUE = 'https://example.com/properties/due-date';
const ROW = 'https://example.com/rows/milk';

async function property(
  subject: string,
  shortname: string,
  datatype: Datatype,
  name?: string,
) {
  const resource = new Resource(subject);
  await resource.set(core.properties.shortname, shortname, false);
  await resource.set(core.properties.datatype, datatype, false);
  await resource.set(core.properties.description, `About ${shortname}`, false);

  if (name) await resource.set(core.properties.name, name, false);

  resource.loading = false;

  return resource;
}

async function setup(labelByName: boolean, propertyURL = BOUGHT) {
  const store = new Store();
  store.addResource(
    await property(BOUGHT, 'bought', Datatype.BOOLEAN, 'Bought'),
  );
  store.addResource(await property(DUE, 'due-date', Datatype.DATE));
  const row = new Resource(ROW);
  row.loading = false;
  store.addResource(row);

  return render(
    <StoreContext.Provider value={store}>
      <ThemeProvider theme={buildTheme(false, '#1b50d8')}>
        <PropVal
          editable
          labelByName={labelByName}
          propertyURL={propertyURL}
          resource={store.getResourceLoading(ROW)}
        />
      </ThemeProvider>
    </StoreContext.Provider>,
  );
}

afterEach(cleanup);

describe('a value in the row dialog', () => {
  it("is labelled with the property's name, with the shortname as tooltip", async () => {
    await setup(true);

    const label = screen.getByText('Bought');
    expect(label.tagName).toBe('LABEL');
    expect(label.getAttribute('title')).toBe('bought: About bought');
    expect(screen.queryByText('bought')).toBeNull();
  });

  it('falls back to a readable shortname when the property has no name', async () => {
    await setup(true, DUE);

    expect(screen.getByText('Due date').tagName).toBe('LABEL');
  });

  it('does not navigate away: the label is no link, the property opens in a new tab', async () => {
    await setup(true);

    expect(screen.getByText('Bought').closest('a')).toBeNull();
    const open = screen.getByRole('link', { name: 'Open Bought in a new tab' });
    expect(open.getAttribute('target')).toBe('_blank');
    expect(open.getAttribute('href')).toContain(encodeURIComponent(BOUGHT));
  });

  it('names the checkbox after its label once it is being edited', async () => {
    await setup(true);

    fireEvent.click(screen.getByTitle('Click to add a value'));

    // The accessible name, computed the way assistive technology does.
    const checkbox = screen.getByRole('checkbox', { name: 'Bought' });
    expect(checkbox).toBeTruthy();
  });
});

describe('a value on a resource page', () => {
  it('keeps the shortname, linked to the property', async () => {
    await setup(false);

    const label = screen.getByText('bought');
    expect(label.closest('a')?.getAttribute('href')).toBe(BOUGHT);
  });
});

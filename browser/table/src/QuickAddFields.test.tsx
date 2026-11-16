// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  TableQuickAddFields,
  quickAddDraftFromSpec,
  quickAddSpecFromDraft,
  type QuickAddDraft,
} from './QuickAddFields.js';
import type { TableRowActionKind } from './RowActionFields.js';
afterEach(cleanup);
const fields = [
  {
    key: 'name',
    option: (
      <option key='name' value='name'>
        Name
      </option>
    ),
  },
];
const kinds: TableRowActionKind[] = [
  {
    kind: 'increment',
    title: 'Add a number',
    description: 'Step',
    defaultLabel: '+1',
    valueField: { input: 'number', label: 'By' },
    targets: [
      {
        key: 'count',
        option: (
          <option key='count' value='count'>
            Count
          </option>
        ),
      },
    ],
  },
  {
    kind: 'toggle',
    title: 'Toggle',
    description: 'Toggle',
    defaultLabel: 'Toggle',
    targets: [
      {
        key: 'done',
        option: (
          <option key='done' value='done'>
            Done
          </option>
        ),
      },
    ],
  },
];
const valid = (): QuickAddDraft => ({
  ...quickAddDraftFromSpec(undefined, 'name'),
  label: 'Create',
  presetKind: 'increment',
  presetProperty: 'count',
  presetValue: '0',
});
it('retains native numeric input and delegates preset changes through the existing flat draft', () => {
  function Editor() {
    const [draft, setDraft] = useState(() => ({
      ...valid(),
      presetValue: '1',
    }));

    return (
      <>
        <TableQuickAddFields
          draft={draft}
          onChange={setDraft}
          kinds={kinds}
          fields={fields}
          presetValues={[]}
        />
        <output data-testid='state'>{JSON.stringify(draft)}</output>
      </>
    );
  }

  render(<Editor />);
  fireEvent.change(screen.getByRole('spinbutton', { name: 'By' }), {
    target: { value: '0' },
  });
  let draft = JSON.parse(screen.getByTestId('state').textContent!);
  expect(quickAddSpecFromDraft(draft, kinds).presets).toEqual([
    { kind: 'increment', property: 'count', value: 0 },
  ]);
  fireEvent.change(screen.getByLabelText('Also set'), {
    target: { value: 'toggle' },
  });
  draft = JSON.parse(screen.getByTestId('state').textContent!);
  expect(draft).toMatchObject({
    presetKind: 'toggle',
    presetProperty: '',
    presetValue: '',
  });
});

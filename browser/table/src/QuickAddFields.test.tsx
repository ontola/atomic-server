// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  TableQuickAddFields,
  quickAddDraftFromSpec,
  quickAddSpecFromDraft,
  isQuickAddDraftComplete,
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
it('rejects incomplete numeric and incompatible presets without coercing them into writes', () => {
  for (const value of ['', '-', '1e', 'Infinity', '0x10', '1e999']) {
    const draft = { ...valid(), presetValue: value };
    expect(isQuickAddDraftComplete(draft, kinds, fields)).toBe(false);
    expect(() => quickAddSpecFromDraft(draft, kinds, fields)).toThrow();
  }

  expect(
    isQuickAddDraftComplete(
      { ...valid(), presetProperty: 'missing' },
      kinds,
      fields,
    ),
  ).toBe(false);
  expect(
    isQuickAddDraftComplete({ ...valid(), field: 'missing' }, kinds, fields),
  ).toBe(false);
  expect(quickAddSpecFromDraft(valid(), kinds, fields).presets).toEqual([
    { kind: 'increment', property: 'count', value: 0 },
  ]);
  expect(
    quickAddSpecFromDraft({ ...valid(), withField: false }, kinds, fields)
      .field,
  ).toBeUndefined();
});
it('preserves stored presets beyond the first and captures their own values', () => {
  const spec = {
    label: 'Create',
    presets: [
      { kind: 'increment' as const, property: 'count', value: 2 },
      { kind: 'toggle' as const, property: 'done' },
    ],
  };
  const draft = quickAddDraftFromSpec(spec, 'name');
  draft.label = 'Updated';
  expect(quickAddSpecFromDraft(draft, kinds, fields)).toEqual({
    ...spec,
    label: 'Updated',
  });
  draft.remainingPresets![0].property = 'other';
  expect(spec.presets[1].property).toBe('done');
});
it('retains raw input and resets target and literal when changing the preset verb', () => {
  function Editor() {
    const [draft, setDraft] = useState(valid);

    return (
      <>
        <TableQuickAddFields
          draft={draft}
          onChange={setDraft}
          kinds={kinds}
          fields={fields}
        />
        <output data-testid='state'>{JSON.stringify(draft)}</output>
      </>
    );
  }

  render(<Editor />);
  fireEvent.change(screen.getByLabelText('By'), { target: { value: '-' } });
  expect((screen.getByLabelText('By') as HTMLInputElement).value).toBe('-');
  expect(screen.getByRole('alert')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Also set'), {
    target: { value: 'toggle' },
  });
  const draft = JSON.parse(screen.getByTestId('state').textContent!);
  expect(draft).toMatchObject({
    presetKind: 'toggle',
    presetProperty: '',
    presetValue: '',
  });
  fireEvent.change(screen.getByLabelText('On column'), {
    target: { value: 'done' },
  });
  expect(screen.queryByRole('alert')).toBeNull();
});

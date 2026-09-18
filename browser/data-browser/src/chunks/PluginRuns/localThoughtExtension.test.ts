import { expect, it } from 'vitest';
import {
  extensionMode,
  localThoughtExtension,
  schemaNamespace,
} from './localThoughtExtension';

it('keeps new generated Calendar imports plain while legacy Calendar stays Devonian', () => {
  expect(extensionMode('google-calendar', 'none')).toBe('none');
  expect(localThoughtExtension('google-calendar', 'none')).toBeUndefined();
  expect(schemaNamespace('google-calendar', 'none')).toBe(
    'api-google-calendar',
  );

  expect(extensionMode('google-calendar', 'calendar')).toBe('calendar');
  expect(localThoughtExtension('google-calendar', 'calendar')?.id).toBe(
    'google-calendar',
  );
  expect(schemaNamespace('google-calendar', 'calendar')).toBe(
    'google-calendar',
  );
  expect(extensionMode('google-calendar', undefined)).toBe('calendar');
  expect(schemaNamespace('pets', undefined)).toBe('pets');
});

it('translates Todoist through its read-only tasks lens', () => {
  const todoist = localThoughtExtension('todoist', 'tasks');
  expect(todoist?.id).toBe('todoist');
  expect(todoist?.view.kind).toBe('issues');
  expect(todoist?.Sync).toBeUndefined();
  // A plain generated Todoist import stays plain, and a Todoist installation
  // from before the lens existed is plain too: `tasks` is never implied.
  expect(localThoughtExtension('todoist', 'none')).toBeUndefined();
  expect(extensionMode('todoist', undefined)).toBe('none');
  expect(schemaNamespace('todoist', 'tasks')).toBe('todoist');
  // A lens never answers for another platform's mode.
  expect(localThoughtExtension('google-calendar', 'tasks')).toBeUndefined();
});

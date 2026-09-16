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

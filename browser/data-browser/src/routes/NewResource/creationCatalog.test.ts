import { expect, it } from 'vitest';
import {
  AI_BUILD_SUGGESTIONS,
  isUntouchedSuggestion,
  matchesCreationSearch,
  CREATION_TABLE_TEMPLATES,
} from './creationCatalog';
import { TABLE_TEMPLATES } from '../../chunks/TablePage/tableTemplates';
import { creationAssistantAsk } from './creationAssistant';
it('offers every configured table template and searches multiple words across its content', () => {
  expect(CREATION_TABLE_TEMPLATES.map(t => t.id)).toEqual(
    TABLE_TEMPLATES.filter(t => t.spec).map(t => t.id),
  );
  expect(
    matchesCreationSearch('  KANBAN issue ', 'Issue Tracker', 'A kanban board'),
  ).toBe(true);
  expect(
    matchesCreationSearch('calendar invoice', 'Issue Tracker', 'A calendar'),
  ).toBe(false);
});
it('hands off the actual request with the selected parent', () => {
  const ask = creationAssistantAsk('  A reading log  ', 'did:ad:nested-folder');
  expect(ask.prompt).toContain('A reading log');
  expect(ask.prompt).toContain('inside the attached parent');
  expect(ask.context).toEqual([
    {
      type: 'atomic-resource',
      subject: 'did:ad:nested-folder',
      id: expect.any(String),
    },
  ]);
});
it('suggests the four things the blank list cannot show, each left unfinished', () => {
  expect(AI_BUILD_SUGGESTIONS.map(item => item.id)).toEqual([
    'app',
    'website',
    'dashboard',
    'table',
  ]);

  // A seed ending mid-sentence is the whole point: the user finishes it.
  for (const item of AI_BUILD_SUGGESTIONS) {
    expect(item.seed.endsWith(' ')).toBe(true);
    expect(item.seed.trim().split(' ').length).toBeGreaterThan(2);
  }
});
it("offers suggestions until there is something of the user's own to lose", () => {
  expect(isUntouchedSuggestion('')).toBe(true);
  expect(isUntouchedSuggestion(AI_BUILD_SUGGESTIONS[0].seed)).toBe(true);
  expect(
    isUntouchedSuggestion(AI_BUILD_SUGGESTIONS[0].seed + 'tracks my plants'),
  ).toBe(false);
  expect(isUntouchedSuggestion('A CRM for my sales team')).toBe(false);
});

import { describe, expect, it } from 'vitest';
import { driveNameFromPrompt } from './driveNameFromPrompt';

describe('driveNameFromPrompt', () => {
  it('uses a website host when the message includes a URL', () => {
    expect(driveNameFromPrompt('CRM for https://www.acme.com/about')).toBe(
      'acme.com',
    );
  });

  it('uses the first line when there is no URL', () => {
    expect(driveNameFromPrompt('Personal notes\nMore detail')).toBe(
      'Personal notes',
    );
  });

  it('truncates a long first line', () => {
    const long = 'A'.repeat(60);
    const name = driveNameFromPrompt(long);

    expect(name.length).toBe(48);
    expect(name.endsWith('…')).toBe(true);
  });

  it('falls back when the message is empty', () => {
    expect(driveNameFromPrompt('   ')).toBe('New Drive');
  });
});

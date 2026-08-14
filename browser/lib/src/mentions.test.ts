import { describe, expect, it } from 'vitest';
import {
  extractAgentMentionsFromText,
  extractAgentMentionsFromTipTap,
  isAgentSubject,
  mentionDedupeKey,
  messageDedupeKey,
} from './mentions.js';

describe('isAgentSubject', () => {
  it('accepts agent DIDs', () => {
    expect(isAgentSubject('did:ad:agent:abc123')).toBe(true);
  });

  it('rejects other subjects', () => {
    expect(isAgentSubject('did:ad:xyz')).toBe(false);
    expect(isAgentSubject('https://example.com/foo')).toBe(false);
  });
});

describe('extractAgentMentionsFromTipTap', () => {
  it('collects agent subjects from resource nodes', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'atomic-data-resource-inline',
              attrs: { subject: 'did:ad:agent:alice' },
            },
            {
              type: 'atomic-data-resource-inline',
              attrs: { subject: 'https://example.com/doc' },
            },
            {
              type: 'atomic-data-resource',
              attrs: { subject: 'did:ad:agent:bob' },
            },
          ],
        },
      ],
    };

    expect(extractAgentMentionsFromTipTap(doc).sort()).toEqual([
      'did:ad:agent:alice',
      'did:ad:agent:bob',
    ]);
  });

  it('dedupes repeated mentions', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'atomic-data-resource-inline',
          attrs: { subject: 'did:ad:agent:alice' },
        },
        {
          type: 'atomic-data-resource-inline',
          attrs: { subject: 'did:ad:agent:alice' },
        },
      ],
    };

    expect(extractAgentMentionsFromTipTap(doc)).toEqual(['did:ad:agent:alice']);
  });
});

describe('extractAgentMentionsFromText', () => {
  it('finds bare agent DIDs in chat text', () => {
    const text = 'hey did:ad:agent:alice and also did:ad:agent:bob please look';

    expect(extractAgentMentionsFromText(text).sort()).toEqual([
      'did:ad:agent:alice',
      'did:ad:agent:bob',
    ]);
  });
});

describe('mentionDedupeKey', () => {
  it('is stable', () => {
    expect(mentionDedupeKey('about', 'actor', 'mentioned')).toBe(
      'mention|about|actor|mentioned',
    );
  });
});

describe('messageDedupeKey', () => {
  it('is stable', () => {
    expect(messageDedupeKey('about', 'actor', 'me')).toBe(
      'message|about|actor|me',
    );
  });
});

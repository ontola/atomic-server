import { describe, expect, it } from 'vitest';
import { RightType, type Right } from './resource.js';
import { accessRequestDedupeKey, messageDedupeKey } from './mentions.js';
import {
  accessRequestNotificationSummary,
  agentSubjectsFromRights,
  isCollaboratorSubject,
  mergeAgentIntoRights,
  messageNotificationSummary,
  previewMessageBody,
} from './socialNotifications.js';

const PUBLIC = 'https://atomicdata.dev/agents/publicAgent';

describe('agentSubjectsFromRights', () => {
  const rights: Right[] = [
    { for: 'did:ad:agent:alice', type: RightType.WRITE, setIn: 'drive' },
    { for: 'did:ad:agent:bob', type: RightType.READ, setIn: 'drive' },
    { for: PUBLIC, type: RightType.READ, setIn: 'drive' },
    { for: 'did:ad:agent:alice', type: RightType.READ, setIn: 'drive' },
  ];

  it('lists unique collaborators, skipping the public agent', () => {
    expect(agentSubjectsFromRights(rights).sort()).toEqual([
      'did:ad:agent:alice',
      'did:ad:agent:bob',
    ]);
  });

  it('can exclude self and keep writers only', () => {
    expect(
      agentSubjectsFromRights(rights, {
        exclude: 'did:ad:agent:alice',
        writersOnly: true,
      }),
    ).toEqual([]);
    expect(agentSubjectsFromRights(rights, { writersOnly: true })).toEqual([
      'did:ad:agent:alice',
    ]);
  });
});

describe('mergeAgentIntoRights', () => {
  it('appends without duplicating', () => {
    expect(mergeAgentIntoRights(['a'], 'b')).toEqual(['a', 'b']);
    expect(mergeAgentIntoRights(['a'], 'a')).toEqual(['a']);
    expect(mergeAgentIntoRights(undefined, 'a')).toEqual(['a']);
  });
});

describe('summaries', () => {
  it('previews and truncates message bodies', () => {
    expect(previewMessageBody('  hello   world  ')).toBe('hello world');
    expect(previewMessageBody('x'.repeat(100)).endsWith('…')).toBe(true);
    expect(messageNotificationSummary('Hi there')).toBe(
      'Sent you a message: Hi there',
    );
    expect(accessRequestNotificationSummary('write', 'Secret Doc')).toBe(
      'Requested write access to Secret Doc',
    );
  });
});

describe('dedupe keys', () => {
  it('are stable and typed', () => {
    expect(messageDedupeKey('msg', 'actor', 'me')).toBe('message|msg|actor|me');
    expect(accessRequestDedupeKey('doc', 'actor', 'me', 'write')).toBe(
      'access-request|doc|actor|me|write',
    );
  });
});

describe('isCollaboratorSubject', () => {
  it('rejects the public agent', () => {
    expect(isCollaboratorSubject(PUBLIC)).toBe(false);
    expect(isCollaboratorSubject('did:ad:agent:alice')).toBe(true);
  });
});

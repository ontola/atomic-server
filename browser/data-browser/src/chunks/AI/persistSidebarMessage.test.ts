import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AtomicUIMessage } from './types';
import type { PersistSidebarMessageArgs } from './persistSidebarMessage';

const saved: string[] = [];
const serverPersisted: string[] = [];

vi.mock('./chatConversionUtils', () => ({
  addMessageToChatResource: vi.fn(async (added, chat, _store, opts) => {
    if (opts?.saveChat) saved.push(chat.subject);

    return { subject: `message-${added.role}`, props: { parts: [] } };
  }),
  persistMessageResourceToServer: vi.fn(
    async (resource: { subject: string }) => {
      serverPersisted.push(resource.subject);
    },
  ),
}));

const { persistSidebarMessage } = await import('./persistSidebarMessage');

const NAME = 'https://atomicdata.dev/properties/name';

function fakeChat(name = 'Untitled Chat') {
  const props: Record<string, unknown> = { [NAME]: name };

  return {
    subject: 'chat-1',
    get: (property: string) => props[property],
    set: async (property: string, value: unknown) => {
      props[property] = value;
    },
    save: async () => {
      saved.push('chat-1');
    },
    props,
  };
}

function message(role: 'user' | 'assistant'): AtomicUIMessage {
  return { id: role, role, parts: [] } as unknown as AtomicUIMessage;
}

/** Everything the function needs, with the pieces a test cares about swappable. */
function args(
  chat: ReturnType<typeof fakeChat>,
  overrides: Record<string, unknown> = {},
): PersistSidebarMessageArgs {
  return {
    store: {},
    getOrCreateDraftChatResource: async () => chat,
    isChatSavedRef: { current: false },
    titlePromiseRef: { current: undefined },
    setMessageToResourceMap: () => undefined,
    messageToResourceMapRef: { current: new Map() },
    setIsChatSaved: () => undefined,
    shouldGenerateTitles: true,
    generateTitle: async () => 'A good title',
    ...overrides,
  } as unknown as PersistSidebarMessageArgs;
}

beforeEach(() => {
  saved.length = 0;
  serverPersisted.length = 0;
});

/**
 * A sidebar chat used to live only in memory until the assistant's reply
 * finished. Anything that ended the page in that window — a hot reload, a
 * crash, a closed tab — took the question, the half-written answer and the
 * chat resource with it, and because no resource had ever been created the
 * conversation could not even be found afterwards.
 *
 * These tests are about the write, not the screen. The screen was never the
 * problem: it showed the chat perfectly while nothing was being saved.
 */
describe('persistSidebarMessage', () => {
  it('saves the chat when the question is asked, not when it is answered', async () => {
    const chat = fakeChat();
    const isChatSavedRef = { current: false };

    await persistSidebarMessage({
      ...args(chat, { isChatSavedRef }),
      message: message('user'),
      newMessages: [message('user')],
    });

    // Before any reply exists. This is the whole fix: the model may take
    // minutes, and until now that was minutes of holding the only copy in a
    // JavaScript variable.
    expect(saved).toContain('chat-1');
    expect(isChatSavedRef.current).toBe(true);
  });

  it('pushes the messages to the server before the chat points at them', async () => {
    const chat = fakeChat();
    const pending = new Map([
      [message('user'), { subject: 'message-user', props: { parts: [] } }],
    ]);

    await persistSidebarMessage({
      ...args(chat, { messageToResourceMapRef: { current: pending } }),
      message: message('user'),
      newMessages: [message('user')],
    });

    // A chat that references children the server has not seen is a commit that
    // fails validation and gets dropped.
    expect(serverPersisted).toContain('message-user');
  });

  it('still names the chat, even though it was saved a message earlier', async () => {
    // The trap in this change: titling used to be gated on the chat NOT being
    // saved yet. Finalising on the user's message makes that condition false
    // by the time the reply lands, so a naive fix leaves every chat called
    // "Untitled Chat" for ever.
    const chat = fakeChat();

    await persistSidebarMessage({
      ...args(chat, { isChatSavedRef: { current: true } }),
      message: message('assistant'),
      newMessages: [message('user'), message('assistant')],
    });

    expect(chat.get(NAME)).toBe('A good title');
  });

  it('leaves a chat that already has a name alone', async () => {
    const chat = fakeChat('Something the user typed');

    await persistSidebarMessage({
      ...args(chat, { isChatSavedRef: { current: true } }),
      message: message('assistant'),
      newMessages: [message('user'), message('assistant')],
    });

    expect(chat.get(NAME)).toBe('Something the user typed');
  });

  it('does not name a chat when the user has titles switched off', async () => {
    const chat = fakeChat();

    await persistSidebarMessage({
      ...args(chat, {
        isChatSavedRef: { current: true },
        shouldGenerateTitles: false,
      }),
      message: message('assistant'),
      newMessages: [message('user'), message('assistant')],
    });

    expect(chat.get(NAME)).toBe('Untitled Chat');
  });
});

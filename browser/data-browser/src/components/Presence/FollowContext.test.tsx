// @vitest-environment jsdom
// @wc-ignore-file
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { FollowProvider, useFollow } from './FollowContext';
import { setHostFollow, setHostMeeting } from '../../embed/presenceBridge';

const state = vi.hoisted(() => ({
  embedded: false,
  presence: [] as Array<Record<string, unknown>>,
  navigate: vi.fn(),
  hostFollow: vi.fn(),
  hostUnfollow: vi.fn(),
  hostMeetingStarted: vi.fn(),
  hostMeetingEnded: vi.fn(),
  sendChatMessage: vi.fn(async () => undefined),
  patchLocal: vi.fn(),
  subject: 'did:ad:here' as string | undefined,
}));

const manager = { patchLocal: state.patchLocal };

vi.mock('../../helpers/embedMode', () => ({
  isEmbedded: () => state.embedded,
}));
vi.mock('../../embed/hostActions', () => ({
  hostFollow: (...a: unknown[]) => state.hostFollow(...a),
  hostUnfollow: (...a: unknown[]) => state.hostUnfollow(...a),
  hostMeetingStarted: (...a: unknown[]) => state.hostMeetingStarted(...a),
  hostMeetingEnded: (...a: unknown[]) => state.hostMeetingEnded(...a),
}));
vi.mock('../../hooks/useNavigateWithTransition', () => ({
  useNavigateWithTransition: () => state.navigate,
}));
vi.mock('../../helpers/useCurrentSubject', () => ({
  useCurrentSubject: () => [state.subject],
}));
vi.mock('../../views/ChatRoom/ChatRoomView', () => ({
  sendChatMessage: (...a: unknown[]) =>
    (state.sendChatMessage as (...x: unknown[]) => unknown)(...a),
}));
vi.mock('@tomic/react', async importOriginal => ({
  ...(await importOriginal<typeof import('@tomic/react')>()),
  useStore: () => ({
    getResource: async () => ({
      get: () => undefined,
      set: async () => {},
      save: async () => {},
      title: 'T',
    }),
    newResource: async () => ({
      subject: 'did:ad:meeting',
      save: async () => {},
    }),
  }),
  useDrive: () => ['did:ad:drive'],
  useCurrentAgent: () => [{ subject: 'did:ad:agent:me' }],
  useDrivePresence: () => state.presence,
  useDrivePresenceManager: () => manager,
}));

const leader = 'did:ad:agent:leader';
const probe = vi.hoisted(() => ({
  follow: undefined as unknown as ReturnType<typeof useFollow>,
}));

function Probe({
  onValue,
}: {
  onValue: (v: ReturnType<typeof useFollow>) => void;
}) {
  onValue(useFollow());

  return null;
}

const mount = () =>
  render(
    <FollowProvider>
      <Probe onValue={v => (probe.follow = v)} />
    </FollowProvider>,
  );

beforeEach(() => {
  state.presence = [
    { sessionId: 's1', agent: leader, resource: 'did:ad:there', updatedAt: 1 },
  ];
  state.subject = 'did:ad:here';
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  setHostFollow(null);
  setHostMeeting(null);
  state.embedded = false;
  vi.clearAllMocks();
});

it('on the web: follows locally and navigates to the leader', () => {
  mount();
  act(() => probe.follow.follow(leader));

  expect(probe.follow.followedAgent).toBe(leader);
  expect(state.navigate).toHaveBeenCalledTimes(1);
  expect(state.hostFollow).not.toHaveBeenCalled();

  act(() => probe.follow.unfollow());
  expect(probe.follow.followedAgent).toBeUndefined();
  expect(state.hostUnfollow).not.toHaveBeenCalled();
});

it('embedded: follow and unfollow go to the app, the page does not navigate', () => {
  state.embedded = true;
  mount();

  act(() => probe.follow.follow(leader));
  expect(state.hostFollow).toHaveBeenCalledWith(leader);
  // Until the app says so, nobody is followed.
  expect(probe.follow.followedAgent).toBeUndefined();

  act(() => setHostFollow(leader));
  expect(probe.follow.followedAgent).toBe(leader);
  expect(probe.follow.followedResource).toBe('did:ad:there');
  expect(state.navigate).not.toHaveBeenCalled();

  act(() => probe.follow.unfollow());
  expect(state.hostUnfollow).toHaveBeenCalledOnce();
  expect(probe.follow.followedAgent).toBe(leader);

  act(() => setHostFollow(null));
  expect(probe.follow.followedAgent).toBeUndefined();
});

it('embedded: asks the app to stop when the leader opts out of followers', () => {
  state.embedded = true;
  state.presence = [
    {
      sessionId: 's1',
      agent: leader,
      resource: 'did:ad:there',
      allowFollow: false,
    },
  ];
  mount();

  act(() => setHostFollow(leader));
  expect(state.hostUnfollow).toHaveBeenCalled();
});

it('embedded: a leader missing from the list is the app’s to handle', () => {
  state.embedded = true;
  state.presence = [];
  mount();

  act(() => setHostFollow(leader));
  expect(state.hostUnfollow).not.toHaveBeenCalled();
  expect(probe.follow.followedAgent).toBe(leader);
});

it('posts the Viewing trail from the page on the web, not when embedded', async () => {
  for (const embedded of [false, true]) {
    state.embedded = embedded;
    state.sendChatMessage.mockClear();
    sessionStorage.setItem(
      'atomic.activeMeeting:did:ad:drive',
      'did:ad:meeting',
    );
    const view = mount();

    await act(async () => undefined);
    expect(state.sendChatMessage).toHaveBeenCalledTimes(embedded ? 0 : 1);
    view.unmount();
  }
});

it('on the web: mirrors the meeting it leads into the presence entry', () => {
  sessionStorage.setItem('atomic.activeMeeting:did:ad:drive', 'did:ad:meeting');
  mount();

  expect(state.patchLocal).toHaveBeenLastCalledWith(
    expect.objectContaining({ session: 'did:ad:meeting' }),
  );
});

it('embedded: the active meeting is the app’s, not sessionStorage', () => {
  state.embedded = true;
  sessionStorage.setItem('atomic.activeMeeting:did:ad:drive', 'did:ad:stale');
  mount();
  expect(probe.follow.activeMeeting).toBeUndefined();

  act(() => setHostMeeting('did:ad:meeting'));
  expect(probe.follow.activeMeeting).toBe('did:ad:meeting');
  expect(state.patchLocal).toHaveBeenLastCalledWith(
    expect.objectContaining({ session: 'did:ad:meeting' }),
  );

  act(() => setHostMeeting(null));
  expect(probe.follow.activeMeeting).toBeUndefined();
});

it('embedded: starting and ending a meeting tell the app', async () => {
  state.embedded = true;
  mount();

  await act(async () => {
    await probe.follow.startMeeting(undefined, 'did:ad:meeting');
  });
  expect(state.hostMeetingStarted).toHaveBeenCalledWith('did:ad:meeting');
  // Shown at once, before the app has pushed it back.
  expect(probe.follow.activeMeeting).toBe('did:ad:meeting');
  expect(sessionStorage.getItem('atomic.activeMeeting:did:ad:drive')).toBe(
    null,
  );

  await act(async () => {
    await probe.follow.endMeeting();
  });
  expect(state.hostMeetingEnded).toHaveBeenCalledWith('did:ad:meeting');
  expect(probe.follow.activeMeeting).toBeUndefined();
});

it('on the web: starting a meeting stays in the tab, the app is not told', async () => {
  mount();

  await act(async () => {
    await probe.follow.startMeeting(undefined, 'did:ad:meeting');
  });
  expect(state.hostMeetingStarted).not.toHaveBeenCalled();
  expect(sessionStorage.getItem('atomic.activeMeeting:did:ad:drive')).toBe(
    'did:ad:meeting',
  );
});

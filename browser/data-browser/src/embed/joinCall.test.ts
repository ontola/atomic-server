// @wc-ignore-file
import { afterEach, expect, it, vi } from 'vitest';
import { setActionsHost } from './hostActions';
import { startHostCall } from './joinCall';

afterEach(() => setActionsHost(undefined));

const base = {
  meeting: 'did:ad:meeting',
  leader: 'did:ad:agent:leader',
  leading: false,
  followed: undefined as string | undefined,
};

it('places the call and joins the meeting by following its leader', async () => {
  const call = vi.fn().mockResolvedValue(true);
  const follow = vi.fn();

  setActionsHost({ call });
  expect(await startHostCall({ ...base, follow })).toBe(true);
  expect(call).toHaveBeenCalledWith('joinCall', ['did:ad:meeting']);
  expect(follow).toHaveBeenCalledWith('did:ad:agent:leader');
});

it('does not follow again when already in the meeting or leading it', async () => {
  setActionsHost({ call: vi.fn().mockResolvedValue(true) });
  const follow = vi.fn();

  await startHostCall({ ...base, followed: base.leader, follow });
  await startHostCall({ ...base, leading: true, follow });
  expect(follow).not.toHaveBeenCalled();
});

it('joins nothing when the app cannot place the call', async () => {
  setActionsHost({ call: vi.fn().mockResolvedValue(false) });
  const follow = vi.fn();

  expect(await startHostCall({ ...base, follow })).toBe(false);
  expect(follow).not.toHaveBeenCalled();
});

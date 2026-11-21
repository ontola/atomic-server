// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import toast from 'react-hot-toast';
import { copyInviteLink } from './copyInviteLink';

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

function setClipboard(writeText: (t: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
  });
}

describe('copyInviteLink', () => {
  afterEach(() => vi.clearAllMocks());

  it('records the invite after a successful copy', async () => {
    setClipboard(vi.fn().mockResolvedValue(undefined));
    const onCopied = vi.fn().mockResolvedValue(undefined);
    const create = vi.fn().mockResolvedValue('https://x/invite');

    await expect(
      copyInviteLink(create, 'read', undefined, onCopied),
    ).resolves.toBe('https://x/invite');
    expect(toast.success).toHaveBeenCalledWith('Invite link copied');
    expect(onCopied).toHaveBeenCalledWith('read');
  });

  it('still records the invite when the clipboard write is denied', async () => {
    setClipboard(vi.fn().mockRejectedValue(new Error('NotAllowedError')));
    const onCopied = vi.fn().mockResolvedValue(undefined);
    const create = vi.fn().mockResolvedValue('https://x/invite');

    await copyInviteLink(create, 'write', undefined, onCopied);
    expect(toast.error).toHaveBeenCalledWith(
      'Could not copy the link. Select it and copy it by hand.',
    );
    expect(toast.success).not.toHaveBeenCalled();
    expect(onCopied).toHaveBeenCalledWith('write');
  });

  it('does not record when no link could be created', async () => {
    setClipboard(vi.fn().mockResolvedValue(undefined));
    const onCopied = vi.fn();
    const create = vi.fn().mockRejectedValue(new Error('nope'));

    await expect(
      copyInviteLink(create, 'read', undefined, onCopied),
    ).rejects.toThrow('nope');
    expect(onCopied).not.toHaveBeenCalled();
  });
});

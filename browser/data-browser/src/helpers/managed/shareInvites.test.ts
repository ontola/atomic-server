import { expect, it, vi } from 'vitest';
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('./api', () => ({ managedFetch: fetchMock }));
import { sendShareInvites } from './shareInvites';

const request = {
  emails: ['marit@example.com'],
  link: 'https://node.example/app/invite?token=abc',
  title: 'Q3 Planning',
  write: true,
  inviterName: 'Joep',
  message: '',
};

it('posts the invite with the control plane field names', async () => {
  fetchMock.mockResolvedValueOnce(Response.json({ sent: 1 }));
  await sendShareInvites(request);
  const [path, init] = fetchMock.mock.calls[0];
  expect(path).toBe('/share/invitations');
  expect(init.method).toBe('POST');
  // An empty message is left out rather than sent as a blank quote.
  expect(JSON.parse(init.body)).toEqual({
    emails: ['marit@example.com'],
    link: request.link,
    title: 'Q3 Planning',
    write: true,
    inviter_name: 'Joep',
  });
});

it('shows the reason the control plane gives', async () => {
  fetchMock.mockResolvedValueOnce(
    Response.json({ error: 'The invite link is not valid' }, { status: 400 }),
  );
  await expect(sendShareInvites(request)).rejects.toThrow(
    'The invite link is not valid',
  );
});

it('points at the invite link when the hourly budget is used up', async () => {
  fetchMock.mockResolvedValueOnce(new Response(null, { status: 429 }));
  await expect(sendShareInvites(request)).rejects.toThrow(/copy the invite/);
});

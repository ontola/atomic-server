import { describe, it, expect, vi, beforeEach } from 'vitest';

const managedFetch = vi.fn();
vi.mock('./api', () => ({
  managedFetch: (...a: unknown[]) => managedFetch(...a),
  getManagedApiBase: () => 'https://portal.example/api',
}));
vi.mock('./session', () => ({ getManagedAccount: async () => null }));
vi.mock('./binding', () => ({ writeManagedAccountBinding: () => undefined }));

const { createManagedSyncEnrollment } = await import('./enrollment');

beforeEach(() => {
  managedFetch.mockReset();
});

const failWith = (status: number, body: unknown) =>
  managedFetch.mockResolvedValue({
    ok: false,
    status,
    json: async () => body,
  });

const enroll = () =>
  createManagedSyncEnrollment({
    driveSubject: 'did:ad:drive',
    agentSubject: 'did:ad:agent:x',
  });

/**
 * Every one of these used to raise the same sentence, which is how a full
 * fleet in production read as a mysterious backup failure with no next step.
 */
describe('createManagedSyncEnrollment failures', () => {
  it('passes on the reason the server gave, with the upgrade link', async () => {
    failWith(402, {
      error: 'Cloud Server requires a subscription',
      upgrade_url: 'https://portal.example/billing',
    });

    await expect(enroll()).rejects.toThrow(
      /Cloud Server requires a subscription.*portal\.example\/billing/,
    );
  });

  /** Actionable, and distinct from "we are broken". */
  it('says the session lapsed on a 401', async () => {
    failWith(401, { error: 'No session' });
    await expect(enroll()).rejects.toThrow(/session expired/i);
  });

  /**
   * A 500 here is nearly always no node with free capacity, and the body says
   * only "Internal Server Error" — so the message must not simply repeat it.
   */
  it('explains a 500 as capacity rather than parroting the body', async () => {
    failWith(500, { error: 'Internal Server Error' });

    const error = await enroll().catch(e => e as Error);
    expect(error.message).toMatch(/capacity/i);
    expect(error.message).not.toMatch(/Internal Server Error/);
  });

  /** A body-less failure still has to name something. */
  it('falls back to the status when there is no body', async () => {
    managedFetch.mockResolvedValue({
      ok: false,
      status: 418,
      json: async () => {
        throw new Error('not json');
      },
    });

    await expect(enroll()).rejects.toThrow(/418/);
  });
});

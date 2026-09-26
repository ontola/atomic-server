// @wc-ignore-file
import { beforeEach, expect, it, vi } from 'vitest';
import {
  buildEnvelopeWithAssisted,
  decryptEnvelopeWithAssisted,
  FreshSignInRequiredError,
  hasAssistedWrapper,
  type RecoverySecret,
} from './recovery';
import { getManagedAccount } from './session';
import { managedFetch, getManagedApiBase } from './api';

vi.mock('./session', () => ({ getManagedAccount: vi.fn() }));
vi.mock('./api', () => ({ managedFetch: vi.fn(), getManagedApiBase: vi.fn() }));

const AGENT = 'atomic:agent:9Hc-J_2n4jIpXqzTZMDSnNFOFB1fWqCsGSk3Wdyy9Bs';

/** A stand-in for the account service: a key per (agent, salt), like the real
 * HMAC, and a switch for a sign-in that is too old to unlock with. */
function fakeService({ fresh }: { fresh: boolean }) {
  const keys = new Map<string, string>();
  const seenSalts: string[] = [];

  vi.mocked(managedFetch).mockImplementation(async (path, init) => {
    if (path === '/auth/providers') {
      return Response.json({ google: true, assisted_recovery: true });
    }

    if (path === '/recovery-secret/assisted-key') {
      const { agent_subject, salt } = JSON.parse(String(init?.body));
      const unlocking = seenSalts.includes(salt);

      if (unlocking && !fresh) {
        return Response.json(
          { error: 'Sign in again', error_code: 'fresh_sign_in_required' },
          { status: 403 },
        );
      }

      seenSalts.push(salt);
      const id = `${agent_subject}|${salt}`;

      if (!keys.has(id)) {
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        keys.set(id, btoa(String.fromCharCode(...bytes)));
      }

      return Response.json({ key: keys.get(id) });
    }

    return new Response(null, { status: 404 });
  });
}

function stored(
  request: Awaited<ReturnType<typeof buildEnvelopeWithAssisted>>,
) {
  return {
    ...request,
    owner_email: 'person@example.com',
    kdf_algorithm: '',
    kdf_params: {},
    salt: '',
    wrappers: request.wrappers!.map(w => ({ ...w, created_at: 0 })),
    created_at: 0,
    updated_at: 0,
  } as RecoverySecret;
}

beforeEach(() => {
  vi.mocked(getManagedAccount).mockResolvedValue({
    email: 'person@example.com',
  });
  vi.mocked(getManagedApiBase).mockReturnValue('https://portal.example/api');
  vi.mocked(managedFetch).mockReset();
});

it('a backup made for the account opens with the account alone', async () => {
  fakeService({ fresh: true });
  const request = await buildEnvelopeWithAssisted({
    secret: 'the-agent-secret',
    agentSubject: AGENT,
  });

  expect(request.wrappers).toHaveLength(1);
  expect(request.wrappers![0].wrapper_type).toBe('atomic-assisted');
  // The DEK and the secret never go to the service.
  const sent = vi
    .mocked(managedFetch)
    .mock.calls.map(([, init]) => String(init?.body ?? ''))
    .join('\n');
  expect(sent).not.toContain('the-agent-secret');

  const backup = stored(request);
  expect(hasAssistedWrapper(backup)).toBe(true);
  expect(await decryptEnvelopeWithAssisted(backup)).toBe('the-agent-secret');
});

it('an old sign-in is told to sign in again', async () => {
  fakeService({ fresh: false });
  const backup = stored(
    await buildEnvelopeWithAssisted({ secret: 's', agentSubject: AGENT }),
  );

  await expect(decryptEnvelopeWithAssisted(backup)).rejects.toBeInstanceOf(
    FreshSignInRequiredError,
  );
});

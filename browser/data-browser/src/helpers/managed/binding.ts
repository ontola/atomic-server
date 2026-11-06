// [RECOVERY-RECONSTRUCTED] `helpers/managed/binding.ts` was never captured in any
// transcript. Reconstructed from its call sites:
//   - recovery.ts / enrollment.ts: writeManagedAccountBinding(ownerEmail, agentSubject)
//   - reconcile.ts: readManagedAccountBinding() -> { owner_email, expected_agent_subject }
//                   clearManagedAccountBinding()
// It records, per signed-in Managed account, which local Atomic agent that
// account expects — so the identity-reconcile gate can detect a device whose
// local agent drifted from the managed account's agent. Stored in localStorage.

const BINDING_KEY = 'atomic-managed-account-binding';

const listeners = new Set<() => void>();

/** Runs when this tab writes or clears the binding, so a screen can follow it. */
export function onManagedBindingChanged(listener: () => void): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

const notify = () => listeners.forEach(listener => listener());

// The email link opens in another tab, and that tab's identity gate is the one
// that writes the binding. localStorage tells the other tabs with a `storage`
// event (never the writing tab), so follow it: without this a tab that waited
// for the sign-in kept showing "Only saved on this device".
if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.key === null || event.key === BINDING_KEY) notify();
  });
}

export type ManagedAccountBinding = {
  owner_email: string;
  expected_agent_subject: string;
};

export function writeManagedAccountBinding(
  ownerEmail: string,
  expectedAgentSubject: string,
): void {
  if (typeof localStorage === 'undefined') return;
  if (!ownerEmail || !expectedAgentSubject) return;

  try {
    localStorage.setItem(
      BINDING_KEY,
      JSON.stringify({
        owner_email: ownerEmail,
        expected_agent_subject: expectedAgentSubject,
      } satisfies ManagedAccountBinding),
    );
    notify();
  } catch {
    // Ignore quota / private-mode failures — the binding is an optimization.
  }
}

export function readManagedAccountBinding(): ManagedAccountBinding | null {
  if (typeof localStorage === 'undefined') return null;

  try {
    const raw = localStorage.getItem(BINDING_KEY);

    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<ManagedAccountBinding>;

    if (
      typeof parsed?.owner_email === 'string' &&
      typeof parsed?.expected_agent_subject === 'string'
    ) {
      return {
        owner_email: parsed.owner_email,
        expected_agent_subject: parsed.expected_agent_subject,
      };
    }

    return null;
  } catch {
    return null;
  }
}

export function clearManagedAccountBinding(): void {
  if (typeof localStorage === 'undefined') return;

  try {
    localStorage.removeItem(BINDING_KEY);
    notify();
  } catch {
    // ignore
  }
}

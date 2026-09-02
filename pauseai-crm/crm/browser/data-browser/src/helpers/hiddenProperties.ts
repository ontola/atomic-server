import { GENESIS } from '@tomic/react';

/**
 * Server-managed, immutable properties that must never be shown in a resource
 * form or edited by hand.
 *
 * The genesis certificate is set once at creation and is what verifies the
 * resource's DID; letting a user change it would break that proof. The server
 * rejects such edits anyway — this list keeps the UI from ever offering them.
 */
export const NEVER_EDITABLE_PROPS: readonly string[] = [GENESIS];

/** Whether a property is hidden from every resource form and cannot be edited. */
export const isNeverEditableProp = (prop: string): boolean =>
  NEVER_EDITABLE_PROPS.includes(prop);

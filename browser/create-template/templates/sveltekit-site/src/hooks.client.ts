import type { HandleClientError } from '@sveltejs/kit';
import { RequestCancelledError } from '@tomic/lib';

export const handleError: HandleClientError = ({ error }) => {
	// Leaving a page cancels whatever the store was still fetching for it, and
	// a `load` awaiting that fetch then rejects with `RequestCancelledError`.
	// Nothing went wrong: the answer was for a document that no longer exists.
	// SvelteKit's default `handleError` logs every `load` rejection, so without
	// this the console fills with cancellations on ordinary navigation away, and
	// the e2e suite counted one as a real error (develop run 4660, apply
	// sveltekit template).
	if (error instanceof RequestCancelledError) {
		return;
	}

	console.error(error);

	return { message: 'Internal Error' };
};

import {
  isNotAvailableLocally,
  isNotFound,
  isTransportError,
  isUnauthorized,
} from '@tomic/lib';

/** A missing local copy is not evidence that the drive or server is gone. */
export function driveListStatus(
  error?: Error,
  loading?: boolean,
): string | undefined {
  if (error) {
    if (isNotAvailableLocally(error)) return 'Not on this device yet';
    if (isUnauthorized(error)) return 'No access with this identity';
    if (isNotFound(error)) return 'Drive not found at this address';
    if (isTransportError(error)) return 'Server unavailable';

    return 'Could not load this drive';
  }

  if (loading) return 'Loading drive…';
}

import { describe, it } from 'vitest';
import { AtomicError, ErrorType } from './error.js';

describe('AtomicError code (F5: planning/unified-sync.md)', () => {
  it('takes an explicit code over anything parsed from the message (WS path)', ({
    expect,
  }) => {
    const err = new AtomicError('No write right', ErrorType.Server, 3);
    expect(err.code).toBe(3);
    expect(err.message).toBe('No write right');
  });

  it('extracts errorCode from a JSON-AD error body (HTTP path)', ({
    expect,
  }) => {
    const body = JSON.stringify({
      'https://atomicdata.dev/properties/description': 'No write right',
      'https://atomicdata.dev/properties/errorCode': 3,
    });
    const err = new AtomicError(body, ErrorType.Server);
    expect(err.code).toBe(3);
    expect(err.message).toBe('No write right');
  });

  it('leaves code undefined when the body has none (older server)', ({
    expect,
  }) => {
    const body = JSON.stringify({
      'https://atomicdata.dev/properties/description': 'Something broke',
    });
    const err = new AtomicError(body, ErrorType.Server);
    expect(err.code).toBeUndefined();
  });

  it('leaves code undefined for a plain non-JSON message', ({ expect }) => {
    const err = new AtomicError('plain text error', ErrorType.Server);
    expect(err.code).toBeUndefined();
    expect(err.message).toBe('plain text error');
  });
});

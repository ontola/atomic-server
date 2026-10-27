import { describe, expect, it } from 'vitest';
import { isLoopbackHost } from './loopback.js';

describe('isLoopbackHost', () => {
  it.each(['localhost', '127.0.0.1', '[::1]', '::1'])(
    'recognizes %s',
    hostname => expect(isLoopbackHost(hostname)).toBe(true),
  );

  it.each(['localhost.example', '127.0.0.1.example', 'example.com', ''])(
    'refuses %s',
    hostname => expect(isLoopbackHost(hostname)).toBe(false),
  );
});

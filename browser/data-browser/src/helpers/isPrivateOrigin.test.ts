import { describe, expect, it } from 'vitest';
import { isPrivateOrigin } from './isPrivateOrigin';

describe('isPrivateOrigin', () => {
  it.each([
    'http://localhost',
    'http://localhost:9883',
    'http://127.0.0.1:9883',
    'http://[::1]:9883',
    'http://10.0.0.5',
    'http://172.16.3.4',
    'http://172.31.255.1',
    'http://192.168.1.20:9883',
    'http://169.254.1.1',
  ])('treats %s as private', url => {
    expect(isPrivateOrigin(url)).toBe(true);
  });

  it.each([
    'https://example.com',
    'http://example.com',
    'https://atomic.place',
    'http://172.32.0.1',
    'http://8.8.8.8',
    'not a url',
    '',
    undefined,
  ])('treats %s as reachable', url => {
    expect(isPrivateOrigin(url)).toBe(false);
  });
});

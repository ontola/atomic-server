import { describe, expect, it } from 'vitest';
import {
  asSubject,
  InvalidSubjectError,
  isDidSubject,
  isHttpSubject,
  isValidSubject,
  tryAsSubject,
  type Subject,
} from './subject.js';

describe('subject', () => {
  describe('isValidSubject', () => {
    it('accepts DID subjects', () => {
      expect(isValidSubject('did:ad:abc')).toBe(true);
    });

    it('accepts http(s) URL subjects', () => {
      expect(isValidSubject('https://atomicdata.dev/things/1')).toBe(true);
      expect(isValidSubject('http://localhost:9883/foo')).toBe(true);
    });

    it('rejects empty strings, relative paths, and other prefixes', () => {
      expect(isValidSubject('')).toBe(false);
      expect(isValidSubject('/things/1')).toBe(false);
      expect(isValidSubject('did:web:example.com')).toBe(false);
      expect(isValidSubject('ftp://example.com')).toBe(false);
    });
  });

  describe('asSubject', () => {
    it('brands a valid subject and round-trips its string value', () => {
      const s: Subject = asSubject('did:ad:abc');
      expect(s).toBe('did:ad:abc');
    });

    it('throws InvalidSubjectError on a malformed input', () => {
      expect(() => asSubject('nope')).toThrow(InvalidSubjectError);
    });
  });

  describe('tryAsSubject', () => {
    it('returns the branded subject when valid', () => {
      expect(tryAsSubject('https://atomicdata.dev/x')).toBe(
        'https://atomicdata.dev/x',
      );
    });

    it('returns undefined when invalid', () => {
      expect(tryAsSubject('nope')).toBeUndefined();
    });
  });

  describe('isDidSubject / isHttpSubject', () => {
    it('discriminates DIDs from HTTP URLs', () => {
      const did = asSubject('did:ad:abc');
      const http = asSubject('https://atomicdata.dev/things/1');

      expect(isDidSubject(did)).toBe(true);
      expect(isHttpSubject(did)).toBe(false);
      expect(isDidSubject(http)).toBe(false);
      expect(isHttpSubject(http)).toBe(true);
    });
  });
});

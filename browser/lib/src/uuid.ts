/**
 * `crypto.randomUUID` exists only in secure contexts (https or localhost). Over
 * plain http on another origin, such as `http://homeassistant.local:9883`, it is
 * undefined and calling it throws. `crypto.getRandomValues` is available
 * everywhere, so build the RFC 4122 version 4 UUID from that.
 */
export function randomUUID(): string {
  const c: Crypto | undefined = globalThis.crypto;

  if (typeof c?.randomUUID === 'function') {
    return c.randomUUID();
  }

  return generateV4();
}

function generateV4(): string {
  const c: Crypto | undefined = globalThis.crypto;
  const bytes = new Uint8Array(16);

  if (typeof c?.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  } else {
    // No Web Crypto at all. Ids here only need to be unique, not secret.
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10

  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0'));

  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-');
}

/**
 * Put `randomUUID` on `crypto` when the browser withholds it, so code that
 * calls `crypto.randomUUID()` directly keeps working. Run it before the app.
 */
export function installRandomUUIDPolyfill(): void {
  const c = globalThis.crypto as Crypto | undefined;

  if (!c || typeof c.randomUUID === 'function') return;

  try {
    Object.defineProperty(c, 'randomUUID', {
      value: generateV4,
      configurable: true,
      writable: true,
    });
  } catch {
    // Frozen crypto object: callers of the helper still work.
  }
}

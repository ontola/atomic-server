export function decodeB64(base64: string): Uint8Array {
  // 1. Node.js (via Buffer)
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    // Buffer.from returns a Buffer, which extends Uint8Array.
    return Buffer.from(base64, 'base64');
  }

  // 2. Browser (via atob)
  if (typeof atob === 'function') {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);

    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    return bytes;
  }

  throw new Error('Base64 decoding not supported in this environment.');
}

export function encodeB64(bytes: Uint8Array): string {
  // 1. Node.js (via Buffer)
  if (typeof Buffer !== 'undefined' && typeof Buffer.from === 'function') {
    return Buffer.from(bytes).toString('base64');
  }

  // 2. Browser (via btoa)
  if (typeof btoa === 'function') {
    // Convert Uint8Array to binary string
    let binaryString = '';

    for (let i = 0; i < bytes.length; i++) {
      binaryString += String.fromCharCode(bytes[i]);
    }

    return btoa(binaryString);
  }

  throw new Error('Base64 encoding not supported in this environment.');
}

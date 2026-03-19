import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { sha256 } from '@noble/hashes/sha256';
import App from './App';

/**
 * Polyfill for crypto.subtle.digest in non-secure contexts (e.g., local IPs).
 * Some dependencies like @openrouter/sdk and hashery use this, but browsers
 * disable it on anything but localhost/HTTPS.
 */
if (typeof window !== 'undefined' && (!window.crypto || !window.crypto.subtle || !window.crypto.subtle.digest)) {
  console.warn('Atomic Server: Providing a polyfill for crypto.subtle.digest in an insecure context.');
  
  // Ensure the object hierarchy exists
  if (!window.crypto) {
    // @ts-ignore
    window.crypto = {};
  }
  if (!window.crypto.subtle) {
    // @ts-ignore
    window.crypto.subtle = {};
  }

  // Only patch if missing (though the outer IF already checks this)
  if (!window.crypto.subtle.digest) {
    window.crypto.subtle.digest = async (algorithm, data) => {
      const algoStr = typeof algorithm === 'string' ? algorithm.toUpperCase() : (algorithm as any).name.toUpperCase();
      
      if (algoStr === 'SHA-256' || algoStr === 'SHA256') {
        const input = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
        const hash = sha256(input);
        return hash.buffer;
      }

      throw new Error(`Polyfill: Unsupported hash algorithm: ${algoStr}. Only SHA-256 is supported in this context.`);
    };
  }
}

const root = createRoot(document.getElementById('root')!);
root.render(
  <StrictMode>
    <App />
  </StrictMode>,
);

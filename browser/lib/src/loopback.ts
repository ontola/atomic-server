/** Loopback hostnames, accepting IPv6 with or without URL brackets. */
export function isLoopbackHost(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
}

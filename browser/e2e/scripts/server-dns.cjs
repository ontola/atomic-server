// Keep the public server URL intact for signatures and resource identities.
// Dagger's service hostname is only a DNS transport detail. Chromium has its
// own host-resolver rule; Node and generated template processes need this one.
const dns = require('node:dns');
const { syncBuiltinESMExports } = require('node:module');

if (process.env.SERVER_URL && process.env.ATOMIC_SERVICE_URL) {
  const publicHost = new URL(process.env.SERVER_URL).hostname;
  const serviceHost = new URL(process.env.ATOMIC_SERVICE_URL).hostname;

  if (publicHost !== serviceHost) {
    const lookup = dns.lookup;
    const lookupPromise = dns.promises.lookup;
    const resolveHost = hostname =>
      hostname === publicHost ? serviceHost : hostname;

    dns.lookup = (hostname, ...args) => lookup(resolveHost(hostname), ...args);
    dns.promises.lookup = (hostname, ...args) =>
      lookupPromise(resolveHost(hostname), ...args);
    syncBuiltinESMExports();
  }
}

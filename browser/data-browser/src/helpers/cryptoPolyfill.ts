// Imported first in index.tsx, before any app code runs. Over plain http on a
// non-localhost origin the browser withholds `crypto.randomUUID`, and the first
// call used to throw while booting, leaving the splash up for good.
import { installRandomUUIDPolyfill } from '@tomic/lib';

installRandomUUIDPolyfill();

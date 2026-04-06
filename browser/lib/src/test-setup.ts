import { enableLoro } from './loro-loader.js';

// Loro is the default CRDT engine — initialize it before all tests.
await enableLoro();

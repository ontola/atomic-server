
/* -----------------------------------
* GENERATED WITH @tomic/cli
* -------------------------------- */

import { registerOntologies } from '@tomic/lib';

import { learningRust } from './learningRust.js';

export function initOntologies(): void {
  registerOntologies(learningRust);
}

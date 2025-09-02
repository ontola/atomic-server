/* -----------------------------------
 * GENERATED WITH @tomic/cli
 * -------------------------------- */

import { registerOntologies } from '@tomic/lib';

import { dataBrowser } from './dataBrowser.js';

export function initOntologies(): void {
  registerOntologies(dataBrowser);
}

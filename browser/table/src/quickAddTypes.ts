import type { RowActionKind } from './rowActionTypes.js';

export type { RowActionKind } from './rowActionTypes.js';

/** One value a new row starts with, using the existing row-action vocabulary. */
export interface QuickAddPreset {
  kind: RowActionKind;
  property: string;
  value?: string | number;
}
/** A configured create button, with an optional input and initial row values. */
export interface QuickAddSpec {
  /** What the button says. */
  label: string;
  /** A property to type into first; absent means create without an input. */
  field?: string;
  /** Placeholder for that field. */
  placeholder?: string;
  /** Values every new row starts with. */
  presets?: QuickAddPreset[];
}

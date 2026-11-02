export type JSONValue =
  | string
  | number
  | boolean
  | undefined
  | { [key: string]: JSONValue }
  | JSONValue[];

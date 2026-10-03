// @vitest-environment jsdom
// @wc-ignore-file
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { JSONSchema7 } from 'ai';
import { useInstallationConfigSchema } from './useInstallationConfigSchema';

afterEach(cleanup);

const schema: JSONSchema7 = {
  type: 'object',
  properties: { folderPrefix: { type: 'string' } },
};
const initialProps = {
  subject: 'did:ad:installation',
  release: 'release-1',
  schema: schema as JSONSchema7 | undefined,
};

it('retains validation after a save receipt omits computed release metadata', () => {
  const { result, rerender } = renderHook(
    props =>
      useInstallationConfigSchema(props.subject, props.release, props.schema),
    { initialProps },
  );
  expect(result.current).toEqual(schema);
  rerender({ ...initialProps, schema: undefined });
  expect(result.current).toEqual(schema);
});

it('does not reuse the old schema for a different release or installation', () => {
  const { result, rerender } = renderHook(
    props =>
      useInstallationConfigSchema(props.subject, props.release, props.schema),
    { initialProps },
  );
  rerender({ ...initialProps, release: 'release-2', schema: undefined });
  expect(result.current).toBeUndefined();
  const replacement: JSONSchema7 = { type: 'number' };
  rerender({ ...initialProps, release: 'release-2', schema: replacement });
  expect(result.current).toEqual(replacement);
  rerender({
    ...initialProps,
    subject: 'did:ad:another-installation',
    release: 'release-2',
    schema: undefined,
  });
  expect(result.current).toBeUndefined();
});

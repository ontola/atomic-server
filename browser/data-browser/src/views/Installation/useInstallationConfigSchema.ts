import { useState } from 'react';
import type { JSONSchema7 } from 'ai';

/** Installation schemas are release metadata, absent from commit snapshots. */
export function useInstallationConfigSchema(
  subject: string,
  release: string | undefined,
  schema: JSONSchema7 | undefined,
) {
  const [last, setLast] = useState({ subject, release, schema });
  const sameRelease = last.subject === subject && last.release === release;

  if (!sameRelease || (schema !== undefined && schema !== last.schema)) {
    setLast({ subject, release, schema });
  }

  return schema ?? (sameRelease ? last.schema : undefined);
}

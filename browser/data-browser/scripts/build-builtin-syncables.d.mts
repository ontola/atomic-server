import type { BuildResult } from 'esbuild';

export function bundleBuiltinSyncables(): Promise<
  BuildResult<{ write: false; metafile: true }>
>;

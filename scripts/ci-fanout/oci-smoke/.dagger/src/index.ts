import { dag, object, func, argument, File, Directory } from '@dagger.io/dagger';

@object()
export class OciSmoke {
  /** Small client with a pnpm-style symlink, rootfs CLI, and disposable caches. */
  @func()
  prepare(): Directory {
    const image = dag.container()
      .from('node:22')
      .withMountedCache('/cache', dag.cacheVolume('oci-smoke-disposable'))
      .withEnvVariable('PATH', '/app/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin')
      .withExec(['sh', '-ec',
        'mkdir -p /app/node_modules/.pnpm/probe /app/bin; ' +
        'printf "module.exports = \'portable-symlink-ok\';\\n" > /app/node_modules/.pnpm/probe/index.js; ' +
        'ln -s .pnpm/probe /app/node_modules/probe; ' +
        'printf "#!/bin/sh\\nexec node /app/check.cjs\\n" > /app/bin/portable-cli; ' +
        'chmod 755 /app/bin/portable-cli; ' +
        'printf "const fs = require(\'node:fs\'); if (fs.existsSync(\'/cache/marker\')) throw new Error(\'cache leaked\'); console.log(require(\'probe\'));\\n" > /app/check.cjs; ' +
        'printf cache-must-not-export > /cache/marker',
      ])
      .withWorkdir('/app')
      .withoutMount('/cache');
    return dag.directory().withFile('client.oci.tar', image.asTarball());
  }

  @func()
  async verify(@argument() archive: File): Promise<string> {
    const client = dag.container().import_(archive);
    if (String(await client.platform()) !== 'linux/amd64') {
      throw new Error('Expected linux/amd64 fixture');
    }
    const output = await client.withExec(['portable-cli']).stdout();
    if (output.trim() !== 'portable-symlink-ok') {
      throw new Error('OCI rootfs tool or workspace symlink did not survive');
    }
    return 'independent-engine OCI import, rootfs CLI and symlink passed; cache excluded';
  }
}

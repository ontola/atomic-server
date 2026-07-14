/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep Loro outside the server bundle so Node resolves the package's
  // `main` entry, which loads the wasm binary from disk. The browser bundle
  // continues to use Loro's web build through @tomic/lib's lazy loader.
  serverExternalPackages: ['loro-crdt'],
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals.push({
        'loro-crdt': 'commonjs loro-crdt',
      });
    }

    // Loro's browser build initializes its wasm-bindgen module itself via
    // `new URL(..., import.meta.url)`. Emit the binary as an asset instead of
    // asking webpack to interpret its internal `wbg` imports.
    config.module.rules.push({
      test: /\.wasm$/,
      type: 'asset/resource',
    });
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
    };

    return config;
  },
};

export default nextConfig;

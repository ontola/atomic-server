import type { UserConfig } from 'vite';
import solid from 'vite-plugin-solid';
import path from 'node:path';
import 'dotenv/config';

const PLUGIN_NAME = 'ontola.test-plugin';
const isDev = process.env.NODE_ENV === 'development';
const filePrefix = isDev ? `${PLUGIN_NAME}.` : '';

export default {
  plugins: [solid()],
  build: {
    assetsDir: '',
    rolldownOptions: {
      output: {
        // Plugins require a single js file so we can't do any code splitting.
        codeSplitting: false,
        assetFileNames: `${filePrefix}ui.[ext]`,
        entryFileNames: `${filePrefix}ui.js`,
      },
    },

    emptyOutDir: false,
    ...(isDev
      ? {
          // In development we build directly into the installed plugin directory so you only have to refresh the page to see changes.
          outDir: path.resolve(process.env.DEV_PLUGIN_INSTALL_DIR!),
        }
      : {}),
  },
} satisfies UserConfig;

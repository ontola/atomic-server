// @ts-check
import { adapter as jsx } from '@wuchale/jsx';
import { defineConfig } from 'wuchale';

// These strings will not be translated when present in script scopes.
const IGNORE_MESSAGES = [
  'Content-Type',
  'Authorization',
  'Bearer',
  'ArrowDown',
  'ArrowUp',
  'Enter',
  'Escape',
  'Tab',
  'Backspace',
  'Delete',
  'Shift',
  'Ctrl',
  'Alt',
  'SHA-256',
];

// Any strings defined in these functions will not be translated.
const IGNORED_FUNCTIONS = ['effectFetch', 'JSON.stringify', 'JSON.parse'];

export default defineConfig({
  // sourceLocale is en by default
  locales: ['en', 'es', 'fr', 'de'],
  adapters: {
    main: jsx({
      loader: 'react',
      // The integration screens (Connect GitHub, Google Calendar, Notion and
      // the rest) are React components that ship inside the pinned `devonian`
      // package and are aliased in as `@localthought/atomic-integrations`.
      // They render in this app, so their text belongs in the catalog. The
      // adapter's default `src/**` never reaches them, and a catalog rebuilt
      // without this line leaves those screens with blank labels.
      files: {
        include: [
          'src/**/*.{js,ts,jsx,tsx}',
          'node_modules/devonian/platform-lenses/atomic-integrations/**/*.{ts,tsx}',
        ],
        ignore: '**/*.d.ts',
      },
      heuristic: ({ msgStr, details }) => {
        const [msg] = msgStr;

        if (details.scope === 'script') {
          // Ignore certain functions
          if (details.call && IGNORED_FUNCTIONS.includes(details.call)) {
            // console.log('Ignoring', msg);
            return false;
          }

          // Ignore certain messages
          if (IGNORE_MESSAGES.includes(msg)) {
            // console.log('Ignoring', msg);

            return false;
          }
        }

        // Ignore words that are in full caps and only contain letters, digits, and underscores
        if (msg === msg.toUpperCase() && /^[A-Z0-9_]+$/.test(msg)) {
          // console.log('Ignoring', msg);
          return false;
        }
      },
    }),
  },
});

// Dev-only Vite plugin for live user-testing sessions: an interaction logger
// and an in-page seed step. See scripts/demo-session/README.md.
//
// `apply: 'serve'` keeps it out of every `vite build`, and it is only added by
// the config demo-session.sh generates, when VITE_UX_LOG=true, so no
// production bundle can contain it. It does not import from `vite`, because it
// lives outside the data-browser package and its node_modules.
import * as fs from 'node:fs';
import * as path from 'node:path';

const CLIENT_ID = 'virtual:ux-log-client';
const SEED_ID = 'virtual:demo-seed';
const ENDPOINT = '/__ux-log';

interface Options {
  /** JSONL file that every event is appended to. */
  logFile: string;
  /** Seed module (plain JS, `export async function seed(store, name)`). */
  seedFile: string;
  /** The in-page logger (plain JS). */
  clientFile: string;
}

// Minimal structural types, so this file needs no `vite` import.
interface Req {
  method?: string;
  url?: string;
  on(event: 'data', cb: (chunk: Buffer) => void): void;
  on(event: 'end', cb: () => void): void;
}
interface Res {
  statusCode: number;
  end(body?: string): void;
}
interface DevServer {
  middlewares: {
    use(fn: (req: Req, res: Res, next: () => void) => void): void;
  };
}

export function uxLogPlugin({ logFile, seedFile, clientFile }: Options) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });

  const append = (entries: unknown[]) => {
    const lines = entries.map(e => JSON.stringify(e)).join('\n');
    if (lines) fs.appendFileSync(logFile, lines + '\n');
  };

  append([{ t: new Date().toISOString(), type: 'vite-start' }]);

  return {
    name: 'demo-ux-log',
    apply: 'serve' as const,
    resolveId(id: string) {
      if (id === CLIENT_ID || id === SEED_ID) return '\0' + id;

      return undefined;
    },
    load(id: string) {
      if (id === '\0' + CLIENT_ID) return fs.readFileSync(clientFile, 'utf-8');
      if (id === '\0' + SEED_ID) return fs.readFileSync(seedFile, 'utf-8');

      return undefined;
    },
    transformIndexHtml(html: string) {
      return html.replace(
        '</head>',
        `<script type="module" src="/@id/__x00__${CLIENT_ID}"></script></head>`,
      );
    },
    configureServer(server: DevServer) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== ENDPOINT || req.method !== 'POST') return next();
        let body = '';
        req.on('data', chunk => (body += chunk.toString()));
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            append(Array.isArray(parsed) ? parsed : [parsed]);
            res.statusCode = 204;
          } catch {
            res.statusCode = 400;
          }
          res.end();
        });
      });
    },
  };
}

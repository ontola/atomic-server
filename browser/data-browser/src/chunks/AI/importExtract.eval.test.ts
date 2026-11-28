// @wc-ignore-file
/**
 * Owner-run accuracy check for AI import extraction. Skipped unless a provider
 * is configured through the environment, so CI and sandboxes never call a
 * model and no key is ever stored in the repository:
 *
 *   IMPORTER_AI_EVAL=1 OPENROUTER_API_KEY=... [IMPORTER_AI_MODEL=~google/gemini-flash-latest] \
 *     pnpm vitest run src/chunks/AI/importExtract.eval.test.ts
 *
 * For each of the six invented fixture pages it prints the class the model
 * chose and which properties it filled. The lab page must never land on a
 * medical class (the denylist), whatever the model says.
 */
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { buildSnapshot, extractWithModel, findCandidates } from '@tomic/react';
import { AIProvider } from '@components/AI/aiContstants';
import { createModelCall } from './importExtract';
import {
  fakeStore,
  world,
} from '../../../../lib/src/importer/fixtures/ai/world';

const key = process.env.OPENROUTER_API_KEY;
const enabled = Boolean(process.env.IMPORTER_AI_EVAL && key);
const PAGES = ['recipe', 'event', 'product', 'article', 'lab', 'lesson'];

describe.skipIf(!enabled)('AI import extraction (live)', () => {
  it(
    'prints class and filled fields per fixture',
    { timeout: 600_000 },
    async () => {
      const store = fakeStore(world());
      const call = createModelCall(
        {
          id: process.env.IMPORTER_AI_MODEL ?? '~google/gemini-flash-latest',
          provider: AIProvider.OpenRouter,
        },
        {
          openRouterApiKey: key,
          ollamaEndpoint: undefined,
          openRouterZdr: false,
          isProviderAvailable: () => true,
        },
      );
      const rows: string[] = [];

      for (const name of PAGES) {
        const html = readFileSync(
          new URL(
            `../../../../lib/src/importer/fixtures/ai/${name}.html`,
            import.meta.url,
          ),
          'utf8',
        );
        const snap = buildSnapshot({ html });
        const candidates = await findCandidates(
          store,
          [],
          `${snap.title} ${snap.text}`,
        );
        const p = await extractWithModel({
          capture: { url: `https://example.test/${name}`, html },
          candidates,
          call,
        });
        const klass = candidates.find(c => c.subject === p.class);
        const filled = Object.keys(p.propvals)
          .map(s => klass?.properties.find(x => x.subject === s)?.key)
          .filter(Boolean);

        rows.push(
          `${name.padEnd(8)} -> ${(klass?.key ?? p.class).padEnd(10)} filled: ${filled.join(', ')} | dropped: ${p.ai?.dropped.map(d => d.property).join(', ') || '-'} | missing: ${p.ai?.missing.join(', ') || '-'}`,
        );
      }

      process.stdout.write(`\n${rows.join('\n')}\n`);
    },
  );
});

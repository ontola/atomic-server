import http from 'node:http';

/** What the fake model says. `reply` gets the chat so far and returns the answer text. */
export interface FakeModel {
  name: string;
  title: string;
  reply: (messages: OllamaMessage[]) => FakeReply;
}

/** Either text to stream, or a tool call for the app to run before the next turn. */
export type FakeReply =
  | string
  | { tool: string; args: Record<string, unknown> };

interface ChatRequest {
  messages?: OllamaMessage[];
  tools?: unknown[];
  stream?: boolean;
}

export interface OllamaMessage {
  role: string;
  content: string;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-private-network': 'true',
};

/**
 * A tiny stand-in for a local Ollama, so the screenshots show a real
 * conversation without a model or network. It speaks just the endpoints the
 * app calls: `/api/tags`, `/api/show` and a streaming `/api/chat`.
 */
export function startFakeOllama(model: FakeModel, port = 11434) {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length
        ? JSON.parse(Buffer.concat(chunks).toString())
        : {};
      handle(req.method ?? 'GET', req.url ?? '/', body, res, model);
    });
  });

  return new Promise<{ close: () => Promise<void> }>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () =>
      resolve({
        close: () => new Promise(done => server.close(() => done())),
      }),
    );
  });
}

function handle(
  method: string,
  url: string,
  body: ChatRequest,
  res: http.ServerResponse,
  model: FakeModel,
) {
  const json = (data: unknown) => {
    res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  if (method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
  } else if (url.startsWith('/api/tags')) {
    json({ models: [{ name: model.name, model: model.name }] });
  } else if (url.startsWith('/api/show')) {
    json({
      capabilities: ['completion', 'tools'],
      model_info: { 'llama.context_length': 131072 },
    });
  } else if (url.startsWith('/api/chat')) {
    const messages: OllamaMessage[] = body.messages ?? [];
    const isTitle =
      /title/i.test(messages[0]?.content ?? '') && !body.tools?.length;
    const reply = isTitle ? model.title : model.reply(messages);
    const at = new Date().toISOString();
    const base = { model: model.name, created_at: at };

    if (typeof reply !== 'string') {
      const call = { function: { name: reply.tool, arguments: reply.args } };
      res.writeHead(200, { ...CORS, 'content-type': 'application/x-ndjson' });
      res.write(
        JSON.stringify({
          ...base,
          message: { role: 'assistant', content: '', tool_calls: [call] },
          done: false,
        }) + '\n',
      );
      res.end(
        JSON.stringify({
          ...base,
          message: { role: 'assistant', content: '' },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 2140,
          eval_count: 40,
        }) + '\n',
      );

      return;
    }

    const text = reply;

    if (body.stream === false) {
      json({
        ...base,
        message: { role: 'assistant', content: text },
        done: true,
        done_reason: 'stop',
      });

      return;
    }

    res.writeHead(200, { ...CORS, 'content-type': 'application/x-ndjson' });
    for (const word of text.match(/\S+\s*/g) ?? [])
      res.write(
        JSON.stringify({
          ...base,
          message: { role: 'assistant', content: word },
          done: false,
        }) + '\n',
      );
    res.end(
      JSON.stringify({
        ...base,
        message: { role: 'assistant', content: '' },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 2140,
        eval_count: 118,
      }) + '\n',
    );
  } else {
    res.writeHead(404, CORS);
    res.end();
  }
}

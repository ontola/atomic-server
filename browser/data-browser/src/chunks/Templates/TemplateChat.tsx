import { lazy, Suspense, useState, useRef, useEffect } from 'react';
import { generateText } from 'ai';
import { parseTemplateProposal } from './aiProposal';
import { Card } from '../../components/Card';
import { Column, Row } from '../../components/Row';
import { Button } from '../../components/Button';
import { ErrorBlock } from '../../components/ErrorLook';
import { useAISettings } from '../../components/AI/AISettingsContext';
import { useGetModel } from '../AI/useModel';
import { selectGenerativeFeaturesModel } from '../AI/useGenerativeData';
import { TEMPLATE_CATALOG } from './catalog';
import type { TemplateDefinition } from './model';
import { SectionTitle } from '../../views/Drive/DriveHome';
const ChatInput = lazy(() => import('../RTE/AIChatInput/AsyncAIChatInput'));

export default function TemplateChat({
  onProposal,
}: {
  onProposal: (template: TemplateDefinition) => void;
}) {
  const labels = {
    loadingChat: 'Loading chat…',
    reviewHint: 'Nothing is created until you add it.',
    reviewSetup: 'Add to this drive',
  };
  const settings = useAISettings();
  const getModel = useGetModel();
  const [input, setInput] = useState('');
  const request = useRef<AbortController | undefined>(undefined);
  const [composer, setComposer] = useState(0);
  useEffect(() => () => request.current?.abort(), []);
  const [messages, setMessages] = useState<
    Array<{ role: 'user' | 'assistant'; content: string }>
  >([]);
  const [proposal, setProposal] = useState<TemplateDefinition>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error>();
  const identifier = selectGenerativeFeaturesModel(
    settings.genFeaturesModel,
    settings.defaultChatModel,
    settings.isProviderAvailable,
  );

  async function send() {
    if (request.current || !input.trim()) return;
    const model = identifier ? getModel(identifier) : undefined;

    if (!model) return;

    const history = [
      ...messages,
      { role: 'user' as const, content: input.trim() },
    ];
    const controller = new AbortController();
    request.current = controller;
    const timeout = setTimeout(() => controller.abort(), 60000);
    setBusy(true);
    setError(undefined);

    try {
      const available = TEMPLATE_CATALOG.filter(t =>
        t.entryPoints.includes('table'),
      ).map(t => ({ id: t.id, title: t.title, description: t.description }));
      // @wc-ignore
      const system = `Help design an Atomic workspace conversationally. Return JSON only: {message,title,tables,documents}. message explains the proposal and may ask one useful question. tables contains IDs from the catalog. documents contains {name,text}, with reusable outlines, never invented personal data. Maximum six of each. No code, URLs, permissions or tools. Catalog: ${JSON.stringify(available)}`;
      const result = await generateText({
        model,
        system,
        messages: history,
        abortSignal: controller.signal,
      });
      const next = parseTemplateProposal(result.text, TEMPLATE_CATALOG);
      setProposal(next);
      setMessages([
        ...history,
        { role: 'assistant', content: next.description },
      ]);
      setInput('');
      setComposer(value => value + 1);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      clearTimeout(timeout);
      request.current = undefined;
      setBusy(false);
    }
  }

  // Without an AI source there is nothing to ask.
  if (!identifier) return null;

  return (
    <Column>
      <SectionTitle>Or describe what you need</SectionTitle>
      {messages.map((m, i) => (
        <Card key={i}>
          <strong>{m.role === 'user' ? 'You' : 'Atomic'}</strong>
          <p>{m.content}</p>
        </Card>
      ))}
      {error && <ErrorBlock error={error} />}
      <Card>
        <Suspense fallback={<p>{labels.loadingChat}</p>}>
          <ChatInput
            key={composer}
            autoFocus={false}
            clearOnSubmit={false}
            hasFiles={false}
            disabled={busy}
            disableSubmit={busy}
            onMentionUpdate={() => {}}
            onChange={setInput}
            onSubmit={() => void send()}
          />
        </Suspense>
      </Card>
      <Row>
        <small>{labels.reviewHint}</small>
        {proposal && (
          <Button onClick={() => onProposal(proposal)} disabled={busy}>
            {labels.reviewSetup}
          </Button>
        )}
      </Row>
    </Column>
  );
}

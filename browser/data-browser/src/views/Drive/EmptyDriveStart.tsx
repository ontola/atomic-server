import { lazy, Suspense, useState, type JSX } from 'react';
import { useStore } from '@tomic/react';
import { Button } from '@components/Button';
import { Card } from '@components/Card';
import { ErrorBlock } from '@components/ErrorLook';
import { Column } from '@components/Row';
import { TEMPLATE_CATALOG } from '../../chunks/Templates/catalog';
import {
  planTemplate,
  type TemplateDefinition,
} from '../../chunks/Templates/model';
import { QuickCreateCards, SectionTitle } from './DriveHome';

const TemplateChat = lazy(() => import('../../chunks/Templates/TemplateChat'));

const STARTERS = TEMPLATE_CATALOG.filter(t =>
  t.entryPoints.includes('workspace'),
);

/**
 * What an empty drive offers instead of a blank page: create something, fill
 * the drive with a starter (its parts are made right here, no preview), or
 * describe it to the AI. The drive page hides this once the drive has content.
 */
export function EmptyDriveStart({
  drive,
  onActive,
}: {
  drive: string;
  /** True from the moment a starter is chosen until it is in; the page keeps
   *  this block up meanwhile, though the drive already has a first resource. */
  onActive: (active: boolean) => void;
}): JSX.Element {
  const store = useStore();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<Error>();

  async function fill(template: TemplateDefinition) {
    if (busy) return;
    setBusy(template.id);
    setError(undefined);
    onActive(true);

    try {
      const { instantiateTemplate } =
        await import('../../chunks/Templates/instantiate');
      await instantiateTemplate(
        store,
        planTemplate(template, TEMPLATE_CATALOG, true),
        { parent: drive, drive },
      );
      onActive(false);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <Column gap='1.5rem' aria-label='Start this drive'>
      <section>
        <SectionTitle>Start with</SectionTitle>
        <QuickCreateCards parent={drive} />
      </section>
      <section>
        <SectionTitle>Or fill this drive with a starter</SectionTitle>
        {error && <ErrorBlock error={error} />}
        <Column>
          {STARTERS.map(template => (
            <Card key={template.id}>
              <Column>
                <strong>
                  {template.icon} {template.title}
                </strong>
                <span>{template.description}</span>
                <small>
                  {planTemplate(template, TEMPLATE_CATALOG)
                    .parts.map(part => part.name)
                    .join(', ')}
                </small>
                <Button
                  subtle
                  disabled={!!busy}
                  onClick={() => void fill(template)}
                >
                  {busy === template.id ? 'Adding…' : 'Use this starter'}
                </Button>
              </Column>
            </Card>
          ))}
        </Column>
      </section>
      <Suspense fallback={null}>
        <TemplateChat onProposal={fill} />
      </Suspense>
    </Column>
  );
}

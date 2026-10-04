import { getIconForClass } from '../../helpers/iconMap';
import {
  useEffect,
  useState,
  useRef,
  lazy,
  Suspense,
  type ReactNode,
} from 'react';
import { styled } from 'styled-components';
import { dataBrowser, useStore, type Resource, type Store } from '@tomic/react';
import { SIDEBAR_TOGGLE_WIDTH } from '../../components/SideBar';
import { Card } from '../../components/Card';
import { Button } from '../../components/Button';
import { Column, Row } from '../../components/Row';
import Field from '../../components/forms/Field';
import { InputStyled, InputWrapper } from '../../components/forms/InputStyles';
import { Checkbox } from '../../components/forms/Checkbox';
import { ErrorBlock } from '../../components/ErrorLook';
import { useSettings } from '../../helpers/AppSettings';
import { getManagedPortalUrl } from '../../helpers/managed/cloudSync';
import {
  accountCreationTarget,
  fetchManagedInfo,
} from '../../helpers/managedServer';
import { getManagedAccount } from '../../helpers/managed/session';
import { localAgentIsDisposable } from '../../helpers/managed/reconcile';
import { constructOpenURL } from '../../helpers/navigation';
import { useNavigateWithTransition } from '../../hooks/useNavigateWithTransition';
import { TEMPLATE_CATALOG } from './catalog';
import { planTemplate, type TemplateDefinition } from './model';
import { instantiateTemplate, startTemplateDemo } from './instantiate';
import { readTemplateDemo, TEMPLATE_DEMO_KEY } from './demoSession';
import { keepTemplateDemo } from './keepTemplateDemo';
import { prepareTemplateDrive } from './prepareTemplateDrive';
import { clearPendingTemplate, savePendingTemplate } from './pendingTemplate';
const TemplateChat = lazy(() => import('./TemplateChat'));

export interface TemplateSetupStep {
  /** The name step (a template or a blank drive chosen), or the gallery. */
  naming: boolean;
  /** From the name step back to the gallery. */
  back: () => void;
  busy: boolean;
  /** The name step's submit, for a Create button outside the form (its
   *  `form` attribute names the form). */
  create: { form: string; disabled: boolean; label: string };
}

const FORM_ID = 'new-drive-form';

export function DriveTemplateSetup({
  onCreated,
  onPreview,
  renderBar,
}: {
  onCreated: (resource: Resource) => void;
  onPreview?: () => void;
  /** Where a full page puts the step's title and back action: in its setup
   *  bar. Without it (the new-drive dialog) they stay inline. */
  renderBar?: (step: TemplateSetupStep) => ReactNode;
}) {
  const store = useStore();
  const navigate = useNavigateWithTransition();
  const { setDrive, setSideBarLocked } = useSettings();
  const search = new URLSearchParams(window.location.search);
  const initial = search.get('template');
  const [selected, setSelected] = useState<TemplateDefinition | undefined>(() =>
    TEMPLATE_CATALOG.find(t => t.id === initial),
  );
  const [naming, setNaming] = useState(!!initial || search.has('blank'));
  // `name` and `examples` come back from account creation (`pendingTemplate`).
  const [name, setName] = useState(
    () => search.get('name') || selected?.title || 'My drive',
  );
  const [examples, setExamples] = useState(search.get('examples') === '1');
  const [keepEdits, setKeepEdits] = useState(false);
  const demo = readTemplateDemo();
  const matchingDemo = demo?.template === selected?.id ? demo : undefined;
  const [busy, setBusy] = useState(false);
  const [preparingTemplate, setPreparingTemplate] = useState<string>();
  const busyRef = useRef(false);
  const [error, setError] = useState<Error>();
  const [partial, setPartial] = useState<Resource>();
  // Known up front so the name step can say an account comes next.
  const [signUpFirst, setSignUpFirst] = useState(false);
  useEffect(() => {
    let active = true;
    guestSignUpUrl(store)
      .then(url => {
        if (active) setSignUpFirst(!!url);
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, [store]);
  const createLabel = busy
    ? signUpFirst
      ? 'Opening sign-up…'
      : 'Creating…'
    : signUpFirst
      ? 'Continue'
      : 'Create drive';
  const plan = selected
    ? planTemplate(selected, TEMPLATE_CATALOG, examples)
    : undefined;

  function chooseBlank() {
    if (busy) return;
    setSelected(undefined);
    setName('My drive');
    setNaming(true);
  }

  async function run(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);

    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      busyRef.current = false;
      setBusy(false);
      setPreparingTemplate(undefined);
    }
  }

  async function preview(template: TemplateDefinition) {
    await run(async () => {
      setPreparingTemplate(template.id);

      const subject = await startTemplateDemo(
        store,
        planTemplate(template, TEMPLATE_CATALOG, true),
      );
      setDrive(store.getDrive()!);
      if (window.innerWidth < SIDEBAR_TOGGLE_WIDTH) setSideBarLocked(true);
      onPreview?.();
      navigate(constructOpenURL(subject));
    });
  }

  async function create() {
    if (!name.trim() || partial) return;
    await run(async () => {
      if (await sendGuestToSignUp()) return;
      await prepareTemplateDrive(store);

      if (keepEdits && matchingDemo) {
        const resource = await keepTemplateDemo(
          store,
          matchingDemo,
          name.trim(),
        );
        await store.notifyResourceManuallyCreated(resource);
        onCreated(resource);

        return;
      }

      const resource = await store.createDrive(name.trim(), {
        personal: false,
        localOnly: !!getManagedPortalUrl(),
      });
      setPartial(resource);
      if (plan)
        await instantiateTemplate(store, plan, {
          parent: resource.subject,
          drive: resource.subject,
        });
      if (plan && window.innerWidth < SIDEBAR_TOGGLE_WIDTH)
        setSideBarLocked(true);

      if (matchingDemo) {
        const { cleanupDemoDrive } = await import('../Demo/startDemo');
        await cleanupDemoDrive(store, matchingDemo.drive);
        localStorage.removeItem(TEMPLATE_DEMO_KEY);
      }

      store.notifyResourceManuallyCreated(resource);
      clearPendingTemplate();
      onCreated(resource);
    });
  }

  /**
   * On a hosted build a drive belongs to an account, and every account has an
   * email. A demo guest who picks a template is sent to create one (email and
   * a way to sign in) and comes back here to finish, via `pendingTemplate`.
   * Self-hosted servers have no account to make, so nothing changes there.
   * True when the page is on its way to the portal.
   */
  async function sendGuestToSignUp(): Promise<boolean> {
    const url = await guestSignUpUrl(store);
    if (!url) return false;

    savePendingTemplate({
      template: selected?.id,
      name: name.trim(),
      examples,
    });
    window.location.assign(url);
    // Stay busy until the page unloads.
    await new Promise(() => undefined);

    return true;
  }

  return (
    <Column gap='1.5rem'>
      {renderBar?.({
        naming,
        back: () => setNaming(false),
        busy: busy || !!partial,
        create: {
          form: FORM_ID,
          disabled: busy || !!partial || !name.trim(),
          label: createLabel,
        },
      })}
      {error && (
        <>
          <ErrorBlock error={error} />
          {partial && (
            <>
              <p>
                The drive was created, but setup did not finish. Open it to
                inspect what was saved.
              </p>
              <Button onClick={() => onCreated(partial)}>Open drive</Button>
            </>
          )}
        </>
      )}
      {naming ? (
        <>
          {!renderBar && (
            <>
              <Button
                subtle
                disabled={busy || !!partial}
                onClick={() => setNaming(false)}
              >
                Back to templates
              </Button>
              <h1>Give your space a name</h1>
            </>
          )}
          <form
            id={FORM_ID}
            onSubmit={e => {
              e.preventDefault();
              void create();
            }}
          >
            <Column>
              <Field label='Drive name' fieldId='new-drive-name' required>
                <InputWrapper>
                  <InputStyled
                    id='new-drive-name'
                    value={name}
                    onChange={e => setName(e.target.value)}
                    autoFocus
                    onFocus={event => event.currentTarget.select()}
                    disabled={busy || !!partial}
                  />
                </InputWrapper>
              </Field>
              {selected && (
                <Card>
                  <Column>
                    <TemplatePreview template={selected} />
                    {matchingDemo && !signUpFirst && (
                      <label htmlFor='template-keep-edits'>
                        <Row>
                          <Checkbox
                            id='template-keep-edits'
                            checked={keepEdits}
                            onChange={setKeepEdits}
                            disabled={busy || !!partial}
                          />
                          Keep demo content and my edits
                        </Row>
                      </label>
                    )}
                    {!keepEdits && (
                      <label htmlFor='template-examples'>
                        <Row>
                          <Checkbox
                            id='template-examples'
                            checked={examples}
                            onChange={setExamples}
                            disabled={busy || !!partial}
                          />
                          Include example content
                        </Row>
                      </label>
                    )}
                  </Column>
                </Card>
              )}
              {signUpFirst && (
                <p>
                  Next, create your account with your email address and a way to
                  sign in. Then you come back here to create your drive.
                </p>
              )}
              {!renderBar && (
                <Button
                  type='submit'
                  disabled={busy || !!partial || !name.trim()}
                >
                  {createLabel}
                </Button>
              )}
            </Column>
          </form>
        </>
      ) : (
        <>
          <p>
            Start with a template,{' '}
            <a
              href='/app/new-drive?blank=1'
              onClick={event => {
                event.preventDefault();
                chooseBlank();
              }}
            >
              create a blank drive
            </a>
            , or describe a space of your own.
          </p>
          <Gallery>
            {TEMPLATE_CATALOG.filter(t =>
              t.entryPoints.includes('workspace'),
            ).map(template => (
              <Card key={template.id}>
                <Column>
                  <TemplatePreview template={template} />
                  <p>{template.description}</p>
                  <Button
                    subtle
                    disabled={busy}
                    onClick={() => void preview(template)}
                  >
                    {preparingTemplate === template.id
                      ? 'Preparing…'
                      : 'Preview template'}
                  </Button>
                </Column>
              </Card>
            ))}
          </Gallery>
          <Suspense fallback={<p>Loading AI setup…</p>}>
            <TemplateChat
              onProposal={template => {
                setSelected(template);
                setName(template.title);
                setNaming(true);
              }}
            />
          </Suspense>
          <Row style={{ flexWrap: 'wrap', justifyContent: 'flex-start' }}>
            <span>Prefer a fresh start?</span>
            <Button
              style={{ whiteSpace: 'nowrap' }}
              disabled={busy}
              onClick={chooseBlank}
            >
              Create a blank drive
            </Button>
          </Row>
        </>
      )}
    </Column>
  );
}

/**
 * The portal sign-up a demo guest must go through before a drive is made, or
 * undefined when this person may create one right away: they have an account,
 * a workspace, or the server is self-hosted.
 */
async function guestSignUpUrl(store: Store): Promise<string | undefined> {
  const agent = store.getAgent();
  if (agent?.subject && !(await localAgentIsDisposable(store, agent.subject)))
    return undefined;
  if (await getManagedAccount()) return undefined;

  const target = accountCreationTarget(
    await fetchManagedInfo(store.getServerUrl()),
  );

  return target.kind === 'portal' ? target.url : undefined;
}

const TableIcon = getIconForClass(dataBrowser.classes.table);
const DocumentIcon = getIconForClass(dataBrowser.classes.documentV2);

/** Shared by the gallery and the selected-template summary. */
function TemplatePreview({ template }: { template: TemplateDefinition }) {
  return (
    <>
      <strong>
        {template.icon} {template.title}
      </strong>
      <SidebarPreview aria-label={`${template.title} contents`}>
        {planTemplate(template, TEMPLATE_CATALOG).parts.map(part => (
          <PreviewRow key={part.key}>
            {part.kind === 'table' ? (
              <TableIcon aria-hidden />
            ) : (
              <DocumentIcon aria-hidden />
            )}
            <span>{part.name}</span>
          </PreviewRow>
        ))}
      </SidebarPreview>
    </>
  );
}

const PreviewRow = styled.div`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  svg {
    width: 1em;
    flex-shrink: 0;
  }
`;

const Gallery = styled.div`
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  @media (max-width: 650px) {
    grid-template-columns: minmax(0, 1fr);
  }
  gap: ${p => p.theme.size(2)};
`;
const SidebarPreview = styled.div`
  background: ${p => p.theme.colors.bg1};
  border-radius: ${p => p.theme.radius};
  padding: ${p => p.theme.size(2)};
  font-size: 0.9rem;
  line-height: 2;
`;

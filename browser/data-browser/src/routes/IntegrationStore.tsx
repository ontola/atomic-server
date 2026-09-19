import { usePluginClass } from '../chunks/PluginRuns/runScript';
import { LocalThoughtCatalog } from '../chunks/PluginRuns/LocalThoughtCatalog';
import { LocalThoughtCallback } from '../chunks/PluginRuns/localThoughtCallback';
import { NewAutomation } from '../chunks/PluginRuns/NewAutomation';
import {
  IntegrationDiscovery,
  visibleBundledIntegrations,
} from '../chunks/PluginRuns/IntegrationDiscovery';
import { ConnectedIntegration } from '../chunks/PluginRuns/ConnectedIntegration';
import { useIntegrationVisibility } from '@hooks/useIntegrationVisibility';
import { createRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { styled } from 'styled-components';
import { FaPlug } from 'react-icons/fa6';
import {
  useStore,
  core,
  server,
  findSchema,
  pluginSchema,
  readConnectionSubjects,
  installRelease,
  installationIdentifier,
  readInstallationReview,
  DEFAULT_INSTALLATION_NAMESPACE,
  RUNTIME_JS,
  type JSONValue,
  type PublishedRelease,
} from '@tomic/react';
import { ResourceInline } from '../views/ResourceInline/ResourceInline';
import {
  InstallationReviewDialog,
  type PendingInstallation,
} from '../chunks/Plugins/InstallationReviewDialog';
import toast from 'react-hot-toast';
import { appRoute } from './RootRoutes';
import { pathNames } from './paths';
import { Main } from '@components/Main';
import { ContainerWide } from '@components/Containers';
import { Card } from '@components/Card';
import { Column, Row } from '@components/Row';
import { Button } from '@components/Button';
import { Input } from '@components/forms/InputStyles';
import { Checkbox, CheckboxLabel } from '@components/forms/Checkbox';
import { useSettings } from '@helpers/AppSettings';
import { useNavigateWithTransition } from '@hooks/useNavigateWithTransition';
import { constructOpenURL } from '@helpers/navigation';
import type { IntegrationVisibilityKey } from '@helpers/integrationVisibility';

/** One entry of `/plugin-catalog`: a public Listing resource on this server. */
interface Listing {
  subject: string;
  name: string;
  emoji: string | null;
  description: string;
  publisher: string | null;
  domains: string[];
  standards: string[];
  /** The Release resource URL an Installation pins. */
  release: string;
  /** The `blake3:` id, which `/plugin-package/{id}` takes. */
  releaseId: string;
  runtime: string | null;
  world: string | null;
}

export const IntegrationStoreRoute = createRoute({
  getParentRoute: () => appRoute,
  path: pathNames.integrations,
  component: IntegrationStore,
  validateSearch: (search: Record<string, unknown>) => ({
    workspace:
      typeof search.workspace === 'string' ? search.workspace : undefined,
  }),
});

function IntegrationStore(): React.JSX.Element {
  const { workspace } = IntegrationStoreRoute.useSearch();
  const store = useStore();
  const { drive } = useSettings();
  const {
    showApiPlugins,
    showExperimentalPlugins,
    ready: visibilityReady,
    saving: visibilitySaving,
    setVisibility,
  } = useIntegrationVisibility();
  // The ontology can hydrate after this page mounts on a full navigation.
  const pluginClass = usePluginClass(drive);
  const navigate = useNavigateWithTransition();
  const [listings, setListings] = useState<Listing[]>();
  const [installed, setInstalled] = useState<string[]>([]);
  const [installations, setInstallations] = useState<string[]>([]);
  const [automations, setAutomations] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [catalogError, setCatalogError] = useState<string>();
  useEffect(() => {
    let active = true;

    if (!drive) {
      setInstalled([]);

      return;
    }

    void findSchema(store, drive, pluginSchema())
      .then(async schema => {
        const subjects = pluginClass
          ? await readConnectionSubjects(
              store,
              drive,
              core.properties.isA,
              pluginClass,
            )
          : [];
        const resources = await Promise.all(
          subjects.map(subject => store.getResource(subject)),
        );
        const usage = schema.properties?.['automation-integrations'];

        if (active) {
          setInstalled(
            resources
              .filter(resource => !usage || !resource.get(usage))
              .map(resource => resource.subject),
          );
          setAutomations(
            resources
              .filter(resource => usage && resource.get(usage))
              .map(resource => resource.subject),
          );
        }
      })
      .catch(reason => {
        if (active) setError(String(reason));
      });

    return () => {
      active = false;
    };
  }, [store, drive, pluginClass]);
  useEffect(() => {
    let active = true;

    if (!drive) {
      setInstallations([]);

      return;
    }

    // Installations are the installed form for both runtimes; connections
    // above are the drafts and the legacy plugin-script installs.
    void readConnectionSubjects(
      store,
      drive,
      core.properties.isA,
      server.classes.installation,
    )
      .then(subjects => {
        if (active) setInstallations(subjects);
      })
      .catch(reason => {
        if (active) setError(String(reason));
      });

    return () => {
      active = false;
    };
  }, [store, drive]);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState<string>();
  const [pending, setPending] = useState<
    PendingInstallation & { entry: Listing }
  >();
  const serverUrl = store.getServerUrl();
  useEffect(() => {
    setCatalogError(undefined);

    if (!showExperimentalPlugins) {
      setListings(undefined);

      return;
    }

    const controller = new AbortController();
    void fetch(`${serverUrl}/plugin-catalog`, { signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(await response.text());
        const entries = await response.json();
        if (!controller.signal.aborted) setListings(entries);
      })
      .catch(reason => {
        if (!controller.signal.aborted) setCatalogError(String(reason));
      });

    return () => controller.abort();
  }, [serverUrl, showExperimentalPlugins]);

  const fetchRelease = async (id: string): Promise<PublishedRelease> => {
    const response = await fetch(
      `${serverUrl}/plugin-package/${encodeURIComponent(id)}`,
    );
    if (!response.ok) throw new Error(await response.text());

    return (await response.json()) as PublishedRelease;
  };

  /** Opening a Listing: fetch its release and review it before installing. */
  const openReview = async (entry: Listing) => {
    if (!drive) return;
    setCreating(entry.releaseId);

    try {
      const release = await fetchRelease(entry.releaseId);
      setPending({
        entry,
        review: readInstallationReview({ ...release, id: entry.releaseId }),
        release: { url: entry.release, id: entry.releaseId },
        title: entry.name,
        description: entry.description,
        emoji: entry.emoji ?? undefined,
      });
    } catch (reason) {
      toast.error(String(reason));
    } finally {
      setCreating(undefined);
    }
  };

  const install = async (
    p: PendingInstallation,
    config: JSONValue | undefined,
    grants: string[],
  ) => {
    if (!drive) return;
    const subject = await installRelease(store, {
      drive,
      release: p.release,
      name: p.review.name ?? installationIdentifier(p.title ?? 'plugin'),
      namespace: p.review.namespace ?? DEFAULT_INSTALLATION_NAMESPACE,
      description: p.review.description ?? p.description,
      version: p.review.version,
      config,
      grants,
    });
    navigate(constructOpenURL(subject));
  };

  /** Drafts remain the authoring form: a copy of the source you can edit. */
  const createDraft = async (entry: Listing) => {
    if (!drive) return;
    const release = await fetchRelease(entry.releaseId);

    if (!release.source) {
      throw new Error('Only JS releases can be opened as an editable draft');
    }

    const { createPlugin } = await import('../chunks/PluginRuns/runScript');
    const subject = await createPlugin(
      store,
      { drive, parent: drive },
      entry.name,
      release.source,
      release.schemas ?? {},
    );

    if (entry.emoji) {
      const resource = await store.getResource(subject);
      await resource.set(
        'https://atomicdata.dev/properties/emoji',
        entry.emoji,
      );
      await resource.save();
    }

    navigate(constructOpenURL(subject));
  };

  const query = search.trim().toLocaleLowerCase();
  const bundled = visibleBundledIntegrations(
    showExperimentalPlugins,
    showApiPlugins,
  ).filter(entry =>
    `${entry.name} ${entry.description} ${entry.capabilities} ${entry.events} ${entry.keywords}`
      .toLocaleLowerCase()
      .includes(query),
  );
  const visible = (showExperimentalPlugins ? listings : [])?.filter(entry =>
    [entry.name, entry.description, ...entry.domains, ...entry.standards]
      .join(' ')
      .toLocaleLowerCase()
      .includes(query),
  );

  return (
    <Main>
      <ContainerWide>
        <Column gap='1.5rem'>
          <Header>
            <Icon>
              <FaPlug aria-hidden />
            </Icon>
            <h1>Integrations</h1>
            <p>
              Connect your apps and keep your work in sync. Add automations when
              you need them.
            </p>
          </Header>
          {(installed.length > 0 || installations.length > 0) && (
            <section aria-label='Your integrations'>
              <h2>Your connections</h2>
              <Grid>
                {installed.map(subject => (
                  <ConnectedIntegration
                    key={subject}
                    subject={subject}
                    drive={drive!}
                  />
                ))}
                {installations.map(subject => (
                  <Card key={subject} data-installation={subject}>
                    <ResourceInline subject={subject} />
                  </Card>
                ))}
              </Grid>
            </section>
          )}
          {drive && (
            <section aria-label='Your automations'>
              <Row center justify='space-between'>
                <h2>Your automations</h2>
                <NewAutomation drive={drive} connections={installed} />
              </Row>
              {automations.length === 0 && <AutomationEmptyState />}
              <Grid>
                {automations.map(subject => (
                  <Card key={subject}>
                    <ResourceInline subject={subject} />
                  </Card>
                ))}
              </Grid>
            </section>
          )}
          <h2>Discover integrations</h2>
          <LocalThoughtCallback drive={drive} />
          <Input
            aria-label='Search integrations'
            placeholder='Search integrations, domains or standards'
            value={search}
            onChange={event => setSearch(event.target.value)}
          />
          {error && <Card role='alert'>{error}</Card>}
          {showExperimentalPlugins && catalogError && (
            <Card role='alert'>{catalogError}</Card>
          )}
          {showExperimentalPlugins && !listings && !catalogError && (
            <p>Loading integrations…</p>
          )}
          {!showApiPlugins && (
            <PluginVisibilityToggle
              pluginKey='show-api-plugins'
              label='Show API plugins'
              ready={visibilityReady}
              saving={visibilitySaving}
              setVisibility={setVisibility}
            />
          )}
          {!showExperimentalPlugins && (
            <PluginVisibilityToggle
              pluginKey='show-experimental-plugins'
              label='Show experimental plugins'
              ready={visibilityReady}
              saving={visibilitySaving}
              setVisibility={setVisibility}
            />
          )}
          <Grid>
            {showApiPlugins && (
              <LocalThoughtCatalog drive={drive} search={search} />
            )}
            {bundled.map(entry => (
              <IntegrationDiscovery
                key={entry.id}
                entry={entry}
                workspace={workspace}
                drive={drive}
              />
            ))}
          </Grid>
          <Column gap='0.75rem'>
            {visible && visible.length > 0 && (
              <>
                <h2>Community plugins</h2>
                <p>
                  Published releases. Open one to review what it can do before
                  installing it into this drive, or create a draft to adapt its
                  code.
                </p>
              </>
            )}
          </Column>
          <Grid>
            {visible?.map(entry => (
              <Card key={entry.subject} data-release={entry.releaseId}>
                <Column gap='1rem'>
                  <Row justify='space-between' center>
                    <Avatar aria-hidden>{entry.emoji || <FaPlug />}</Avatar>
                    <Badge>Unverified</Badge>
                  </Row>
                  <div>
                    <h2>{entry.name}</h2>
                    <Description>{entry.description}</Description>
                  </div>
                  <Row wrapItems gap='0.4rem'>
                    {entry.domains.map(domain => (
                      <Tag key={domain}>{domain}</Tag>
                    ))}
                  </Row>
                  {entry.standards.length > 0 && (
                    <details>
                      <summary>Linked standards</summary>
                      <ul>
                        {entry.standards
                          .filter(standard => /^https?:\/\//i.test(standard))
                          .map(standard => (
                            <li key={standard}>
                              <a
                                href={standard}
                                target='_blank'
                                rel='noreferrer'
                              >
                                {standard}
                              </a>
                            </li>
                          ))}
                      </ul>
                    </details>
                  )}
                  <details>
                    <summary>Publisher and release</summary>
                    <Identity>
                      {entry.publisher}
                      <br />
                      {entry.release}
                    </Identity>
                  </details>
                  <Button
                    disabled={!drive || creating !== undefined}
                    onClick={() => openReview(entry)}
                  >
                    {creating === entry.releaseId ? 'Opening…' : 'Open'}
                  </Button>
                </Column>
              </Card>
            ))}
          </Grid>
        </Column>
      </ContainerWide>
      <InstallationReviewDialog
        pending={pending}
        onClose={() => setPending(undefined)}
        onInstall={install}
        secondary={
          pending && pending.review.runtime === RUNTIME_JS
            ? {
                label: 'Create draft',
                onClick: () => createDraft(pending.entry),
              }
            : undefined
        }
      />
    </Main>
  );
}

const Header = styled.header`
  padding: 2rem 0 1rem;
  max-width: 42rem;
  h1 {
    margin: 0.8rem 0;
  }
  p {
    color: ${p => p.theme.colors.textLight};
  }
`;
const Icon = styled.div`
  color: ${p => p.theme.colors.main};
  font-size: 2rem;
`;
const Grid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 19rem), 1fr));
  gap: 1rem;
  align-items: start;
`;
const Avatar = styled.div`
  display: grid;
  place-items: center;
  width: 2.8rem;
  height: 2.8rem;
  border-radius: ${p => p.theme.radius};
  background: ${p => p.theme.colors.bg2};
  font-size: 1.3rem;
  font-weight: bold;
`;
const Badge = styled.span`
  color: ${p => p.theme.colors.textLight};
  font-size: 0.8rem;
`;
const Tag = styled.span`
  border: 1px solid ${p => p.theme.colors.bg2};
  padding: 0.2rem 0.5rem;
  border-radius: ${p => p.theme.radius};
  font-size: 0.85rem;
`;
const Description = styled.p`
  color: ${p => p.theme.colors.textLight};
  line-height: 1.5;
`;
const Identity = styled.p`
  overflow-wrap: anywhere;
  font-size: 0.8rem;
  color: ${p => p.theme.colors.textLight};
`;

function AutomationEmptyState() {
  return (
    <p>
      No automations yet. Create one to respond to events from your connected
      apps.
    </p>
  );
}

interface PluginVisibilityToggleProps {
  pluginKey: IntegrationVisibilityKey;
  label: string;
  ready: boolean;
  saving: boolean;
  setVisibility: (
    key: IntegrationVisibilityKey,
    value: boolean,
  ) => Promise<void>;
}

function PluginVisibilityToggle({
  pluginKey,
  label,
  ready,
  saving,
  setVisibility,
}: PluginVisibilityToggleProps) {
  return (
    <CheckboxLabel>
      <Checkbox
        checked={false}
        disabled={!ready || saving}
        onChange={value => void setVisibility(pluginKey, value)}
      />
      {label}
    </CheckboxLabel>
  );
}

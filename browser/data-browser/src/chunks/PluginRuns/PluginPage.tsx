import { useAISidebar } from '@components/AI/AISidebarContext';
import { useAISettings } from '@components/AI/AISettingsContext';
import { editIntegrationAssistant } from './editIntegrationAssistant';
import { FaWandMagicSparkles } from 'react-icons/fa6';
import { NewAutomation } from './NewAutomation';
import { AtomicLink } from '@components/AtomicLink';
import { pluginWorkspace } from '@tomic/react';
import { Tabs } from '@components/Tabs';
import { IntegrationDefaultView } from './IntegrationDataView';
import { AutomationIntegrations } from './AutomationIntegrations';
import {
  AutomationWorkspace,
  useAutomationTrigger,
} from './AutomationWorkspace';
import {
  IntegrationConnection,
  useIntegrationConnection,
} from './IntegrationConnection';
import { PluginTrigger } from './PluginTrigger';
import toast from 'react-hot-toast';
import { paths } from '../../routes/paths';
import { publishPluginRelease } from '@tomic/react';
import { useCallback, useEffect, useState } from 'react';
import { styled } from 'styled-components';
import { FaPencil, FaPlay } from 'react-icons/fa6';
import {
  findSchema,
  pluginSchema,
  useStore,
  type Resource,
} from '@tomic/react';
import { Button } from '@components/Button';
import { Column, Row } from '@components/Row';
import { ContainerFull } from '@components/Containers';
import { EditableTitle } from '@components/EditableTitle';
import { HighlightedCodeBlock } from '@components/HighlightedCodeBlock';
import { useNavigateWithTransition } from '@hooks/useNavigateWithTransition';
import { editURL } from '@helpers/navigation';
import { PluginSecrets } from './PluginSecrets';
import { PluginRunHistory } from './PluginRunHistory';
import { PluginSchedule } from './PluginSchedule';
import { RunPluginDialog } from './RunPluginDialog';
import { FileImport } from './FileImport';
import { usePluginManifest, usePluginSource } from './runScript';
import { originsMentionedIn, secretsMentionedIn } from '@tomic/react';

/**
 * A plugin's page.
 *
 * A page of its own rather than sections appended to the default resource view,
 * which rendered the source twice — once as prose in the property table beside
 * `created-at`, once properly — and left a generic header above it.
 *
 * Ordered by what someone came for: run it, see what it needs, see what it did,
 * and only then read how it works. The source is the longest thing here and the
 * least often read once the plugin works.
 */
export function PluginPage({
  resource,
  drive,
}: {
  resource: Resource;
  drive: string;
}): React.JSX.Element {
  const store = useStore();
  const { askAI } = useAISidebar();
  const { setEnableAI } = useAISettings();
  const navigate = useNavigateWithTransition();
  const [publishing, setPublishing] = useState(false);
  const [running, setRunning] = useState<boolean>();
  // Set when reviewing what a background run produced, so the dialog plans
  // that verdict instead of running the plugin again.
  const [reviewing, setReviewing] = useState<string>();
  const [reviewedNonce, setReviewedNonce] = useState(0);
  const source = usePluginSource(store, resource.subject, drive);
  const manifest = usePluginManifest(source);
  const connection = useIntegrationConnection(resource.subject, drive);
  const automation = useAutomationTrigger(resource.subject, drive);
  // A plugin that declares `accepts` is started with a file, not a Run button,
  // a schedule or a trigger: without one it has nothing to work on.
  const fileImport =
    !connection && !automation && (manifest.accepts?.length ?? 0) > 0;
  const [dataTable, setDataTable] = useState<string>();
  useEffect(() => {
    let active = true;
    void findSchema(store, drive, pluginSchema())
      .then(schema => {
        if (active) {
          setDataTable(pluginWorkspace(resource, schema.properties ?? {}));
        }
      })
      .catch(error => {
        if (active) toast.error(String(error));
      });

    return () => {
      active = false;
    };
  }, [store, drive, resource, connection]);

  const publish = async () => {
    setPublishing(true);

    try {
      await publishPluginRelease(store, { drive, plugin: resource.subject });
      navigate(paths.integrations);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setPublishing(false);
    }
  };

  const run = useCallback(() => {
    setReviewing(undefined);
    setRunning(true);
  }, []);

  return (
    <ContainerFull>
      <Column gap='1.5rem'>
        <PageHeader justify='space-between' align='flex-start'>
          <EditableTitle resource={resource} />
          <Button
            subtle
            onClick={() => {
              setEnableAI(true);
              askAI(editIntegrationAssistant(resource.subject, dataTable));
            }}
          >
            <FaWandMagicSparkles aria-hidden />
            <span>Edit with AI</span>
          </Button>
        </PageHeader>

        {dataTable && (
          <AtomicLink subject={dataTable}>Open workspace</AtomicLink>
        )}

        <WorkspaceTabs
          key={`${resource.subject}:${dataTable || 'none'}:${!!automation}`}
          label='Integration sections'
          tabs={[
            {
              value: 'manage',
              label: connection
                ? 'Sync'
                : automation
                  ? 'Automation'
                  : fileImport
                    ? 'Import'
                    : 'Run',
            },
            ...(!automation
              ? [{ value: 'automations', label: 'Automations' }]
              : []),
            { value: 'settings', label: 'Settings' },
            { value: 'activity', label: 'Activity' },
            ...(!automation ? [{ value: 'code', label: 'Code' }] : []),
          ]}
        >
          <Panel value='manage'>
            <Column gap='1.5rem'>
              {fileImport && (
                <FileImport
                  resource={resource}
                  drive={drive}
                  source={source}
                  manifest={manifest}
                />
              )}
              {!connection && !automation && !fileImport && (
                <Button onClick={run}>
                  <FaPlay aria-hidden /> Run
                </Button>
              )}
              {automation && (
                <AutomationWorkspace
                  key={resource.subject}
                  resource={resource}
                  drive={drive}
                  source={source}
                  eventName={automation.name || automation.event}
                  eventId={automation.event}
                  integration={automation.integration}
                  onTest={run}
                />
              )}
              {connection ? (
                <IntegrationConnection
                  plugin={resource.subject}
                  drive={drive}
                  definition={connection}
                />
              ) : !automation && !fileImport ? (
                <PluginSchedule
                  plugin={resource.subject}
                  drive={drive}
                  onReview={pending => {
                    setReviewing(pending);
                    setRunning(true);
                  }}
                  reviewedNonce={reviewedNonce}
                />
              ) : null}
              {!connection && !fileImport && (
                <PluginTrigger
                  plugin={resource.subject}
                  drive={drive}
                  onReview={pending => {
                    setReviewing(pending);
                    setRunning(true);
                  }}
                />
              )}
            </Column>
          </Panel>
          <Panel value='automations'>
            <Column gap='0.5rem'>
              <SectionTitle>Automations</SectionTitle>
              <Muted>
                Use this integration in workflows. Describe what should happen
                and let the assistant help you build it.
              </Muted>
            </Column>
            {connection && (
              <NewAutomation drive={drive} connections={[resource.subject]} />
            )}
            <AutomationIntegrations
              drive={drive}
              subject={resource.subject}
              inverse={!!connection}
            />
          </Panel>
          <Panel value='settings'>
            <Column gap='1.5rem'>
              {dataTable && <IntegrationDefaultView subject={dataTable} />}
              {(!automation ||
                manifest.secrets.length > 0 ||
                secretsMentionedIn(source ?? '').length > 0) && (
                <PluginSecrets
                  plugin={resource.subject}
                  drive={drive}
                  declared={manifest.secrets}
                  mentioned={secretsMentionedIn(source ?? '')}
                  candidateOrigins={originsMentionedIn(source ?? '')}
                />
              )}
            </Column>
          </Panel>
          <Panel value='activity'>
            <PluginRunHistory resource={resource} />
          </Panel>
          <Panel value='code'>
            {/* A long title was squeezing these until their labels wrapped one
              letter per line. */}
            <Actions gap='0.5rem' center>
              {!automation && (
                <Button
                  subtle
                  onClick={() => navigate(editURL(resource.subject))}
                >
                  <FaPencil aria-hidden /> Edit
                </Button>
              )}
              {!automation && (
                <Button subtle disabled={publishing} onClick={publish}>
                  Publish to integration store
                </Button>
              )}
            </Actions>
            {!automation && (
              <Column gap='0.5rem'>
                <SectionTitle>Source</SectionTitle>
                {source === undefined ? (
                  <Muted>Loading…</Muted>
                ) : source === '' ? (
                  <Muted>This plugin has no source yet.</Muted>
                ) : (
                  <HighlightedCodeBlock code={source} language='typescript' />
                )}
              </Column>
            )}
          </Panel>
        </WorkspaceTabs>
        {running !== undefined && (
          <RunPluginDialog
            resource={resource}
            drive={drive}
            show={running}
            onShowChange={open => {
              setRunning(open);

              if (!open) setReviewing(undefined);
            }}
            verdict={reviewing}
            onReviewed={
              reviewing === undefined
                ? undefined
                : () => setReviewedNonce(n => n + 1)
            }
          />
        )}
      </Column>
    </ContainerFull>
  );
}

/** Never squeezed by the title beside it. */
const Actions = styled(Row)`
  flex-shrink: 0;
  flex-wrap: wrap;
  row-gap: 0.75rem;

  button {
    white-space: nowrap;
  }
`;

const SectionTitle = styled.h2`
  font-size: 1.1rem;
  margin: 0;
`;

const Muted = styled.span`
  color: ${p => p.theme.colors.textLight};
  font-size: 0.9rem;
`;

const WorkspaceTabs = styled(Tabs)`
  min-width: 0;
  > [role='tablist'] {
    overflow-x: auto;
    justify-content: flex-start;
    > [role='tab'] {
      flex: 0 0 auto;
      white-space: nowrap;
    }
  }
`;

const PageHeader = styled(Row)`
  flex-wrap: wrap;
  gap: 1rem;
  > button {
    flex-shrink: 0;
  }
`;
const Panel = styled(Tabs.Panel)`
  min-width: 0;
  padding-top: 0.75rem;
  &[data-state='active'] {
    display: flex;
    flex-direction: column;
    gap: 1.75rem;
  }
  h2,
  h3 {
    margin: 0;
    font-size: 1.15rem;
  }
  p {
    margin: 0;
    line-height: 1.6;
  }
  summary {
    padding-block: 0.5rem;
    cursor: pointer;
  }
  details[open] > summary {
    margin-bottom: 0.75rem;
  }
  > button {
    align-self: flex-start;
  }
`;

import { Button } from '@components/Button';
import { Dialog, useDialog } from '@components/Dialog';
import { JSONEditor } from '@components/JSONEditor';
import Markdown from '@components/datatypes/Markdown';
import { Column, Row } from '@components/Row';
import { ConfigReference } from '@views/Plugin/ConfigReference';
import {
  grantsFor,
  type InstallationReview,
  type JSONValue,
  type ReleaseReference,
  type ReviewCapability,
} from '@tomic/react';
import type { JSONSchema7 } from 'ai';
import { useEffect, useId, useState } from 'react';
import {
  FaDesktop,
  FaFire,
  FaGlobe,
  FaHardDrive,
  FaKey,
  FaMemory,
  FaShield,
} from 'react-icons/fa6';
import toast from 'react-hot-toast';
import { styled } from 'styled-components';

/** What the review screen needs, whichever path produced the release. */
export interface PendingInstallation {
  review: InstallationReview;
  release: ReleaseReference;
  /** Shown when the manifest carries no name (catalog JS releases). */
  title?: string;
  description?: string;
  emoji?: string;
}

interface InstallationReviewDialogProps {
  pending: PendingInstallation | undefined;
  /** Called after the dialog closed, whether or not anything was installed. */
  onClose: () => void;
  onInstall: (
    pending: PendingInstallation,
    config: JSONValue | undefined,
    grants: string[],
  ) => Promise<void>;
  /** Alternative to installing, e.g. creating an editable draft. */
  secondary?: {
    label: string;
    onClick: (pending: PendingInstallation) => Promise<void> | void;
  };
}

/**
 * The one Installation review screen. The Store, the zip upload and the
 * paste-source path all end here: what the plugin asks for and why, its
 * config, and the release id that will be pinned.
 */
export const InstallationReviewDialog: React.FC<
  InstallationReviewDialogProps
> = ({ pending, onClose, onInstall, secondary }) => {
  const configLabelId = useId();
  const [config, setConfig] = useState<JSONValue>();
  const [configValid, setConfigValid] = useState(true);
  const [configSyntaxValid, setConfigSyntaxValid] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dialogProps, show, hide] = useDialog({
    onCancel: onClose,
    onSuccess: onClose,
  });

  useEffect(() => {
    if (!pending) return;
    setConfig(pending.review.defaultConfig);
    setConfigValid(true);
    setConfigSyntaxValid(true);
    show();
  }, [pending, show]);

  if (!pending) return null;

  const { review } = pending;
  const title =
    review.name && review.namespace
      ? `${review.namespace}/${review.name}`
      : (review.name ?? pending.title ?? 'plugin');
  const description = review.description ?? pending.description;
  const hasConfig =
    review.configSchema !== undefined || review.defaultConfig !== undefined;

  const run = async (action: () => Promise<void> | void) => {
    setBusy(true);

    try {
      await action();
      hide(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog {...dialogProps} width='800px'>
      <Dialog.Title>
        <h1>Install plugin</h1>
      </Dialog.Title>
      <Dialog.Content>
        <Column>
          <div>
            <Row justify='space-between' center>
              <Row center gap='0.5ch'>
                {pending.emoji && <span aria-hidden>{pending.emoji}</span>}
                <PluginName>{title}</PluginName>
              </Row>
              {review.version && <span>v{review.version}</span>}
            </Row>
            <Meta>
              {review.author && <span>by {review.author} · </span>}
              <span>{review.runtime}</span>
              {review.world !== 'extension' && <span> · {review.world}</span>}
            </Meta>
          </div>
          {description && (
            <DescriptionWrapper>
              <Markdown text={description} />
            </DescriptionWrapper>
          )}
          <CapabilityList capabilities={review.capabilities} />
          {hasConfig && (
            <>
              <Label id={configLabelId}>Config</Label>
              <JSONEditor
                labelId={configLabelId}
                initialValue={JSON.stringify(
                  review.defaultConfig ?? {},
                  null,
                  2,
                )}
                onChange={value => {
                  try {
                    setConfig(JSON.parse(value));
                    setConfigSyntaxValid(true);
                  } catch {
                    setConfigSyntaxValid(false);
                  }
                }}
                schema={review.configSchema as JSONSchema7 | undefined}
                showErrorStyling={!configValid}
                onValidationChange={setConfigValid}
              />
              {review.configSchema && (
                <ConfigReference schema={review.configSchema as JSONSchema7} />
              )}
            </>
          )}
          <details>
            <summary>Release</summary>
            <Identity>
              Pinned to <code>{pending.release.id}</code>
              {pending.release.url !== pending.release.id && (
                <>
                  <br />
                  from {pending.release.url}
                </>
              )}
            </Identity>
          </details>
        </Column>
      </Dialog.Content>
      <Dialog.Actions>
        <Button onClick={() => hide(false)} subtle disabled={busy}>
          Cancel
        </Button>
        {secondary && (
          <Button
            subtle
            disabled={busy}
            onClick={() => run(() => secondary.onClick(pending))}
          >
            {secondary.label}
          </Button>
        )}
        <Button
          disabled={busy || !configValid || !configSyntaxValid}
          onClick={() =>
            run(() => onInstall(pending, config, grantsFor(review)))
          }
        >
          {busy ? 'Installing…' : 'Install'}
        </Button>
      </Dialog.Actions>
    </Dialog>
  );
};

const LABELS: Record<string, string> = {
  network: 'Network',
  storage: 'Storage',
  'full-drive-access': 'Full Drive Access',
  'extended-fuel': 'Extended Fuel',
  'extended-memory': 'Extended Memory',
  'custom-view': 'Custom View',
};

const ICONS: Record<string, React.ReactNode> = {
  network: <FaGlobe />,
  storage: <FaHardDrive />,
  'full-drive-access': <FaShield />,
  'extended-fuel': <FaFire />,
  'extended-memory': <FaMemory />,
  'custom-view': <FaDesktop />,
};

function iconFor(capability: ReviewCapability): React.ReactNode {
  if (ICONS[capability.title]) return ICONS[capability.title];

  switch (capability.kind) {
    case 'secret':
      return <FaKey />;
    case 'operation':
    case 'network':
      return <FaGlobe />;
    default:
      return <FaShield />;
  }
}

export const CapabilityList: React.FC<{
  capabilities: ReviewCapability[];
  title?: string;
}> = ({ capabilities, title = 'What it can do' }) => (
  <Column>
    <h3>{title}</h3>
    <List>
      {capabilities.length === 0 && (
        <li>
          <p>No permissions required</p>
        </li>
      )}
      {capabilities.map(capability => (
        <li key={`${capability.kind}:${capability.title}`}>
          <CapabilityTitle center gap='0.5ch'>
            {iconFor(capability)} {LABELS[capability.title] ?? capability.title}
          </CapabilityTitle>
          <p>{capability.reason || 'No reason provided'}</p>
        </li>
      ))}
    </List>
  </Column>
);

const PluginName = styled.span`
  font-weight: bold;
`;

const Meta = styled.p`
  color: ${p => p.theme.colors.textLight};
  margin: 0;
`;

const DescriptionWrapper = styled.div`
  background-color: ${p => p.theme.colors.bg1};
  padding: ${p => p.theme.size()};
  border-radius: ${p => p.theme.radius};
`;

const Label = styled.label`
  font-weight: bold;
`;

const Identity = styled.p`
  overflow-wrap: anywhere;
  font-size: 0.8rem;
  color: ${p => p.theme.colors.textLight};
`;

const List = styled.ul`
  display: flex;
  flex-direction: column;
  gap: ${p => p.theme.size()};
  padding: 0;
  margin: 0;

  li {
    background-color: ${p => p.theme.colors.bg1};
    border-radius: ${p => p.theme.radius};
    list-style: none;
    padding: ${p => p.theme.size()};
    margin: 0;

    p {
      margin: 0;
    }
  }
`;

const CapabilityTitle = styled(Row)`
  font-weight: bold;
  font-size: 0.9rem;
  color: ${p => p.theme.colors.textLight};
`;

import { Button } from '@components/Button';
import { Dialog, useDialog } from '@components/Dialog';
import { JSONEditor } from '@components/JSONEditor';
import Markdown from '@components/datatypes/Markdown';
import { Column, Row } from '@components/Row';
import { ConfigReference } from '@views/Installation/ConfigReference';
import { CapabilityList } from './CapabilityList';
import {
  grantsFor,
  type InstallationReview,
  type JSONValue,
  type ReleaseReference,
} from '@tomic/react';
import type { JSONSchema7 } from 'ai';
import { useEffect, useId, useState } from 'react';
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
  /** The config already in use, for an update. Overrides the release default. */
  currentConfig?: JSONValue;
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
  /**
   * What this review is for. Updating an installed plugin shows the same
   * capabilities and config, so only the wording differs.
   */
  verb?: {
    title: string;
    confirm: string;
    busy: string;
  };
}

const INSTALL_VERB = {
  title: 'Install plugin',
  confirm: 'Install',
  busy: 'Installing…',
};

/**
 * The one Installation review screen. The Store, the zip upload and the
 * paste-source path all end here: what the plugin asks for and why, its
 * config, and the release id that will be pinned.
 */
export const InstallationReviewDialog: React.FC<
  InstallationReviewDialogProps
> = ({ pending, onClose, onInstall, secondary, verb = INSTALL_VERB }) => {
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
    setConfig(pending.currentConfig ?? pending.review.defaultConfig);
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
    review.configSchema !== undefined ||
    review.defaultConfig !== undefined ||
    pending.currentConfig !== undefined;

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
        <h1>{verb.title}</h1>
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
                  pending.currentConfig ?? review.defaultConfig ?? {},
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
            </Identity>
            <Identity hidden={pending.release.url === pending.release.id}>
              from {pending.release.url}
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
          {busy ? verb.busy : verb.confirm}
        </Button>
      </Dialog.Actions>
    </Dialog>
  );
};

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
  margin: 0;
`;

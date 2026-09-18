import { getIntegrationProxy } from '@helpers/integrationProxy';
import {
  importInstallationIdentity,
  readSavedConnection,
} from '../../../../../integrations/localthought/settings';
import { useEffect, useState } from 'react';
import { styled } from 'styled-components';
import { useStore } from '@tomic/react';
import { Button } from '@components/Button';
import { Column } from '@components/Row';
import Field from '@components/forms/Field';
import { Input, ErrMessage } from '@components/forms/InputStyles';
import { BasicSelect } from '@components/forms/BasicSelect';
import { AtomicLink } from '@components/AtomicLink';
import {
  browserIntegrations,
  proxyRequest,
  type SavedConnection,
} from './localThought';
import type { LocalThoughtExtension } from './localThoughtExtension';
import { installLocalThought, refreshLocalThought } from './localThoughtSync';
import {
  PARAMETER_OPTION_LOOKUPS,
  parameterLabel,
  parseParameterOptions,
  type ParameterOption,
} from './parameterOptions';

export function ConnectLocalThought({
  drive,
  platform,
  origin = getIntegrationProxy(),
  extension,
  entry,
}: {
  drive: string;
  platform: string;
  origin?: string;
  extension?: LocalThoughtExtension;
  entry?: string;
}) {
  return (
    <GenericConnection
      drive={drive}
      platform={platform}
      origin={origin}
      extension={extension}
      entry={entry}
    />
  );
}

function GenericConnection({
  drive,
  platform,
  origin,
  extension,
  entry,
}: {
  drive: string;
  platform: string;
  origin: string;
  extension?: LocalThoughtExtension;
  entry?: string;
}) {
  const ImportControls = extension?.ImportControls;
  const store = useStore();
  const actor = store.getAgent()?.subject ?? '';
  const [connection] = useState<SavedConnection | undefined>(() => {
    const raw = readSavedConnection(
      localStorage,
      origin,
      drive,
      actor,
      platform,
    );
    if (!raw) return;

    try {
      return JSON.parse(raw);
    } catch {
      return;
    }
  });
  const [parameters, setParameters] = useState<string[]>([]);
  const [constants, setConstants] = useState<Record<string, string>>({});
  const [parameterOptions, setParameterOptions] = useState<
    Record<string, ParameterOption[]>
  >({});
  const [collections, setCollections] = useState<string[]>([]);
  const [selection, setSelection] = useState<unknown>(() =>
    extension?.defaultSelection(),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [folder, setFolder] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    browserIntegrations(origin)
      .describe(platform)
      .then(data => {
        if (controller.signal.aborted) return;
        // Parameters with a lookup come first, in the lookup's order: the
        // platform's own order is alphabetical and says nothing about the
        // user's (a workspace before the account inside it).
        const lookupOrder = Object.keys(
          PARAMETER_OPTION_LOOKUPS[platform] ?? {},
        );

        const rank = (key: string) => {
          const index = lookupOrder.indexOf(key);

          return index === -1 ? lookupOrder.length : index;
        };

        setParameters(
          [...data.parameters].sort(
            (a: string, b: string) => rank(a) - rank(b),
          ),
        );
        setCollections(data.collections);
        setConstants(
          Object.fromEntries(
            data.parameters.map((key: string) => [
              key,
              (
                extension?.defaultConstants as
                  | Record<string, string>
                  | undefined
              )?.[key] ?? '',
            ]),
          ),
        );
      })
      .catch(reason => {
        if (!controller.signal.aborted) setError(String(reason));
      });

    return () => controller.abort();
  }, [store, platform, origin, extension?.defaultConstants]);

  useEffect(() => {
    if (!connection || folder) return;
    const lookups = PARAMETER_OPTION_LOOKUPS[platform];
    if (!lookups) return;
    let cancelled = false;
    const client = browserIntegrations(origin);

    (async () => {
      for (const [parameter, lookup] of Object.entries(lookups)) {
        if (!parameters.includes(parameter)) continue;

        try {
          const { status, body } = await client.request(
            drive,
            actor,
            connection.connection,
            platform,
            lookup.path,
          );
          if (cancelled) return;
          if (status !== 200) continue;
          const options = parseParameterOptions(body, lookup);
          if (options.length)
            setParameterOptions(prev => ({ ...prev, [parameter]: options }));
          // One choice is no choice: fill it in (an account id, say).
          if (options.length === 1)
            setConstants(prev =>
              prev[parameter]
                ? prev
                : { ...prev, [parameter]: options[0].value },
            );
        } catch {
          // Manual entry remains available when the lookup fails.
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [connection, folder, platform, origin, parameters, drive, actor]);

  const connect = async () => {
    setBusy(true);
    setError('');

    try {
      const result = await proxyRequest<{ url: string; state: string }>(
        store,
        'start',
        {
          drive,
          origin,
          platform,
          returnUrl: `${location.origin}/app/integrations`,
        },
      );
      sessionStorage.setItem(
        'localthought-pending',
        JSON.stringify({
          state: result.state,
          origin,
          drive,
          actor,
          platform,
          entry,
        }),
      );
      location.assign(result.url);
    } catch (reason) {
      setError(String(reason));
      setBusy(false);
    }
  };

  const install = async () => {
    if (!connection || busy) return;
    setBusy(true);
    setError('');

    try {
      const installed = await installLocalThought(store, {
        origin,
        drive,
        actor,
        platform,
        connection: connection.connection,
        constants,
        labels: Object.fromEntries(
          Object.entries(constants).flatMap(([parameter, value]) => {
            const label = parameterOptions[parameter]?.find(
              option => option.value === value,
            )?.label;

            return label ? [[parameter, label]] : [];
          }),
        ),
        selection:
          extension && selection ? extension.selection(selection) : undefined,
        selectionValue: extension ? selection : undefined,
        identity: importInstallationIdentity(
          connection,
          constants,
          `${extension ? `:devonian-${extension.mode}` : ':api'}${extension && selection ? extension.identitySuffix(selection) : ''}`,
        ),
        extension: extension?.mode ?? 'none',
      });
      sessionStorage.removeItem('localthought-completed');
      setFolder(installed.folder);
      // The installation is complete. Importing continues even after this dialog closes.
      void refreshLocalThought(store, installed);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const step = !connection ? 0 : !folder ? 1 : 2;

  return (
    <Column gap='0.75rem'>
      {extension?.steps && <Stepper steps={extension.steps} current={step} />}
      {!connection && (
        <>
          <p>
            Connect your personal account through LocalThought, then return here
            to choose what to sync.
          </p>
          <p>
            LocalThought will ask you to sign in and authorize this connection.
            Connection credentials stay in this browser.
          </p>
        </>
      )}
      {connection && extension?.connectionNote ? (
        <Connected>
          <span>
            <strong>{extension.label}</strong>
            <small>{extension.connectionNote}</small>
          </span>
          <Button subtle disabled={busy} onClick={connect}>
            Change key
          </Button>
        </Connected>
      ) : (
        <Button disabled={busy} onClick={connect}>
          {connection ? 'Reconnect account' : 'Install and connect'}
        </Button>
      )}
      {connection && !folder && (
        <>
          {parameters.map(parameter => {
            const options = parameterOptions[parameter];

            return (
              <Field
                key={parameter}
                fieldId={`proxy-${parameter}`}
                label={parameterLabel(platform, parameter)}
              >
                {options ? (
                  <BasicSelect
                    id={`proxy-${parameter}`}
                    value={constants[parameter] ?? ''}
                    onChange={e =>
                      setConstants({
                        ...constants,
                        [parameter]: e.target.value,
                      })
                    }
                    disabled={busy}
                  >
                    <option value='' disabled>
                      Select…
                    </option>
                    {options.map(option => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </BasicSelect>
                ) : (
                  <Input
                    id={`proxy-${parameter}`}
                    value={constants[parameter] ?? ''}
                    onChange={e =>
                      setConstants({
                        ...constants,
                        [parameter]: e.target.value,
                      })
                    }
                    disabled={busy}
                  />
                )}
              </Field>
            );
          })}
          {ImportControls && selection !== undefined && (
            <ImportControls
              value={selection}
              disabled={busy}
              onChange={setSelection}
            />
          )}
          <p>{collections.join(', ')}</p>
          <ImportScopeHelp writable={!!extension?.Sync} />
          <Button
            disabled={
              busy || !collections.length || parameters.some(p => !constants[p])
            }
            onClick={install}
          >
            {busy ? 'Checking connection…' : 'Complete installation'}
          </Button>
        </>
      )}
      {error && <ErrMessage role='alert'>{error}</ErrMessage>}
      {folder && (
        <>
          <p>Installed. Your records are syncing in the background.</p>
          <AtomicLink subject={folder}>Open folder</AtomicLink>
        </>
      )}
    </Column>
  );
}

/** The setup dialog's progress, for lenses that name their steps. */
function Stepper({
  steps,
  current,
}: {
  steps: readonly string[];
  current: number;
}) {
  return (
    <Steps aria-label='Setup progress'>
      {steps.map((label, index) => (
        <li
          key={label}
          aria-current={index === current ? 'step' : undefined}
          data-done={index < current ? '' : undefined}
        >
          <span aria-hidden>{index < current ? '✓' : index + 1}</span>
          {label}
        </li>
      ))}
    </Steps>
  );
}

const Steps = styled.ol`
  display: flex;
  gap: 0.75rem;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 0.85rem;

  li {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    color: ${p => p.theme.colors.textLight};
  }

  li[aria-current] {
    color: ${p => p.theme.colors.main};
    font-weight: 700;
  }

  li[data-done] {
    color: ${p => p.theme.colors.text};
  }

  li span {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 50%;
    background: ${p => p.theme.colors.bg2};
    font-size: 0.75rem;
    font-weight: 700;
  }

  li[aria-current] span {
    background: ${p => p.theme.colors.main};
    color: white;
  }

  li:not(:last-child)::after {
    content: '';
    flex-grow: 1;
    min-width: 1rem;
    height: 2px;
    background: ${p => p.theme.colors.bg2};
  }
`;

const Connected = styled.div`
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem;
  border-radius: ${p => p.theme.radius};
  background: ${p => p.theme.colors.bg1};

  & > span {
    display: flex;
    flex-direction: column;
    flex-grow: 1;
  }

  small {
    color: ${p => p.theme.colors.textLight};
  }
`;

function ImportScopeHelp({ writable }: { writable: boolean }) {
  return (
    <p>
      Imports the collections described by the platform, following pagination.
      Syncs automatically when you open the folder and every five minutes while
      it is open. Keep this browser open to finish importing.
      {writable
        ? ' After importing, preview supported edits to send changes back.'
        : ' No provider writes.'}
    </p>
  );
}

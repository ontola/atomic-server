import { getIntegrationProxy } from '@helpers/integrationProxy';
import {
  importInstallationIdentity,
  readSavedConnection,
} from '../../../../../integrations/localthought/settings';
import type { googleCalendarIntegration } from '@localthought/atomic-integrations/ui/GoogleCalendar';
import { useEffect, useState } from 'react';
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
import { installLocalThought, refreshLocalThought } from './localThoughtSync';
import {
  PARAMETER_OPTION_LOOKUPS,
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
  extension?: typeof googleCalendarIntegration;
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
  extension?: typeof googleCalendarIntegration;
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
  const [selection, setSelection] = useState(() =>
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
        setParameters(data.parameters);
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
        selection:
          extension && selection ? extension.selection(selection) : undefined,
        identity: importInstallationIdentity(
          connection,
          constants,
          `${extension ? ':devonian-calendar' : ':api'}${extension && selection ? extension.identitySuffix(selection) : ''}`,
        ),
        extension: extension ? 'calendar' : 'none',
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

  return (
    <Column gap='0.75rem'>
      <p>
        Connect your personal account through LocalThought, then return here to
        choose what to sync.
      </p>
      <p>
        LocalThought will ask you to sign in and authorize this connection.
        Connection credentials stay in this browser.
      </p>
      <Button disabled={busy} onClick={connect}>
        {connection ? 'Reconnect account' : 'Install and connect'}
      </Button>
      {connection && !folder && (
        <>
          {parameters.map(parameter => {
            const options = parameterOptions[parameter];

            return (
              <Field
                key={parameter}
                fieldId={`proxy-${parameter}`}
                label={parameter}
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
          {ImportControls && selection && (
            <ImportControls
              value={selection}
              disabled={busy}
              onChange={setSelection}
            />
          )}
          <p>{collections.join(', ')}</p>
          <ImportScopeHelp writable={!!extension} />
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

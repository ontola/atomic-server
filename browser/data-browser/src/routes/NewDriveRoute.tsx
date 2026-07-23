import { FormEvent, useEffect, useState, type JSX } from 'react';
import { createRoute } from '@tanstack/react-router';
import { useStore } from '@tomic/react';
import toast from 'react-hot-toast';
import { appRoute } from './RootRoutes';
import { pathNames, paths } from './paths';
import { useSettings } from '../helpers/AppSettings';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';
import { constructOpenURL } from '../helpers/navigation';
import { Main } from '../components/Main';
import { ContainerNarrow } from '../components/Containers';
import { Button } from '../components/Button';
import { Column } from '../components/Row';
import Field from '../components/forms/Field';
import { InputWrapper, InputStyled } from '../components/forms/InputStyles';
import {
  fetchManagedInfo,
  type ManagedInfo,
  EMPTY_NODE_INFO,
} from '../helpers/managedServer';
import {
  enableCloudSyncForDrive,
  ensureManagedSession,
} from '../helpers/managed/cloudSync';
import { PRODUCT_NAME } from '../helpers/managed/product';

export const NewDriveRoute = createRoute({
  path: pathNames.newDrive,
  getParentRoute: () => appRoute,
  component: () => <NewDrivePage />,
});

// Reached from the managed portal's dashboard ("+ New drive"): creates a
// drive on whichever node this device is connected to, then immediately
// enrolls it in Cloud Sync — the portal only ever holds a session cookie,
// never the agent's private key, so the drive has to be created here, not
// there. Mirrors what GettingStartedFlow does for a brand new account's
// first drive, but for an Nth drive on an already-signed-in device. See
// SyncRoute's `backupToCloud` for the enrollment half of this, reused as-is
// via `enableCloudSyncForDrive`.
function NewDrivePage(): JSX.Element {
  const store = useStore();
  const { agent, baseURL, setServer, setDrive } = useSettings();
  const navigate = useNavigateWithTransition();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  const [managedInfo, setManagedInfo] = useState<ManagedInfo>(EMPTY_NODE_INFO);

  useEffect(() => {
    if (!agent) {
      navigate(paths.welcome);
    }
  }, [agent, navigate]);

  useEffect(() => {
    let cancelled = false;

    void fetchManagedInfo(baseURL).then(info => {
      if (!cancelled) setManagedInfo(info);
    });

    return () => {
      cancelled = true;
    };
  }, [baseURL]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    const agentSubject = agent?.subject;

    if (!trimmed || busy || !agentSubject) return;

    setBusy(true);
    setError(undefined);

    try {
      const resource = await store.createDrive(trimmed, { personal: false });
      store.notifyResourceManuallyCreated(resource);
      setDrive(resource.subject);

      const args = {
        store,
        drive: resource.subject,
        agentSubject,
        setServer,
        managedInfo,
      };
      let result = await enableCloudSyncForDrive(args);

      if (!result.ok) {
        if (!result.portalUrl) {
          throw new Error(
            `No ${PRODUCT_NAME} portal is configured for this server.`,
          );
        }

        const signedIn = await ensureManagedSession(result.portalUrl);

        if (!signedIn) {
          throw new Error('Sign-in wasn’t completed — nothing was created.');
        }

        result = await enableCloudSyncForDrive(args);

        if (!result.ok) {
          throw new Error(
            `Could not enable ${PRODUCT_NAME} backup for this drive.`,
          );
        }
      }

      toast.success('Drive created');
      navigate(constructOpenURL(resource.subject));
    } catch (err) {
      const asError =
        err instanceof Error ? err : new Error('Could not create the drive.');
      store.notifyError(asError);
      setError(asError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Main>
      <ContainerNarrow>
        <Column gap='1.5rem'>
          <h1>New drive</h1>
          <form onSubmit={handleSubmit}>
            <Column gap='1rem'>
              <Field required label='Name' error={error}>
                <InputWrapper>
                  <InputStyled
                    value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder='My Drive'
                    autoFocus
                  />
                </InputWrapper>
              </Field>
              <Button type='submit' disabled={busy || !name.trim()}>
                {busy ? 'Creating…' : 'Create drive'}
              </Button>
            </Column>
          </form>
        </Column>
      </ContainerNarrow>
    </Main>
  );
}

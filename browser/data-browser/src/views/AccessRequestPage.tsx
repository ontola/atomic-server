import { useState } from 'react';
import {
  useString,
  useCreatedAt,
  useCreatedBy,
  useCanWrite,
  useResource,
  core,
  dataBrowser,
  notifications,
  grantAccessRequest,
  useStore,
} from '@tomic/react';
import toast from 'react-hot-toast';
import { FaCheck } from 'react-icons/fa6';

import { CommitDetail } from '../components/CommitDetail';
import { ContainerNarrow } from '../components/Containers';
import Markdown from '../components/datatypes/Markdown';
import { Details } from '../components/Detail';
import { ResourceInline } from './ResourceInline';
import { ResourcePageProps } from './ResourcePage';
import { Button } from '../components/Button';
import { Column } from '../components/Row';
import { ErrorLook } from '../components/ErrorLook';
import { constructOpenURL } from '../helpers/navigation';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';

/** Full-page view for an AccessRequest, with Grant when the viewer can write. */
export function AccessRequestPage({ resource }: ResourcePageProps) {
  const store = useStore();
  const navigate = useNavigateWithTransition();
  const [about] = useString(resource, dataBrowser.properties.about);
  const [right] = useString(resource, notifications.properties.requestedRight);
  const [status] = useString(
    resource,
    notifications.properties.accessRequestStatus,
  );
  const [description] = useString(resource, core.properties.description);
  const createdAt = useCreatedAt(resource);
  const createdBy = useCreatedBy(resource);
  const target = useResource(about ?? '');
  const canWriteTarget = useCanWrite(target);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const granted = status === 'granted';

  const grant = async () => {
    if (busy) {
      return;
    }

    setBusy(true);
    setError(undefined);

    try {
      await grantAccessRequest(store, resource);
      toast.success('Access granted');
      setBusy(false);

      if (about) {
        navigate(constructOpenURL(about));
      }
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <ContainerNarrow>
      <Column gap='1rem'>
        <h3>Access request</h3>
        <Details>
          <CommitDetail createdAt={createdAt} createdBy={createdBy} />
        </Details>
        <p>
          Requested <strong>{right || 'read'}</strong> access to{' '}
          {about ? <ResourceInline subject={about} /> : 'a resource'}
        </p>
        {status && <p>Status: {status}</p>}
        {description && <Markdown text={description} />}
        {error && <ErrorLook>{error}</ErrorLook>}
        {canWriteTarget && !granted && (
          <Button
            onClick={() => void grant()}
            disabled={busy}
            data-testid='grant-access'
          >
            <FaCheck />
            Grant access
          </Button>
        )}
        {granted && <p>This request has been granted.</p>}
      </Column>
    </ContainerNarrow>
  );
}

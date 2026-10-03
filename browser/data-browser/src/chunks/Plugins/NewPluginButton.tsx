import { Button } from '@components/Button';
import {
  installRelease,
  publishZipRelease,
  readInstallationReview,
  useStore,
  type JSONValue,
  type Resource,
  type Server,
} from '@tomic/react';
import { useRef, useState } from 'react';
import { FaPlus } from 'react-icons/fa6';
import { useCustomViews } from '@components/CustomViewProvider';
import { useNavigateWithTransition } from '@hooks/useNavigateWithTransition';
import { constructOpenURL } from '@helpers/navigation';
import {
  InstallationReviewDialog,
  type PendingInstallation,
} from './InstallationReviewDialog';

interface NewPluginButtonProps {
  drive: Resource<Server.Drive>;
}

/**
 * Uploading a zip publishes it as a private Release on this server and then
 * installs that release through the same review screen the Store uses. The
 * server materializes the wasm files when the Installation commits.
 */
const NewPluginButton: React.FC<NewPluginButtonProps> = ({ drive }) => {
  const store = useStore();
  const navigate = useNavigateWithTransition();
  const { refresh: refreshCustomViews } = useCustomViews();
  const [error, setError] = useState<string>();
  const [publishing, setPublishing] = useState(false);
  const [pending, setPending] = useState<PendingInstallation>();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileInputChange = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPublishing(true);
    setError(undefined);

    try {
      // The server validates the zip and translates its plugin.json into the
      // manifest the review shows; nothing is inspected client-side.
      const { id, subject, release } = await publishZipRelease(
        store,
        drive.subject,
        file,
      );
      setPending({
        review: readInstallationReview({ ...release, id }),
        release: { url: subject, id },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPublishing(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const install = async (
    p: PendingInstallation,
    config: JSONValue | undefined,
    grants: string[],
  ) => {
    // The server compares these with the zip's manifest, so they must be
    // the manifest's own identifiers.
    if (!p.review.name || !p.review.namespace) {
      throw new Error('The plugin manifest has no name or namespace');
    }

    const subject = await installRelease(store, {
      drive: drive.subject,
      release: p.release,
      name: p.review.name,
      namespace: p.review.namespace,
      description: p.review.description,
      version: p.review.version,
      config,
      grants,
    });
    await refreshCustomViews();
    navigate(constructOpenURL(subject));
  };

  return (
    <>
      <label>
        <Button as='div' disabled={publishing}>
          <FaPlus aria-hidden />{' '}
          <span>{publishing ? 'Publishing…' : 'Upload Plugin'}</span>
        </Button>
        <input
          ref={fileInputRef}
          type='file'
          style={{ display: 'none' }}
          accept='application/zip'
          disabled={publishing}
          onChange={handleFileInputChange}
        />
      </label>
      {error && <p role='alert'>{error}</p>}
      <InstallationReviewDialog
        pending={pending}
        onClose={() => setPending(undefined)}
        onInstall={install}
      />
    </>
  );
};

export default NewPluginButton;

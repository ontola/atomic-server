import { useCallback, useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import toast from 'react-hot-toast';
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  useDialog,
} from '@components/Dialog';
import { Button } from '@components/Button';
import { paths } from '../../routes/paths';
import { addMarketplace, validateCatalogUrl } from '@helpers/pluginCatalogUrl';

/** The host a marketplace URL names, or `undefined` when it is not usable. */
function validHost(url: string): string | undefined {
  try {
    return new URL(validateCatalogUrl(url)).host;
  } catch {
    return undefined;
  }
}

/**
 * Asks before adding a marketplace named by a link
 * (`/app/apps?marketplace=<url>`): its apps can be installed into your drives,
 * so a link alone must not add it. Either answer drops the
 * `marketplace` parameter from the URL.
 */
export function AddMarketplaceDialog({
  url,
}: {
  url: string;
}): React.JSX.Element | null {
  const host = validHost(url);
  const navigate = useNavigate({ from: paths.apps });
  const dropParam = useCallback(
    () =>
      navigate({
        search: previous => ({ ...previous, marketplace: undefined }),
        replace: true,
      }),
    [navigate],
  );
  const [dialogProps, show, close] = useDialog({ onCancel: dropParam });

  useEffect(() => {
    if (host) {
      show();
    } else {
      toast.error('That marketplace link is not a valid catalog URL.');
      dropParam();
    }
  }, [host, show, dropParam]);

  if (!host) return null;

  return (
    <Dialog {...dialogProps}>
      <DialogTitle>
        <h1>Add marketplace {host}?</h1>
      </DialogTitle>
      <DialogContent>
        <p>
          Apps from it can be installed into your drives. Only add marketplaces
          you trust.
        </p>
        <p>
          <code>{url}</code>
        </p>
      </DialogContent>
      <DialogActions>
        <Button subtle onClick={() => close()}>
          Cancel
        </Button>
        <Button
          onClick={() => {
            addMarketplace(url);
            // The page stops rendering this dialog as soon as the marketplace
            // is listed, so the parameter goes now, not on close.
            dropParam();
            close(true);
          }}
        >
          Add marketplace
        </Button>
      </DialogActions>
    </Dialog>
  );
}

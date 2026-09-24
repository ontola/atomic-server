import React from 'react';
import toast from 'react-hot-toast';
import { paths } from '../routes/paths';

/** Creating a writable home is not evidence that old data has been recovered. */
export function privateHomeNudge() {
  toast(
    <span>
      Your home is ready. Have data elsewhere?{' '}
      <a href={paths.sync}>Connect another device or restore a backup</a>.
    </span>,
    { id: 'private-home-recovery', duration: 12_000 },
  );
}

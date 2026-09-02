import { AtomicError, Resource, useStore } from '@tomic/react';
import { useCallback, useState } from 'react';
import { errorHandler } from '../handlers/errorHandler';

export interface UseUploadResult {
  /** Uploads files to the upload endpoint and returns the created subjects. */
  upload: (acceptedFiles: File[]) => Promise<string[]>;
  isUploading: boolean;
  error: Error | undefined;
}

export function useUpload(parentResource: Resource): UseUploadResult {
  const store = useStore();
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<Error | undefined>(undefined);

  const upload = useCallback(
    async (acceptedFiles: File[]) => {
      try {
        setError(undefined);
        setIsUploading(true);
        // The uploaded files get `parent` set server-side; children are
        // resolved via the `parent=` query, so no explicit child list needs
        // maintaining here.
        const allUploaded = await store.uploadFiles(
          acceptedFiles,
          parentResource.subject,
        );
        setIsUploading(false);

        return allUploaded;
      } catch (e) {
        setError(new AtomicError(e?.message));
        setIsUploading(false);
        errorHandler(e);

        return [];
      }
    },
    [parentResource, store],
  );

  return {
    upload,
    isUploading,
    error,
  };
}

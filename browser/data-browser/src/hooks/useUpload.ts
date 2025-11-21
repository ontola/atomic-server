import {
  AtomicError,
  dataBrowser,
  Resource,
  useArray,
  useStore,
} from '@tomic/react';
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
  const [subResources, setSubResources] = useArray(
    parentResource,
    dataBrowser.properties.subResources,
  );

  const upload = useCallback(
    async (acceptedFiles: File[]) => {
      try {
        setError(undefined);
        setIsUploading(true);
        const netUploaded = await store.uploadFiles(
          acceptedFiles,
          parentResource.subject,
        );
        const allUploaded = [...netUploaded];

        await setSubResources([...subResources, ...allUploaded]);
        await parentResource.save();
        setIsUploading(false);

        return allUploaded;
      } catch (e) {
        setError(new AtomicError(e?.message));
        setIsUploading(false);
        errorHandler(e);

        return [];
      }
    },
    [parentResource, store, setSubResources, subResources],
  );

  return {
    upload,
    isUploading,
    error,
  };
}

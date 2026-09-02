import { Resource } from '@tomic/react';
import { useCallback, useMemo, type JSX } from 'react';
import { useDropzone, type Accept } from 'react-dropzone';
import { FaUpload } from 'react-icons/fa6';
import { styled } from 'styled-components';
import { ErrMessage } from '../InputStyles';
import { useUpload } from '../../../hooks/useUpload';

export interface FileDropzoneInputProps {
  parentResource: Resource;
  onFilesUploaded?: (files: string[]) => void;
  text?: string;
  maxFiles?: number;
  className?: string;
  accept?: string[];
}

/**
 * A dropzone for adding files. Renders its children by default, unless you're
 * holding a file, an error occurred, or it's uploading.
 */
export function FileDropzoneInput({
  accept,
  parentResource,
  text,
  maxFiles,
  className,
  onFilesUploaded,
}: FileDropzoneInputProps): JSX.Element {
  const { upload, isUploading, error } = useUpload(parentResource);
  const acceptedMimeTypes = useMemo<Accept | undefined>(
    () =>
      accept
        ? Object.fromEntries(accept.map(mimeType => [mimeType, []]))
        : undefined,
    [accept],
  );

  const onFileSelect = useCallback(
    async (files: File[]) => {
      const uploaded = await upload(files);

      if (uploaded.length > 0) {
        onFilesUploaded?.(uploaded);
      }
    },
    [upload, onFilesUploaded],
  );

  const { getRootProps, getInputProps } = useDropzone({
    onDrop: onFileSelect,
    maxFiles,
    accept: acceptedMimeTypes,
  });

  const defaultText =
    maxFiles === 1
      ? 'Drop a file or click here to upload.'
      : 'Drop files or click here to upload.';

  return (
    <>
      {/* react-dropzone's getRootProps() defaults to role="presentation",
         which hides the dropzone from the accessibility tree. This control
         is keyboard-activatable and opens a file dialog — it IS a button.
         Pass `role: 'button'` so screen-readers, keyboard users, and the
         e2e selector (getByRole('button', { name: 'Drop files…' })) can
         all find it. */}
      <VisualDropZone
        {...getRootProps({ role: 'button' })}
        className={className}
      >
        {error && <ErrMessage>{error.message}</ErrMessage>}
        <input {...getInputProps()} />
        <TextWrapper>
          <FaUpload /> {isUploading ? 'Uploading...' : (text ?? defaultText)}
        </TextWrapper>
      </VisualDropZone>
    </>
  );
}

const VisualDropZone = styled.div`
  backdrop-filter: blur(10px);
  border: 2px dashed ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
  display: grid;
  place-items: center;
  font-size: 1.3rem;
  color: ${p => p.theme.colors.textLight};
  min-height: 10rem;
  cursor: pointer;

  &:hover,
  &:focus {
    color: ${p => p.theme.colors.main};
    border-color: ${p => p.theme.colors.main};
  }
`;

const TextWrapper = styled.div`
  display: flex;
  align-items: center;
  padding: ${p => p.theme.margin}rem;
  gap: 1rem;
`;

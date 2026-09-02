import { useEffect, useRef, useState } from 'react';
import { FilePickerDialog } from './FilePickerDialog';
import { InputProps } from '../ResourceField';
import { StoreEvents, useStore, useSubject } from '@tomic/react';
import { useUpload } from '../../../hooks/useUpload';
import { VisuallyHidden } from '../../VisuallyHidden';
import { styled } from 'styled-components';
import { ClearType, FilePickerButton } from './FilePickerButton';
import {
  useValidation,
  checkForInitialRequiredValue,
} from '../formValidation/useValidation';
import { ErrMessage } from '../InputStyles';

/**
 * Button that opens a dialog that lists all files in the drive and allows the user to upload a new file.
 * Handles uploads and makes sure files are uploaded even when the parent resource is not saved yet.
 */
export function FilePicker({
  resource,
  property,
  disabled,
  required,
  commit,
  allowedMimes,
}: InputProps & { allowedMimes?: Set<string> }): React.JSX.Element {
  const store = useStore();
  const { upload } = useUpload(resource);
  const [value, setValue] = useSubject(resource, property.subject, {
    validate: false,
    commit: commit,
  });
  const { error, setError, setTouched } = useValidation(
    checkForInitialRequiredValue(value, required),
  );

  const [show, setShow] = useState(false);
  const [selectedSubject, setSelectedSubject] = useState<string | undefined>(
    value,
  );
  const [selectedFile, setSelectedFile] = useState<File | undefined>();

  const [unsubScheduledUpload, setUnsubScheduledUpload] =
    useState<() => void | undefined>();

  // `selectedSubject` starts out mirroring the resource's current value; this
  // effect exists only to push USER-driven picks/clears back into the
  // resource. Skip when nothing has actually changed from that starting
  // snapshot — otherwise this fires on mount and dirties the resource with a
  // no-op write. A "have we run before" ref doesn't work here: React
  // StrictMode double-invokes mount effects (mount → cleanup → mount) and,
  // since this effect has no cleanup to reset such a ref, the second
  // invocation would see it already flipped and run the real body anyway.
  // Comparing against a static snapshot is immune to that replay.
  const initial = useRef({
    subject: value,
    file: undefined as File | undefined,
  });

  useEffect(() => {
    if (
      selectedSubject === initial.current.subject &&
      selectedFile === initial.current.file
    ) {
      return;
    }

    if (selectedSubject) {
      setValue(selectedSubject);
    } else if (selectedFile) {
      if (resource.new) {
        // We can't upload the file yet because its parent has not saved yet so we set the value to a placeholder and then schedule an upload when the resource is saved.
        setValue('https://placeholder');
        setUnsubScheduledUpload(prevUnsub => {
          prevUnsub?.();

          const thisUnsub = store.on(
            StoreEvents.ResourceSaved,
            async savedResource => {
              if (savedResource.subject === resource.subject) {
                thisUnsub();
                const [subject] = await upload([selectedFile]);
                await setValue(subject);
                resource.save();
              }
            },
          );

          return thisUnsub;
        });
      } else {
        upload([selectedFile]).then(([subject]) => {
          setValue(subject);
        });
      }
    } else {
      setValue(undefined);

      if (required) {
        setError('Required');
      }

      return;
    }

    setError(undefined);
  }, [selectedSubject, selectedFile]);

  return (
    <Wrapper>
      <VisuallyHidden aria-hidden='true'>
        {value}
        <input
          tabIndex={-1}
          type='text'
          defaultValue={value ?? ''}
          required={required}
          disabled={disabled}
        />
      </VisuallyHidden>
      <FilePickerButton
        file={selectedFile}
        subject={selectedSubject}
        disabled={disabled}
        onButtonClick={() => {
          setShow(true);
          setTouched();
        }}
        onClear={clearType => {
          if (clearType === ClearType.File) {
            setSelectedFile(undefined);
            unsubScheduledUpload?.();
          } else {
            setSelectedSubject(undefined);
          }
        }}
      />
      <FilePickerDialog
        show={show}
        onShowChange={setShow}
        onResourcePicked={setSelectedSubject}
        onNewFilePicked={setSelectedFile}
        allowedMimes={allowedMimes}
      />
      {error && <ErrMessage>{error}</ErrMessage>}
    </Wrapper>
  );
}

const Wrapper = styled.div`
  position: relative;
`;

import React, { useState, useRef } from 'react';
import { type PickFileArgs } from '@tomic/plugin';
import { FilePickerDialog } from '@components/forms/FilePicker/FilePickerDialog';

export type PickFileFn = (args?: PickFileArgs) => Promise<string | undefined>;

export function useFilePicker(): [PickFileFn, React.ReactNode] {
  const [show, setShow] = useState(false);
  const [allowedMimes, setAllowedMimes] = useState<Set<string> | undefined>(
    undefined,
  );
  const resolverRef = useRef<((value: string | undefined) => void) | undefined>(
    undefined,
  );

  const pickFile = (args: PickFileArgs = {}) => {
    setAllowedMimes(args.allowedMimes ? new Set(args.allowedMimes) : undefined);
    setShow(true);

    return new Promise<string | undefined>(resolve => {
      resolverRef.current = resolve;
    });
  };

  const handleResourcePicked = (subject: string) => {
    resolverRef.current?.(subject);
    setShow(false);
  };

  const handleShowChange = (newShow: boolean) => {
    if (!newShow && show) {
      resolverRef.current?.(undefined);
    }

    setShow(newShow);
  };

  const dialog = (
    <FilePickerDialog
      show={show}
      onShowChange={handleShowChange}
      onResourcePicked={handleResourcePicked}
      allowedMimes={allowedMimes}
    />
  );

  return [pickFile, dialog];
}

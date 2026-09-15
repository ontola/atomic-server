import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { InternalDialogProps } from './index';

export type UseDialogReturnType = [
  /** Props meant to pass to a {@link Dialog} component */
  dialogProps: InternalDialogProps,
  /** Function to show the dialog */
  show: () => void,
  /** Function to close the dialog */
  close: (success?: boolean) => void,
  /** Boolean indicating wether the dialog is currently open */
  isOpen: boolean,
];

export type UseDialogOptions<E extends HTMLElement> = {
  bindShow?: React.Dispatch<boolean>;
  onCancel?: () => void;
  onSuccess?: () => void;
  triggerRef?: React.RefObject<E | null>;
};

/** Sets up state, and functions to use with a {@link Dialog} */
export function useDialog<E extends HTMLElement>(
  options?: UseDialogOptions<E>,
): UseDialogReturnType {
  const { bindShow, onCancel, onSuccess, triggerRef } = options ?? {};

  const [showDialog, setShowDialog] = useState(false);
  const [visible, setVisible] = useState(false);
  const [wasSuccess, setWasSuccess] = useState(false);
  const [instantClose, setInstantClose] = useState(false);

  const show = useCallback(() => {
    document.body.setAttribute('inert', '');
    setShowDialog(true);
    setVisible(true);
    bindShow?.(true);
  }, [bindShow]);

  const close = useCallback((success = false) => {
    setWasSuccess(success);
    setInstantClose(success);
    setShowDialog(false);
  }, []);

  const handleClosed = useCallback(() => {
    document.body.removeAttribute('inert');
    bindShow?.(false);
    setVisible(false);
    setInstantClose(false);

    if (wasSuccess) {
      onSuccess?.();
    } else {
      onCancel?.();
    }

    setWasSuccess(false);

    triggerRef?.current?.focus();
  }, [wasSuccess, onSuccess, onCancel, bindShow, triggerRef]);

  // If the component using this dialog gets unmounted while the dialog is still
  // open (e.g. navigating away without closing it first), `handleClosed` never
  // runs and `inert` is left on `<body>` forever, making the whole app
  // unclickable. Clear it on unmount as a fallback.
  const visibleRef = useRef(visible);

  useEffect(() => {
    visibleRef.current = visible;
  }, [visible]);

  useEffect(() => {
    return () => {
      if (visibleRef.current) {
        document.body.removeAttribute('inert');
      }
    };
  }, []);

  /** Props that should be passed to a {@link Dialog} component. */
  const dialogProps = useMemo<InternalDialogProps>(
    () => ({
      show: showDialog,
      instantClose,
      onClose: close,
      onClosed: handleClosed,
    }),
    [showDialog, instantClose, close, handleClosed],
  );

  return [dialogProps, show, close, visible];
}

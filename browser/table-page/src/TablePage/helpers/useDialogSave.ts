import { useCallback, useRef, useState } from 'react';

export function useDialogSave(hide: (success?: boolean) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pending = useRef(false);
  const clearError = useCallback(() => setError(undefined), []);

  const submit = async (save: () => void | Promise<void>) => {
    if (pending.current) return;

    pending.current = true;
    setBusy(true);
    clearError();

    try {
      await save();
      hide(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  const cancel = () => {
    if (!pending.current) hide();
  };

  return { busy, error, clearError, submit, cancel };
}

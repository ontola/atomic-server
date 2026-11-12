import { Button } from '@components/Button';

/** A failed configuration remains queued until the user explicitly retries. */
export function ViewSaveError({
  message,
  saving,
  retry,
}: {
  message?: string;
  saving: boolean;
  retry: () => void;
}) {
  if (!message) return null;

  return (
    <div role='alert'>
      <p>Could not save view changes: {message}</p>
      <Button onClick={retry} disabled={saving}>
        Retry view save
      </Button>
    </div>
  );
}

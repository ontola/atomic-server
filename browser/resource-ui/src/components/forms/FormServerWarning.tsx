import { useServerConnected } from '../../hooks/useServerConnected.js';
import { WarningBlock } from '@tomic/ui/components/WarningBlock';

export function FormServerWarning() {
  const serverConnected = useServerConnected();

  if (serverConnected) return null;

  return (
    <WarningBlock>
      <WarningBlock.Title>No server connected</WarningBlock.Title>
      <p>
        You can create and edit this form, but you need to connect to a server
        before you can publish it and receive responses.
      </p>
    </WarningBlock>
  );
}

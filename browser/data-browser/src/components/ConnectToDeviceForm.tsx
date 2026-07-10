import { useState, type JSX } from 'react';
import { styled } from 'styled-components';
import toast from 'react-hot-toast';
import { FaCamera } from 'react-icons/fa6';
import { Button } from './Button';
import { scanPairingCode } from '../helpers/scanPairingCode';
import { isMobileTauri } from '../helpers/tauri';

interface ConnectToDeviceFormProps {
  /** Receives a raw scanned/pasted code — not yet known to be well-formed. */
  onCode: (code: string) => void;
  disabled?: boolean;
}

/**
 * The two ways to take in another device's pairing code: scan its QR with the
 * camera (phones and tablets), or paste the code as text (everywhere).
 */
export function ConnectToDeviceForm({
  onCode,
  disabled,
}: ConnectToDeviceFormProps): JSX.Element {
  const [typedCode, setTypedCode] = useState('');

  const scan = async () => {
    const result = await scanPairingCode();

    if (result.kind === 'code') {
      onCode(result.code);
    } else if (result.kind === 'denied') {
      toast.error('Camera access is needed to scan a code.');
    } else if (result.kind === 'unavailable') {
      toast.error('Could not open the scanner.');
    }
  };

  const submit = () => {
    const code = typedCode.trim();

    if (code) {
      onCode(code);
    }
  };

  return (
    <>
      {isMobileTauri() && (
        <ScanButton onClick={scan} disabled={disabled}>
          <ScanButtonInner>
            <FaCamera aria-hidden /> Scan a QR code
          </ScanButtonInner>
        </ScanButton>
      )}
      <CodeForm
        onSubmit={e => {
          e.preventDefault();
          submit();
        }}
      >
        <CodeInput
          autoComplete='off'
          placeholder='Paste atomic://pair… code'
          value={typedCode}
          onChange={e => setTypedCode(e.target.value)}
        />
        <Button type='submit' subtle disabled={disabled || !typedCode.trim()}>
          Connect
        </Button>
      </CodeForm>
    </>
  );
}

const ScanButton = styled(Button)`
  margin-bottom: 0.6rem;
`;

const ScanButtonInner = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
`;

const CodeForm = styled.form`
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
`;

const CodeInput = styled.input`
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
  padding: 0.5rem 0.6rem;
  font-size: 0.85rem;
  background: ${p => p.theme.colors.bg};
  color: ${p => p.theme.colors.text};
  width: 100%;
  box-sizing: border-box;
`;

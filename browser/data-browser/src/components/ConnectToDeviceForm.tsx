import { useState, type JSX } from 'react';
import { styled } from 'styled-components';
import { Button } from './Button';

interface ConnectToDeviceFormProps {
  /** Receives a raw pasted code — not yet known to be well-formed. */
  onCode: (code: string) => void;
  disabled?: boolean;
}

/**
 * Takes in another device's pairing code, pasted as text.
 */
export function ConnectToDeviceForm({
  onCode,
  disabled,
}: ConnectToDeviceFormProps): JSX.Element {
  const [typedCode, setTypedCode] = useState('');

  const submit = () => {
    const code = typedCode.trim();

    if (code) {
      onCode(code);
    }
  };

  return (
    <>
      <CodeForm
        onSubmit={e => {
          e.preventDefault();
          submit();
        }}
      >
        <CodeInput
          autoComplete='off'
          placeholder='Paste a pairing code or did:ad:node:…'
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

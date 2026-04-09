import { styled } from 'styled-components';
import { FaEye, FaEyeSlash } from 'react-icons/fa6';
import { Button } from './Button';
import { useMemo, useState } from 'react';
import { CodeBlock } from './CodeBlock';
import { Column } from './Row';
import { LoroLoader } from '@tomic/lib';

interface LoroDocValueProps {
  value: Uint8Array | string | undefined;
}

function inspectLoroSnapshot(
  value: Uint8Array,
): { properties: Record<string, unknown>; peers: number } | null {
  if (!LoroLoader.isLoaded()) return null;

  try {
    const { LoroDoc } = LoroLoader.Loro;
    const doc = new LoroDoc();
    doc.import(value);
    const propsMap = doc.getMap('properties');
    const properties = propsMap.toJSON() as Record<string, unknown>;

    // Count unique peers from the oplog version (a Map<peerId, counter>)
    const version = doc.oplogVersion();
    const peers = version ? Object.keys(version).length : 0;

    return { properties, peers };
  } catch {
    return null;
  }
}

export const LoroDocValue: React.FC<LoroDocValueProps> = ({ value: rawValue }) => {
  const [showState, setShowState] = useState(false);

  // Normalize: base64 strings (from server JSON-AD) → Uint8Array
  const value = useMemo(() => {
    if (!rawValue) return undefined;
    if (rawValue instanceof Uint8Array) return rawValue;
    if (typeof rawValue === 'string') {
      try {
        const binary = atob(rawValue);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
      } catch { return undefined; }
    }
    return undefined;
  }, [rawValue]);

  const inspection = useMemo(
    () => (value && showState ? inspectLoroSnapshot(value) : null),
    [value, showState],
  );

  if (!value) {
    return <span>Empty</span>;
  }

  const sizeStr =
    value.byteLength < 1024
      ? `${value.byteLength} B`
      : `${(value.byteLength / 1024).toFixed(1)} KB`;

  return (
    <Column gap='0px' fullHeight justify='center'>
      <SubtleButton clean onClick={() => setShowState(!showState)}>
        {showState ? <FaEyeSlash /> : <FaEye />}
        {showState ? 'Hide' : 'Inspect'} Loro snapshot ({sizeStr}
        {inspection ? `, ${inspection.peers} peer(s)` : ''})
      </SubtleButton>
      {showState && inspection && (
        <CodeBlock
          wordWrap
          content={JSON.stringify(inspection.properties, null, 2)}
        />
      )}
      {showState && !inspection && (
        <CodeBlock wordWrap content='Failed to decode Loro snapshot' />
      )}
    </Column>
  );
};

const SubtleButton = styled(Button)`
  color: ${p => p.theme.colors.textLight};
  display: flex;
  align-items: center;
  gap: 0.5rem;
  &:hover,
  &:focus-visible {
    color: ${p => p.theme.colors.main};
  }
`;

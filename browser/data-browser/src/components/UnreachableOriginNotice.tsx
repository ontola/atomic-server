import type { JSX } from 'react';
import { useStore } from '@tomic/react';
import { styled } from 'styled-components';
import { isPrivateOrigin } from '../helpers/isPrivateOrigin';

const DOCS_URL = 'https://docs.atomicdata.dev/atomicserver/installation';

/**
 * A short, non-blocking note for screens that hand out something built on the
 * server's address (invite links, pairing codes). Shown only when that address
 * is localhost or a private one, which nobody else can reach.
 */
export function UnreachableOriginNotice(): JSX.Element | null {
  const store = useStore();

  if (!isPrivateOrigin(store.getServerUrl())) return null;

  return (
    <Note role='note' data-testid='unreachable-origin-notice'>
      Other people and devices cannot reach this address. Give the server a
      public HTTPS address to share or sync.
      <a href={DOCS_URL} target='_blank' rel='noopener noreferrer'>
        Read the docs
      </a>
    </Note>
  );
}

const Note = styled.p`
  margin: 0;
  padding: 0.5rem 0.75rem;
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
  background-color: ${p => p.theme.colors.bg1};
  color: ${p => p.theme.colors.textLight};
  font-size: 0.82rem;

  a {
    display: block;
  }
`;

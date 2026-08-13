import { useEffect, useRef, useState } from 'react';
import { styled } from 'styled-components';
import { FaCloudArrowUp } from 'react-icons/fa6';
import {
  cardSurface,
  CARD_ACTIONS_GAP,
  CARD_BODY_GAP,
  CARD_ICON_FONT,
  CARD_ICON_SIZE,
  CARD_SUB_FONT,
  CARD_TITLE_FONT,
} from '../cardSurface';
import { Button } from '../Button';
import { PRODUCT_NAME } from '../../helpers/managed/product';
import {
  approvalUrl,
  awaitDeviceLink,
  requestDeviceLink,
  type LinkRequest,
} from '../../helpers/managed/deviceLink';

/**
 * Connect this install to a hosted provider.
 *
 * Shown only when a provider is known — a build with none configured renders
 * nothing at all, so a self-hosted install never sees a prompt for a product it
 * has not asked about. The URL is a prop rather than a constant here for the
 * same reason: this component knows how to link, not who to.
 *
 * The user reads a short code off this screen and approves it in a browser
 * where they are already signed in. Deliberately not a redirect: returning from
 * an external browser into an app is the step that fails most often on Android,
 * and it cannot work at all when someone finishes on a different device. The
 * link below is an accelerator for the common case, not the mechanism.
 */
export function LinkProviderPanel({
  portalUrl,
  onLinked,
}: {
  /** Absent on a build with no provider — the panel then renders nothing. */
  portalUrl: string | null;
  onLinked: () => void;
}) {
  const [request, setRequest] = useState<LinkRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);

  // Stop polling when this unmounts. A code the user walked away from should
  // not leave a request running for its full ten minutes.
  useEffect(() => () => abort.current?.abort(), []);

  if (!portalUrl) return null;

  async function start() {
    if (!portalUrl) return;

    setBusy(true);
    setError(null);

    try {
      const issued = await requestDeviceLink(portalUrl);
      setRequest(issued);

      abort.current?.abort();
      abort.current = new AbortController();

      const outcome = await awaitDeviceLink(portalUrl, issued, {
        signal: abort.current.signal,
      });

      if (outcome === 'linked') {
        setRequest(null);
        onLinked();
      } else {
        setRequest(null);
        setError('That code expired. Start again when you are ready.');
      }
    } catch (e) {
      setRequest(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel data-testid='link-provider-panel'>
      <Icon>
        <FaCloudArrowUp />
      </Icon>
      <Body>
        <Title>Connect your {providerName(portalUrl)} account</Title>

        {request ? (
          <>
            <Sub>
              Open{' '}
              <Link
                href={approvalUrl(portalUrl, request.user_code)}
                target='_blank'
                rel='noreferrer'
              >
                {hostOf(portalUrl)}/link
              </Link>{' '}
              on a device where you are signed in, and enter this code.
            </Sub>
            <Code data-testid='link-user-code'>{request.user_code}</Code>
            <Sub>Waiting for you to approve it…</Sub>
          </>
        ) : (
          <>
            <Sub>
              This app cannot sign in on its own, so approve it from somewhere
              you already are. Then it can keep an encrypted copy of your
              workspaces — sealed here, so {providerName(portalUrl)} stores it
              without being able to read it.
            </Sub>
            {error && <ErrorText data-testid='link-error'>{error}</ErrorText>}
            <Actions>
              <Button
                data-testid='link-provider-start'
                onClick={start}
                disabled={busy}
              >
                {busy ? 'Getting a code…' : 'Connect this device'}
              </Button>
            </Actions>
          </>
        )}
      </Body>
    </Panel>
  );
}

/**
 * What to call the provider in prose.
 *
 * The product name when this is the product's own control plane, and the bare
 * host otherwise — a self-hoster pointing at their own deployment should not
 * be told they are connecting to ours. In development that also means the
 * shipped wording is what you see, rather than `localhost:3030`.
 */
function providerName(url: string): string {
  const host = hostOf(url);

  return host.toLowerCase() === PRODUCT_NAME.toLowerCase()
    ? PRODUCT_NAME
    : host;
}

/** `https://atomicserver.eu/` → `atomicserver.eu`, for prose. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  }
}

const Panel = styled.div`
  ${cardSurface}
  margin-bottom: 1.5rem;
`;

const Icon = styled.div`
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: ${CARD_ICON_SIZE};
  height: ${CARD_ICON_SIZE};
  font-size: ${CARD_ICON_FONT};
  border-radius: 50%;
  background-color: ${p => p.theme.colors.main};
  color: white;
`;

const Body = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${CARD_BODY_GAP};
  min-width: 0;
`;

const Title = styled.h3`
  margin: 0;
  font-size: ${CARD_TITLE_FONT};
  font-weight: 600;
`;

const Sub = styled.p`
  margin: 0;
  color: ${p => p.theme.colors.textLight};
  font-size: ${CARD_SUB_FONT};
`;

const ErrorText = styled.p`
  margin: 0;
  color: ${p => p.theme.colors.alert};
  font-size: ${CARD_SUB_FONT};
`;

const Link = styled.a`
  color: ${p => p.theme.colors.main};
`;

/** Big and spaced: this is read off one screen and typed into another. */
const Code = styled.output`
  font-family: monospace;
  font-size: 1.5rem;
  letter-spacing: 0.15em;
  margin: 0.4rem 0;
  color: ${p => p.theme.colors.text};
`;

const Actions = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: ${CARD_ACTIONS_GAP};
  margin-top: ${CARD_ACTIONS_GAP};
`;

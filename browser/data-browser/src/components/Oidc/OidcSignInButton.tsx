import { type JSX } from 'react';
import { FaIdBadge } from 'react-icons/fa6';
import { CtaButton } from '../../views/getting-started/chrome';
import { oidcStartUrl } from '../../helpers/oidc/oidcClient';
import { paths } from '../../routes/paths';

type Props = {
  /** The server the sign-in goes through. */
  serverUrl: string;
  /** The provider's display name, as the server advertises it. */
  providerName: string;
};

/**
 * "Sign in with <provider>", for servers whose operator configured OIDC.
 * Rendered by its parent only when `/server` advertises a provider.
 */
export function OidcSignInButton({
  serverUrl,
  providerName,
}: Props): JSX.Element {
  return (
    <CtaButton
      type='button'
      subtle
      data-testid='oidc-sign-in'
      onClick={() =>
        window.location.assign(oidcStartUrl(serverUrl, paths.oidc))
      }
    >
      <FaIdBadge />
      Sign in with {providerName}
    </CtaButton>
  );
}

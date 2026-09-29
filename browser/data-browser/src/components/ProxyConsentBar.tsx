import { styled } from 'styled-components';

/**
 * The consent step before an account is connected through the integration
 * proxy: what will happen ({@link ProxyConsentText}), and a row of buttons
 * that do it. Used by an app's frame (`AppFrame`) and by an Installation's
 * connections.
 *
 * Plain children rather than props holding JSX, so wuchale extracts the text
 * and buttons like any other markup.
 */
export const ProxyConsentBar = styled.div.attrs({ role: 'group' })`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
  padding: 0.5rem 0.75rem;
  border: 1px solid ${p => p.theme.colors.main};
  border-radius: ${p => p.theme.radius};
  background-color: ${p => p.theme.colors.bg1};
  margin-bottom: 0.5rem;
`;

export const ProxyConsentText = styled.span`
  color: ${p => p.theme.colors.textLight};
  overflow-wrap: anywhere;
  min-width: 0;
`;

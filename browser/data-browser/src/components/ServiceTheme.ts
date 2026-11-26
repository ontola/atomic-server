import { styled } from 'styled-components';
import '@tomic/service-ui/styles.css';

/** The app's theme as the variables the shared sign-in styles read, so the
 * account options and the app's own unlock form look like one card. */
export const ServiceTheme = styled.div`
  --service-accent: ${p => p.theme.colors.main};
  --service-surface: ${p => p.theme.colors.bg};
  --service-on-accent: ${p => p.theme.colors.bg};
  --service-muted: ${p => p.theme.colors.textLight};
  --service-text: ${p => p.theme.colors.text};
  --service-border: ${p => p.theme.colors.bg2};
  --service-input-bg: ${p => p.theme.colors.bg};
  --service-radius: ${p => p.theme.radius};
`;

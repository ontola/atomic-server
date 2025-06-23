import * as React from 'react';
import { type JSX, useMemo } from 'react';
import { styled } from 'styled-components';

import { SideBar } from './SideBar';
import { OverlayContainer } from './OverlayContainer';
import { CalculatedPageHeight } from '../globalCssVars';
import { AISidebarContextProvider } from './AI/AISidebarContext';
import { AISidebarContainer } from './AI/AISidebarContainer';
import { HideInPrint } from './HideInPrint';
import { MAIN_CONTAINER } from '@helpers/containers';
import { useCurrentSubject } from '../helpers/useCurrentSubject';
import { useResource, type Resource } from '@tomic/react';
import NavBarContent from './NavBar';
import { useLocation } from '@tanstack/react-router';
import { useSettings } from '../helpers/AppSettings';
import { paths } from '../routes/paths';
import { useRootWelcomeLayout } from '../context/RootWelcomeLayoutContext';

interface NavWrapperProps {
  children: React.ReactNode;
}

const AISidebarMemo = React.memo(AISidebarContainer);

/** Wraps the entire app and adds a navbar at the top or bottom */
export function NavWrapper({ children }: NavWrapperProps): JSX.Element {
  const { navbarTop } = useSettings();
  const { rootWelcomeChromeHidden } = useRootWelcomeLayout();
  const [subject] = useCurrentSubject();
  const { pathname, searchStr } = useLocation();

  const onboardingOrChild =
    pathname === paths.onboarding ||
    pathname.startsWith(`${paths.onboarding}/`);
  const welcomeOrChild =
    pathname === paths.welcome || pathname.startsWith(`${paths.welcome}/`);
  const hideGlobalChrome =
    rootWelcomeChromeHidden || onboardingOrChild || welcomeOrChild;

  const search = useMemo(() => new URLSearchParams(searchStr), [searchStr]);

  const contextualSubject = useMemo(
    () =>
      subject ||
      search.get('parentSubject') ||
      search.get('parent') ||
      search.get('newSubject') ||
      undefined,
    [subject, search],
  );

  const resource = useResource(contextualSubject);

  return (
    <AISidebarContextProvider>
      {!hideGlobalChrome && <TopBar resource={resource} top={navbarTop} />}
      <SideBarWrapper top={navbarTop} fullViewportContent={hideGlobalChrome}>
        {!hideGlobalChrome && <SideBar />}
        <Content>{children}</Content>
        {!hideGlobalChrome && (
          <HideInPrint>
            <AISidebarMemo />
          </HideInPrint>
        )}
      </SideBarWrapper>
      <OverlayContainer />
    </AISidebarContextProvider>
  );
}

interface ContentProps {}

const Content = styled.div<ContentProps>`
  display: block;
  flex: 1;
  container: ${MAIN_CONTAINER} / inline-size;
`;

/** Persistently shown navigation bar */
function TopBar({
  resource,
  top,
}: {
  resource: Resource;
  top: boolean;
}): JSX.Element {
  return (
    <NavBarStyled aria-label='navigation' top={top}>
      <NavBarContent resource={resource} />
    </NavBarStyled>
  );
}

const NavBarStyled = styled.div<{ top: boolean }>`
  position: fixed;
  ${p => (p.top ? 'top: 0;' : 'bottom: 0;')}
  left: 0;
  right: 0;
  z-index: ${p => p.theme.zIndex.sidebar};
  height: ${p => p.theme.heights.breadCrumbBar};
  display: flex;
  background-color: ${props => props.theme.colors.bg};
  border-${p => (p.top ? 'bottom' : 'top')}: solid 1px ${props => props.theme.colors.bg2};
  container-name: nav-bar;
  container-type: inline-size;

  &:has(:focus) {
    box-shadow: 0px 0px 0px 2px ${props => props.theme.colors.main};
  }

  @media print {
    display: none;
  }
`;

const SideBarWrapper = styled.div<{
  top: boolean;
  fullViewportContent?: boolean;
}>`
  ${p =>
    p.fullViewportContent
      ? CalculatedPageHeight.define(`100dvh`)
      : CalculatedPageHeight.define(
          `calc(100dvh - ${p.theme.heights.breadCrumbBar})`,
        )}
  display: flex;
  height: ${CalculatedPageHeight.var()};
  position: fixed;
  ${p => {
    if (p.fullViewportContent) {
      return 'top: 0;';
    }

    return p.top ? `top: ${p.theme.heights.breadCrumbBar};` : 'top: 0;';
  }}
  left: 0;
  right: 0;

  opacity: 1;
  transition: opacity 0.3s ease-out;
  @starting-style {
    opacity: 0;
  }

  @media print {
    height: auto;
    ${CalculatedPageHeight.define('auto')}
    position: static;
    display: block;
  }
`;

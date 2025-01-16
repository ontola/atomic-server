import * as React from 'react';
import { type JSX } from 'react';
import { FaArrowLeft, FaArrowRight, FaBars } from 'react-icons/fa';
import { styled } from 'styled-components';

import { ButtonBar } from './Button';
import { useSettings } from '../helpers/AppSettings';
import { SideBar } from './SideBar';
import { isRunningInTauri } from '../helpers/tauri';
import { shortcuts } from './HotKeyWrapper';
import { Searchbar } from './Searchbar/Searchbar';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useBackForward } from '../hooks/useNavigateWithTransition';
import { NAVBAR_TRANSITION_TAG } from '../helpers/transitionName';
import { SearchbarFakeInput } from './Searchbar/SearchbarInput';
import { CalculatedPageHeight } from '../globalCssVars';

interface NavWrapperProps {
  children: React.ReactNode;
}
enum NavBarPosition {
  Top,
  Floating,
  Bottom,
}

const getPosition = (
  navbarTop: boolean,
  navbarFloating: boolean,
): NavBarPosition => {
  if (navbarTop) return NavBarPosition.Top;
  if (navbarFloating) return NavBarPosition.Floating;

  return NavBarPosition.Bottom;
};

/** Wraps the entire app and adds a navbar at the bottom or the top */
export function NavWrapper({ children }: NavWrapperProps): JSX.Element {
  const { navbarTop, navbarFloating } = useSettings();
  const contentRef = React.useRef<HTMLDivElement>(null);

  const navbarPosition = getPosition(navbarTop, navbarFloating);

  return (
    <>
      {navbarTop && <NavBar />}
      <SideBarWrapper navbarPosition={navbarPosition}>
        <SideBar />
        <Content
          ref={contentRef}
          navbarTop={navbarTop}
          navbarFloating={navbarFloating}
        >
          {children}
        </Content>
      </SideBarWrapper>
      {!navbarTop && <NavBar />}
    </>
  );
}

interface ContentProps {
  navbarTop: boolean;
  navbarFloating: boolean;
}

const Content = styled.div<ContentProps>`
  display: block;
  flex: 1;
  overflow-y: auto;
`;

/** Persistently shown navigation bar */
function NavBar(): JSX.Element {
  const { back, forward } = useBackForward();

  const { navbarTop, navbarFloating, sideBarLocked, setSideBarLocked } =
    useSettings();

  const machesStandalone = useMediaQuery(
    '(display-mode: standalone) or (display-mode: fullscreen)',
  );

  const isInStandaloneMode = React.useMemo<boolean>(
    () =>
      machesStandalone ||
      //@ts-ignore
      window.navigator.standalone ||
      document.referrer.includes('android-app://') ||
      isRunningInTauri(),
    [machesStandalone],
  );

  const ConditionalNavbar = navbarFloating ? NavBarFloating : NavBarFixed;

  return (
    <ConditionalNavbar
      top={navbarTop}
      aria-label='search'
      floating={navbarFloating}
    >
      <>
        <ButtonBar
          leftPadding
          type='button'
          onClick={() => setSideBarLocked(!sideBarLocked)}
          title={`Show / hide sidebar (${shortcuts.sidebarToggle})`}
          data-test='sidebar-toggle'
        >
          <FaBars />
        </ButtonBar>
        {isInStandaloneMode && (
          <>
            <ButtonBar type='button' title='Go back' onClick={back}>
              <FaArrowLeft />
            </ButtonBar>{' '}
            <ButtonBar type='button' title='Go forward' onClick={forward}>
              <FaArrowRight />
            </ButtonBar>
          </>
        )}
      </>
      <VerticalDivider />
      <Searchbar />
    </ConditionalNavbar>
  );
}

interface NavBarStyledProps {
  floating: boolean;
  top: boolean;
}

/** Don't use this directly - use NavBarFloating or NavBarFixed */
const NavBarBase = styled.div<NavBarStyledProps>`
  /* transition: all 0.2s; */
  position: fixed;
  z-index: ${p => p.theme.zIndex.sidebar};
  height: 2.5rem;
  display: flex;
  border: solid 1px ${props => props.theme.colors.bg2};
  background-color: ${props => props.theme.colors.bg};
  view-transition-name: ${NAVBAR_TRANSITION_TAG};
  container-name: search-bar;
  container-type: inline-size;

  /* Hide buttons when the searchbar is small and has focus. */
  &:has(${SearchbarFakeInput}:focus) ${ButtonBar} {
    @container search-bar (max-inline-size: 280px) {
      display: none;
    }
  }
`;

/** Width of the floating navbar in rem */
const NavBarFloating = styled(NavBarBase)`
  box-shadow: ${props => props.theme.boxShadowSoft};
  border-radius: 999px;
  overflow: hidden;
  max-width: calc(100% - 2rem);
  width: ${props => props.theme.containerWidth + 1}rem;
  margin: auto;
  /* Center fixed item */
  left: 50%;
  margin-left: -${props => (props.theme.containerWidth + 1) / 2}rem;
  margin-right: -${props => (props.theme.containerWidth + 1) / 2}rem;
  top: ${props => (props.top ? '2rem' : 'auto')};
  bottom: ${props => (props.top ? 'auto' : '1rem')};

  &:has(${SearchbarFakeInput}:focus) {
    box-shadow: 0px 0px 0px 1px ${props => props.theme.colors.main};
    border-color: ${props => props.theme.colors.main};
  }

  @media (max-width: ${props => props.theme.containerWidth}rem) {
    max-width: calc(100% - 1rem);
    left: auto;
    right: auto;
    margin-left: 0.5rem;
    bottom: 0.5rem;
  }
`;

const NavBarFixed = styled(NavBarBase)`
  top: ${props => (props.top ? '0' : 'auto')};
  bottom: ${props => (props.top ? 'auto' : '0')};
  left: 0;
  right: 0;
  border-width: 0;
  border-bottom: ${props =>
    props.top ? 'solid 1px ' + props.theme.colors.bg2 : 'none'};
  border-top: ${props =>
    !props.top ? 'solid 1px ' + props.theme.colors.bg2 : 'none'};

  &:has(input:focus) {
    box-shadow: 0px 0px 0px 2px ${props => props.theme.colors.main};
  }
`;

const VerticalDivider = styled.div`
  width: 1px;
  background-color: ${props => props.theme.colors.bg2};
  height: 100%;
  margin-left: ${p => p.theme.size(2)};
`;

const SideBarWrapper = styled.div<{ navbarPosition: NavBarPosition }>`
  ${CalculatedPageHeight.define(p =>
    p.navbarPosition === NavBarPosition.Floating
      ? '100dvh'
      : `calc(100dvh - 2.5rem)`,
  )}
  display: flex;
  height: ${CalculatedPageHeight.var()};
  position: fixed;
  top: ${p => (p.navbarPosition === NavBarPosition.Top ? '2.5rem' : 'auto')};
  bottom: ${p =>
    p.navbarPosition === NavBarPosition.Bottom ? '2.5rem' : 'auto'};
  left: 0;
  right: 0;

  opacity: 1;
  transition: opacity 0.3s ease-out;
  @starting-style {
    opacity: 0;
  }
`;

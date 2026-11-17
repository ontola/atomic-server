import * as React from 'react';
import { lazy, Suspense, useState, useMemo, useEffect } from 'react';
import { createRoute } from '@tanstack/react-router';
import { HexColorPicker } from 'react-colorful';
import { ContainerNarrow } from '../components/Containers';
import { Button } from '../components/Button';
import { useSettings } from '../helpers/AppSettings';
import { DarkModeOption } from '../helpers/useDarkMode';
import { Column, Row } from '../components/Row';
import { Main } from '../components/Main';
import { Panel, usePanelList } from '../components/SideBar/usePanelList';
import { pathNames } from './paths';
import { appRoute } from './RootRoutes';
import { IntegrationSettings } from '@components/Settings/IntegrationSettings';
import AISettings from '@components/AI/AISettings';
import { VirtualDriveSettings } from '@components/Settings/VirtualDriveSettings';
import { NotificationSettings } from '@components/Settings/NotificationSettings';
import { isVirtualDriveAvailable } from '../helpers/virtualDrive';
import { useLocale } from '@components/LocaleContext';
import { SUPPORTED_LOCALES } from '@helpers/preloadLocale';
import { BasicSelect } from '@components/forms/BasicSelect';
import { styled } from 'styled-components';
import { isAtomicIdentifier } from '@tomic/react';
import {
  SettingCheckbox,
  SettingField,
  SettingsGroup,
  SettingsSection,
  SettingsSearchProvider,
} from '@components/Settings';
// Web-only sections, out of the Flutter embed's first-use bundle.
const AccountSettings = lazy(() =>
  import('@components/Settings/AccountSettings').then(m => ({
    default: m.AccountSettings,
  })),
);
const DriveSettings = lazy(() =>
  import('@components/Settings/DriveSettings').then(m => ({
    default: m.DriveSettings,
  })),
);
const SyncSettings = lazy(() =>
  import('@components/Settings/SyncSettings').then(m => ({
    default: m.SyncSettings,
  })),
);
import { presetColors } from '../styling';
import { InputStyled, InputWrapper } from '@components/forms/InputStyles';
import { FaMagnifyingGlass, FaXmark } from 'react-icons/fa6';
import {
  showAppearanceOption,
  showSettingsHeader,
  showSettingsSection,
} from '../embed/settings';

/** Touch screens: focusing a field there raises the keyboard. */
const isTouchDevice = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(pointer: coarse)').matches;

export const AppSettingsRoute = createRoute({
  path: pathNames.appSettings,
  validateSearch: (
    search: Record<string, unknown>,
  ): { q?: string; section?: string; drive?: string } => ({
    q: typeof search.q === 'string' ? search.q : undefined,
    section: typeof search.section === 'string' ? search.section : undefined,
    // The drive the Sync section shows (`?section=sync&drive=`).
    drive:
      typeof search.drive === 'string' && isAtomicIdentifier(search.drive)
        ? search.drive
        : undefined,
  }),
  component: () => <AppSettings />,
  getParentRoute: () => appRoute,
});

const getLocaleName = (locale: string) => {
  if (locale === 'id') return /* @wc-ignore */ 'Bahasa Indonesia';

  const names = new Intl.DisplayNames([locale], { type: 'language' });

  return names.of(locale);
};

const AppSettings: React.FunctionComponent = () => {
  const {
    darkModeSetting,
    setDarkMode,
    colorfulMode,
    setColorfulMode,
    viewTransitionsEnabled,
    setViewTransitionsEnabled,
    sidebarKeyboardDndEnabled,
    setSidebarKeyboardDndEnabled,
    hideTemplates,
    setHideTemplates,
    showSidebarIcons,
    setShowSidebarIcons,
    navbarTop,
    setNavbarTop,
  } = useSettings();

  const { locale, setLocale } = useLocale();
  const { q, section, drive } = AppSettingsRoute.useSearch();
  const [searchQuery, setSearchQuery] = useState(q ?? '');
  useEffect(() => setSearchQuery(q ?? ''), [q]);

  const { enabledPanels, enablePanel, disablePanel } = usePanelList();

  const changePanelPref = (panel: Panel) => (state: boolean) => {
    if (state) {
      enablePanel(panel);
    } else {
      disablePanel(panel);
    }
  };

  // In the Flutter embed only part of the page applies (embed/settings.ts).
  const show = showAppearanceOption;

  // One section open at a time; `?section=` picks the first.
  const [openSection, setOpenSection] = useState<string | undefined>(section);
  useEffect(() => setOpenSection(section), [section]);

  const searchContext = useMemo(
    () => ({
      query: searchQuery,
      parentMatched: false,
      section,
      openSection,
      setOpenSection,
    }),
    [searchQuery, section, openSection],
  );

  const header = showSettingsHeader();

  return (
    <Main>
      <ContainerNarrow>
        {header && <h1>Settings</h1>}
        {header && (
          <SettingsSearchWrapper hasPrefix>
            <FaMagnifyingGlass />
            <InputStyled
              type='text'
              placeholder='Search settings...'
              aria-label='Search settings'
              // Ready to type on arrival. Not on touch screens, where focusing
              // pops the keyboard over the settings you came to look at.
              autoFocus={!isTouchDevice()}
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <ClearButton
                type='button'
                onClick={() => setSearchQuery('')}
                title='Clear search'
              >
                <FaXmark />
              </ClearButton>
            )}
          </SettingsSearchWrapper>
        )}
        <SettingsSearchProvider value={searchContext}>
          <SettingsGroup>
            <Suspense>
              {showSettingsSection('account') && <AccountSettings />}
              {showSettingsSection('drive') && <DriveSettings />}
            </Suspense>
            {showSettingsSection('sync') && (
              <SettingsSection
                label='Sync & devices'
                id='sync'
                childSearchKeywords='sync devices device backup vault cloud vault cloud server paired pairing connect another device local database restore hosted server offline'
              >
                <Suspense>
                  <SyncSettings requestedDrive={drive} />
                </Suspense>
              </SettingsSection>
            )}
            {showSettingsSection('appearance') && (
              <SettingsSection
                label='Appearance'
                id='appearance'
                // The only section in the embed: open from the start.
                {...(header ? {} : { open: true, initialState: true })}
                childSearchKeywords='sidebar icons pictures avatars language locale panels messages favorites shared with me templates ontology aichats hide templates'
              >
                <Column gap='1rem'>
                  {show('theme') && (
                    <SettingField label='Theme'>
                      <Row>
                        <Button
                          subtle={!(darkModeSetting === DarkModeOption.auto)}
                          onClick={() => setDarkMode(undefined)}
                          title="Use the browser's / OS dark mode settings"
                        >
                          Auto
                        </Button>
                        <Button
                          subtle={!(darkModeSetting === DarkModeOption.always)}
                          onClick={() => setDarkMode(true)}
                        >
                          Dark
                        </Button>
                        <Button
                          subtle={!(darkModeSetting === DarkModeOption.never)}
                          onClick={() => setDarkMode(false)}
                        >
                          Light
                        </Button>
                      </Row>
                    </SettingField>
                  )}
                  {show('navbarPosition') && (
                    <SettingField label='NavBar position'>
                      <Row>
                        <Button
                          subtle={!navbarTop}
                          onClick={() => setNavbarTop(true)}
                        >
                          Top
                        </Button>
                        <Button
                          subtle={navbarTop}
                          onClick={() => setNavbarTop(false)}
                        >
                          Bottom
                        </Button>
                      </Row>
                    </SettingField>
                  )}
                  {show('mainColor') && (
                    <SettingField label='Main color'>
                      <MainColorPicker />
                    </SettingField>
                  )}
                  {show('colorfulMode') && (
                    <SettingCheckbox
                      checked={colorfulMode}
                      onChange={setColorfulMode}
                    >
                      Colorful mode
                    </SettingCheckbox>
                  )}
                  {show('sidebarIcons') && (
                    <SettingCheckbox
                      checked={showSidebarIcons}
                      onChange={setShowSidebarIcons}
                      hint='Show icons and pictures next to items in the sidebar'
                    >
                      Show icons in the sidebar
                    </SettingCheckbox>
                  )}
                  {show('language') && (
                    <SettingField label='Language' htmlFor='settings-language'>
                      <BasicSelect
                        id='settings-language'
                        value={locale}
                        onChange={e => setLocale(e.target.value)}
                      >
                        {SUPPORTED_LOCALES.map(locale_code => (
                          <option key={locale_code} value={locale_code}>
                            {getLocaleName(locale_code)}
                          </option>
                        ))}
                      </BasicSelect>
                    </SettingField>
                  )}
                  <SettingsSection
                    label={show('panels') ? 'Panels & Templates' : 'Templates'}
                  >
                    <Column gap='0.5rem'>
                      {show('panels') && (
                        <>
                          <SettingCheckbox
                            checked={enabledPanels.has(Panel.Messages)}
                            onChange={changePanelPref(Panel.Messages)}
                          >
                            Show Messages panel
                          </SettingCheckbox>
                          <SettingCheckbox
                            checked={enabledPanels.has(Panel.Favorites)}
                            onChange={changePanelPref(Panel.Favorites)}
                          >
                            Show Favorites panel
                          </SettingCheckbox>
                          <SettingCheckbox
                            checked={enabledPanels.has(Panel.SharedWithMe)}
                            onChange={changePanelPref(Panel.SharedWithMe)}
                          >
                            Show Shared with me panel
                          </SettingCheckbox>
                          <SettingCheckbox
                            checked={enabledPanels.has(Panel.Ontologies)}
                            onChange={changePanelPref(Panel.Ontologies)}
                          >
                            Enable Ontology panel
                          </SettingCheckbox>
                          <SettingCheckbox
                            checked={enabledPanels.has(Panel.AIChats)}
                            onChange={changePanelPref(Panel.AIChats)}
                          >
                            Enable AI Chats panel
                          </SettingCheckbox>
                        </>
                      )}
                      {show('hideTemplates') && (
                        <SettingCheckbox
                          checked={hideTemplates}
                          onChange={setHideTemplates}
                        >
                          Hide templates on new resource page
                        </SettingCheckbox>
                      )}
                    </Column>
                  </SettingsSection>
                </Column>
              </SettingsSection>
            )}
            {showSettingsSection('accessibility') && (
              <SettingsSection
                label='Accessibility'
                id='accessibility'
                childSearchKeywords='enable disable page transition animations view transitions motion'
              >
                <Column gap='0.5rem'>
                  <SettingCheckbox
                    checked={viewTransitionsEnabled}
                    onChange={checked => setViewTransitionsEnabled(checked)}
                  >
                    Enable page transition animations (experimental, known to
                    misbehave outside Chromium on desktop)
                  </SettingCheckbox>
                  <SettingCheckbox
                    checked={sidebarKeyboardDndEnabled}
                    onChange={checked => setSidebarKeyboardDndEnabled(checked)}
                  >
                    Enable keyboard drag & drop in sidebar
                  </SettingCheckbox>
                </Column>
              </SettingsSection>
            )}
            {showSettingsSection('notifications') && (
              <SettingsSection
                label='Notifications'
                id='notifications'
                childSearchKeywords='notify notifications alerts messages comments replies push'
              >
                <NotificationSettings />
              </SettingsSection>
            )}
            {showSettingsSection('virtualDrive') &&
              isVirtualDriveAvailable() && (
                <SettingsSection label='Virtual drive' id='virtual-drive'>
                  <VirtualDriveSettings />
                </SettingsSection>
              )}
            {showSettingsSection('ai') && <AISettings />}
            {showSettingsSection('integration') && <IntegrationSettings />}
          </SettingsGroup>
        </SettingsSearchProvider>
      </ContainerNarrow>
    </Main>
  );
};

const MainColorPicker = () => {
  const { mainColor, setMainColor } = useSettings();
  const [customizing, setCustomizing] = useState(
    () => !presetColors.includes(mainColor),
  );

  return (
    <Column gap='0.5rem'>
      <SwatchRow>
        {presetColors.map(color => (
          <ColorSwatch
            key={color}
            type='button'
            color={color}
            title={color}
            $selected={!customizing && mainColor === color}
            onClick={() => {
              setMainColor(color);
              setCustomizing(false);
            }}
          />
        ))}
        <CustomizeButton
          type='button'
          $selected={customizing}
          onClick={() => setCustomizing(prev => !prev)}
        >
          Customize
        </CustomizeButton>
      </SwatchRow>
      {customizing && (
        <HexColorPicker color={mainColor} onChange={val => setMainColor(val)} />
      )}
    </Column>
  );
};

const SwatchRow = styled(Row)`
  flex-wrap: wrap;
  gap: 0.5rem;
`;

const ColorSwatch = styled.button<{ color: string; $selected: boolean }>`
  background-color: ${p => p.color};
  border: none;
  height: 1.75rem;
  width: 1.75rem;
  border-radius: ${p => p.theme.radius};
  cursor: pointer;
  outline: 2px solid transparent;
  outline-offset: 2px;
  ${p => p.$selected && `outline-color: ${p.theme.colors.textLight};`}
  &:hover,
  &:focus-visible {
    outline-color: ${p => p.theme.colors.textLight};
  }
`;

const CustomizeButton = styled.button<{ $selected: boolean }>`
  height: 1.75rem;
  padding-inline: 0.6rem;
  border-radius: ${p => p.theme.radius};
  border: 1px solid ${p => p.theme.colors.bg2};
  background-color: ${p =>
    p.$selected ? p.theme.colors.bg1 : p.theme.colors.bg};
  color: ${p => p.theme.colors.text};
  font-size: 0.8rem;
  cursor: pointer;
  &:hover,
  &:focus-visible {
    border-color: ${p => p.theme.colors.textLight};
  }
`;

const SettingsSearchWrapper = styled(InputWrapper)`
  margin-block: ${p => p.theme.margin}rem;
`;

const ClearButton = styled.button`
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  cursor: pointer;
  padding: 0.4rem;
  color: ${p => p.theme.colors.textLight};
  &:hover {
    color: ${p => p.theme.colors.text};
  }
`;

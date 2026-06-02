import * as React from 'react';
import { useState, useMemo } from 'react';
import { createRoute } from '@tanstack/react-router';
import { HexColorPicker } from 'react-colorful';
import { ContainerNarrow } from '../components/Containers';
import { Button } from '../components/Button';
import { useSettings } from '../helpers/AppSettings';
import { DarkModeOption } from '../helpers/useDarkMode';
import { Column, Row } from '../components/Row';
import { Checkbox, CheckboxLabel } from '../components/forms/Checkbox';
import { Main } from '../components/Main';
import { Panel, usePanelList } from '../components/SideBar/usePanelList';
import { pathNames } from './paths';
import { appRoute } from './RootRoutes';
import AISettings from '@components/AI/AISettings';
import { SUPPORTED_LOCALES, useLocale } from '@components/LocaleContext';
import { BasicSelect } from '@components/forms/BasicSelect';
import { styled } from 'styled-components';
import {
  SettingsGroup,
  SettingsSection,
  SettingsSearchProvider,
} from '@components/Settings';
import { InputStyled, InputWrapper } from '@components/forms/InputStyles';
import { FaMagnifyingGlass, FaXmark } from 'react-icons/fa6';

export const AppSettingsRoute = createRoute({
  path: pathNames.appSettings,
  component: () => <AppSettings />,
  getParentRoute: () => appRoute,
});

const getLocaleName = (locale: string) => {
  const names = new Intl.DisplayNames([locale], { type: 'language' });

  return names.of(locale);
};

const AppSettings: React.FunctionComponent = () => {
  const {
    darkModeSetting,
    setDarkMode,
    viewTransitionsDisabled,
    setViewTransitionsDisabled,
    sidebarKeyboardDndEnabled,
    setSidebarKeyboardDndEnabled,
    hideTemplates,
    setHideTemplates,
    navbarTop,
    setNavbarTop,
  } = useSettings();

  const { locale, setLocale } = useLocale();
  const [searchQuery, setSearchQuery] = useState('');

  const { enabledPanels, enablePanel, disablePanel } = usePanelList();

  const changePanelPref = (panel: Panel) => (state: boolean) => {
    if (state) {
      enablePanel(panel);
    } else {
      disablePanel(panel);
    }
  };

  const searchContext = useMemo(
    () => ({ query: searchQuery, parentMatched: false }),
    [searchQuery],
  );

  return (
    <Main>
      <ContainerNarrow>
        <h1>Settings</h1>
        <SettingsSearchWrapper hasPrefix>
          <FaMagnifyingGlass />
          <InputStyled
            type="text"
            placeholder="Search settings..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <ClearButton
              type="button"
              onClick={() => setSearchQuery('')}
              title="Clear search"
            >
              <FaXmark />
            </ClearButton>
          )}
        </SettingsSearchWrapper>
        <SettingsSearchProvider value={searchContext}>
          <SettingsGroup>
            <SettingsSection label="Language">
              <BasicSelect
                value={locale}
                onChange={e => setLocale(e.target.value)}
              >
                {SUPPORTED_LOCALES.map(locale_code => (
                  <option key={locale_code} value={locale_code}>
                    {getLocaleName(locale_code)}
                  </option>
                ))}
              </BasicSelect>
            </SettingsSection>
            <SettingsSection label="Appearance">
              <Column gap="1rem">
                <Column gap="0.5rem">
                  <SubLabel>Theme</SubLabel>
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
                </Column>
                <Column gap="0.5rem">
                  <SubLabel>NavBar position</SubLabel>
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
                </Column>
                <Column gap="0.5rem">
                  <SubLabel>Main color</SubLabel>
                  <MainColorPicker />
                </Column>
              </Column>
            </SettingsSection>
            <SettingsSection label="Panels & Templates">
              <Column gap="0.5rem">
                <CheckboxLabel>
                  <Checkbox
                    checked={enabledPanels.has(Panel.Ontologies)}
                    onChange={changePanelPref(Panel.Ontologies)}
                  />{' '}
                  Enable Ontology panel
                </CheckboxLabel>
                <CheckboxLabel>
                  <Checkbox
                    checked={enabledPanels.has(Panel.AIChats)}
                    onChange={changePanelPref(Panel.AIChats)}
                  />{' '}
                  Enable AIChats panel
                </CheckboxLabel>
                <CheckboxLabel>
                  <Checkbox
                    checked={hideTemplates}
                    onChange={setHideTemplates}
                  />{' '}
                  Hide templates on new resource page
                </CheckboxLabel>
              </Column>
            </SettingsSection>
            <SettingsSection
              label="Accessibility"
              childSearchKeywords="disable page transition animations view transitions motion"
            >
              <Column gap="0.5rem">
                <CheckboxLabel>
                  <Checkbox
                    checked={viewTransitionsDisabled}
                    onChange={checked => setViewTransitionsDisabled(checked)}
                  />{' '}
                  Disable page transition animations
                </CheckboxLabel>
                <CheckboxLabel>
                  <Checkbox
                    checked={sidebarKeyboardDndEnabled}
                    onChange={checked => setSidebarKeyboardDndEnabled(checked)}
                  />{' '}
                  Enable keyboard drag & drop in sidebar
                </CheckboxLabel>
              </Column>
            </SettingsSection>
            <AISettings />
          </SettingsGroup>
        </SettingsSearchProvider>
      </ContainerNarrow>
    </Main>
  );
};

const MainColorPicker = () => {
  const { mainColor, setMainColor } = useSettings();

  return (
    <HexColorPicker color={mainColor} onChange={val => setMainColor(val)} />
  );
};

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

const SubLabel = styled.span`
  font-size: 0.85rem;
  color: ${p => p.theme.colors.textLight};
`;

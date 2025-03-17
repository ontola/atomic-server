import * as React from 'react';
import { createRoute } from '@tanstack/react-router';
import { HexColorPicker } from 'react-colorful';
import { styled } from 'styled-components';
import { ContainerNarrow } from '../components/Containers';
import { Button } from '../components/Button';
import { useSettings } from '../helpers/AppSettings';
import { NavStyleButton } from '../components/NavStyleButton';
import { DarkModeOption } from '../helpers/useDarkMode';
import { Column, Row } from '../components/Row';
import { Checkbox, CheckboxLabel } from '../components/forms/Checkbox';
import { Main } from '../components/Main';
import { Panel, usePanelList } from '../components/SideBar/usePanelList';
import { pathNames } from './paths';
import { appRoute } from './RootRoutes';
import { InputStyled, InputWrapper } from '../components/forms/InputStyles';
import { MCPServersManager } from '../components/MCPServersManager';

export const AppSettingsRoute = createRoute({
  path: pathNames.appSettings,
  component: () => <AppSettings />,
  getParentRoute: () => appRoute,
});

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
    openRouterApiKey,
    setOpenRouterApiKey,
    mcpServers,
    setMcpServers,
  } = useSettings();

  const { enabledPanels, enablePanel, disablePanel } = usePanelList();

  const changePanelPref = (panel: Panel) => (state: boolean) => {
    if (state) {
      enablePanel(panel);
    } else {
      disablePanel(panel);
    }
  };

  return (
    <Main>
      <ContainerNarrow>
        <h1>Settings</h1>
        <Column>
          <Heading>Theme</Heading>
          <Row>
            <Button
              subtle={!(darkModeSetting === DarkModeOption.auto)}
              onClick={() => setDarkMode(undefined)}
              title="Use the browser's / OS dark mode settings"
            >
              🌓 Auto
            </Button>
            <Button
              subtle={!(darkModeSetting === DarkModeOption.always)}
              onClick={() => setDarkMode(true)}
            >
              🌑 Dark
            </Button>
            <Button
              subtle={!(darkModeSetting === DarkModeOption.never)}
              onClick={() => setDarkMode(false)}
            >
              🌕 Light
            </Button>
          </Row>
          <Heading>Navigation bar position</Heading>
          <Row>
            <NavStyleButton floating={true} top={false} title='Floating' />
            <NavStyleButton floating={false} top={false} title='Bottom' />
            <NavStyleButton floating={false} top={true} title='Top' />
          </Row>
          <Heading>Main color</Heading>
          <MainColorPicker />
          <Heading>Templates</Heading>
          <CheckboxLabel>
            <Checkbox checked={hideTemplates} onChange={setHideTemplates} />{' '}
            Hide templates on new resource page.
          </CheckboxLabel>
          <Heading>Panels</Heading>
          <CheckboxLabel>
            <Checkbox
              checked={enabledPanels.has(Panel.Ontologies)}
              onChange={changePanelPref(Panel.Ontologies)}
            />{' '}
            Enable Ontology panel
          </CheckboxLabel>
          <Heading>Accessibility</Heading>
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
          <Heading>AI</Heading>
          {/* eslint-disable-next-line jsx-a11y/label-has-associated-control */}
          <label>
            <Column gap='0.5rem'>
              OpenRouter API Key
              <InputWrapper>
                <InputStyled
                  type='password'
                  value={openRouterApiKey || ''}
                  onChange={e =>
                    setOpenRouterApiKey(e.target.value || undefined)
                  }
                  placeholder='Enter your OpenRouter API key'
                />
              </InputWrapper>
            </Column>
          </label>

          <Heading>MCP Servers</Heading>
          <MCPServersManager servers={mcpServers} setServers={setMcpServers} />
        </Column>
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

const Heading = styled.h2`
  font-size: 1em;
  margin: 0;
  margin-top: 1rem;
`;

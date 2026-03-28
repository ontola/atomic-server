import { StyleSheetManager, type ShouldForwardProp } from 'styled-components';
import { DialogGlobalContextProvider } from './components/Dialog/DialogGlobalContextProvider';
import { DropdownContainer } from './components/Dropdown/DropdownContainer';
import { FormValidationContextProvider } from './components/forms/formValidation/FormValidationContextProvider';
import { NewResourceUIProvider } from './components/forms/NewForm/useNewResourceUI';
import HotKeysWrapper from './components/HotKeyWrapper';
import { MetaSetter } from './components/MetaSetter';
import { NavWrapper } from './components/Navigation';
import { SearchOverlayContextProvider } from './components/Searchbar/SearchOverlayContext';
import { NetworkIndicator } from './components/NetworkIndicator';
import { PopoverContainer } from './components/Popover';
import { SkipNav } from './components/SkipNav';
import { ControlLockProvider } from './hooks/useControlLock';
import { ThemeWrapper, GlobalStyle } from './styling';
import isPropValid from '@emotion/is-prop-valid';
import { initBugsnag } from './helpers/loggingHandlers';
import { ErrorBoundary } from './views/ErrorPage';
import CrashPage from './views/CrashPage';
import { AppSettingsContextProvider } from './helpers/AppSettings';
import { RootWelcomeLayoutProvider } from './context/RootWelcomeLayoutContext';
import { NavStateProvider } from './components/NavState';
import { Toaster } from './components/Toaster';
import { AISettingsContextProvider } from '@components/AI/AISettingsContext';
import { LocaleProvider } from '@components/LocaleContext';
import { CustomContextItemsProvider } from './components/ResourceContextMenu';
import { LazyMCPProvider } from '@components/AI/MCP/LazyMCPProvider';
import { CustomViewProvider } from '@components/CustomViewProvider';

// Setup bugsnag for error handling, but only if there's an API key
const ErrBoundary = window.bugsnagApiKey
  ? initBugsnag(window.bugsnagApiKey)
  : ErrorBoundary;

const VALID_PROPS = ['popover', 'closedby'];

// This implements the default behavior from styled-components v5
const shouldForwardProp: ShouldForwardProp<'web'> = (propName, target) => {
  if (typeof target === 'string') {
    // @emotion/is-prop-valid does not support popover, so we need to forward it manually.
    if (VALID_PROPS.includes(propName)) {
      return true;
    }

    // For HTML elements, forward the prop if it is a valid HTML attribute
    return isPropValid(propName);
  }

  // For other elements, forward all props
  return true;
};

export const Providers: React.FC<React.PropsWithChildren> = ({ children }) => {
  return (
    <NavStateProvider>
      <LocaleProvider>
        <AppSettingsContextProvider>
          <RootWelcomeLayoutProvider>
            <AISettingsContextProvider>
              <LazyMCPProvider>
                <ControlLockProvider>
                  <HotKeysWrapper>
                    <StyleSheetManager shouldForwardProp={shouldForwardProp}>
                      <ThemeWrapper>
                        <GlobalStyle />
                        <ErrBoundary FallbackComponent={CrashPage}>
                          {/* Default form validation provider. Does not do anything on its own but will make sure useValidation works without context*/}
                          <FormValidationContextProvider
                            onValidationChange={() => undefined}
                          >
                            <Toaster />
                            <CustomViewProvider>
                              <MetaSetter />
                              <DropdownContainer>
                                <DialogGlobalContextProvider>
                                  <PopoverContainer>
                                    <DropdownContainer>
                                      <CustomContextItemsProvider>
                                        <NewResourceUIProvider>
                                          <SkipNav />
                                          <SearchOverlayContextProvider>
                                            <NavWrapper>{children}</NavWrapper>
                                          </SearchOverlayContextProvider>
                                        </NewResourceUIProvider>
                                      </CustomContextItemsProvider>
                                    </DropdownContainer>
                                  </PopoverContainer>
                                  <NetworkIndicator />
                                </DialogGlobalContextProvider>
                              </DropdownContainer>
                            </CustomViewProvider>
                          </FormValidationContextProvider>
                        </ErrBoundary>
                      </ThemeWrapper>
                    </StyleSheetManager>
                  </HotKeysWrapper>
                </ControlLockProvider>
              </LazyMCPProvider>
            </AISettingsContextProvider>
          </RootWelcomeLayoutProvider>
        </AppSettingsContextProvider>
      </LocaleProvider>
    </NavStateProvider>
  );
};

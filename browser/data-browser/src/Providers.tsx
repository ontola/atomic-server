import { StyleSheetManager, type ShouldForwardProp } from 'styled-components';
import { DialogGlobalContextProvider } from './components/Dialog/DialogGlobalContextProvider';
import { DropdownContainer } from './components/Dropdown/DropdownContainer';
import { FormValidationContextProvider } from './components/forms/formValidation/FormValidationContextProvider';
import { NewResourceUIProvider } from './components/forms/NewForm/useNewResourceUI';
import HotKeysWrapper from './components/HotKeyWrapper';
import { MetaSetter } from './components/MetaSetter';
import { NavWrapper } from './components/Navigation';
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
import { NavStateProvider } from './components/NavState';
import { Toaster } from './components/Toaster';

// Setup bugsnag for error handling, but only if there's an API key
const ErrBoundary = window.bugsnagApiKey
  ? initBugsnag(window.bugsnagApiKey)
  : ErrorBoundary;

// This implements the default behavior from styled-components v5
const shouldForwardProp: ShouldForwardProp<'web'> = (propName, target) => {
  if (typeof target === 'string') {
    // For HTML elements, forward the prop if it is a valid HTML attribute
    return isPropValid(propName);
  }

  // For other elements, forward all props
  return true;
};

export const Providers: React.FC<React.PropsWithChildren> = ({ children }) => {
  return (
    <NavStateProvider>
      <AppSettingsContextProvider>
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
                    <MetaSetter />
                    <DropdownContainer>
                      <DialogGlobalContextProvider>
                        <PopoverContainer>
                          <DropdownContainer>
                            <NewResourceUIProvider>
                              <SkipNav />
                              <NavWrapper>{children}</NavWrapper>
                            </NewResourceUIProvider>
                          </DropdownContainer>
                        </PopoverContainer>
                        <NetworkIndicator />
                      </DialogGlobalContextProvider>
                    </DropdownContainer>
                  </FormValidationContextProvider>
                </ErrBoundary>
              </ThemeWrapper>
            </StyleSheetManager>
          </HotKeysWrapper>
        </ControlLockProvider>
      </AppSettingsContextProvider>
    </NavStateProvider>
  );
};

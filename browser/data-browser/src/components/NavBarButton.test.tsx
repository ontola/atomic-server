// @vitest-environment jsdom
// @wc-ignore-file
import React from 'react';
import { afterEach, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { ThemeProvider, type DefaultTheme } from 'styled-components';
import { ButtonArea, LabelButton } from './NavBarButton';

afterEach(cleanup);

it('keeps presence triggers visible when the navbar hides action labels', () => {
  const { getByTestId } = render(
    <ThemeProvider
      theme={
        {
          animation: { duration: '0s' },
          colors: { textLight: '#777' },
          size: () => '4px',
        } as unknown as DefaultTheme
      }
    >
      <ButtonArea $iconOnly>
        <div aria-label='Also viewing this resource'>
          <span role='button' data-testid='avatar'>
            Colleague
          </span>
        </div>
        <LabelButton>
          <svg />
          <span data-testid='label'>Share</span>
        </LabelButton>
      </ButtonArea>
    </ThemeProvider>,
  );
  expect(getComputedStyle(getByTestId('label')).display).toBe('none');
  expect(getComputedStyle(getByTestId('avatar')).display).not.toBe('none');
});

// The shared visual chrome of the full-screen onboarding surfaces: the
// welcome/sign-in flow, the invite page, the demo intro, and the post-sign-in
// "connect a device" screen. Lives apart from GettingStartedFlow so a step it
// renders can use the chrome without importing its parent.

import type { JSX, ReactNode } from 'react';
import { styled, css } from 'styled-components';
import { Button } from '../../components/Button';
import { useKeyboardInset } from '../../hooks/useKeyboardInset';
import { welcomeBackgroundCss } from './welcomeBackground';

/**
 * The full-height frame every onboarding surface sits in. Owns the keyboard
 * measurement, because these are the screens with the text fields.
 */
export function Shell({ children }: { children: ReactNode }): JSX.Element {
  useKeyboardInset();

  return <ShellRoot>{children}</ShellRoot>;
}

const ShellRoot = styled.div`
  /* A concrete viewport height (not 100%): nothing in the html/body/#root
     chain sets a height, so 100% would collapse to content height and,
     because body is overflow:hidden, tall content (the welcome pitch on a
     phone) gets clipped with no way to scroll to the buttons. 100dvh tracks
     the visible viewport (excludes mobile browser UI), giving overflow-y a
     real height to scroll within. */
  height: 100dvh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  /* Center via auto margins on the child, NOT justify-content: center — a
     centered flex item that overflows its scroll container can't be scrolled
     to (Chromium clips it and pins the scroll origin), which left the welcome
     buttons unreachable on a phone. Auto margins collapse to 0 when content
     overflows, so it top-aligns and scrolls; they center it when it fits. */
  & > * {
    margin-block: auto;
  }
  /* The Android (Tauri) webview draws edge-to-edge under the system status
     and navigation bars — 100dvh includes those strips, so centered content
     ends up half-hidden behind the nav bar (the welcome buttons were
     unreachable on a phone). The safe-area insets (needs viewport-fit=cover,
     set in index.html) pad the content back into the visible region.

     The --keyboard-inset variable (see useKeyboardInset) does the same for the
     on-screen keyboard, which edge-to-edge likewise lets overlap us rather
     than resize us. Reserving it as padding shrinks the box the auto margins
     centre within, so the card re-centres in what's still visible instead of
     sitting behind the keys — and overflow-y takes over when it no longer
     fits. Transitioned because the keyboard slides in. */
  padding: calc(${p => p.theme.size(7)} + env(safe-area-inset-top, 0px))
    ${p => p.theme.size(5)}
    calc(
      ${p => p.theme.size(7)} + env(safe-area-inset-bottom, 0px) +
        var(--keyboard-inset, 0px)
    );
  box-sizing: border-box;
  transition: padding-bottom 150ms ease-out;

  @media (prefers-reduced-motion: reduce) {
    transition: none;
  }
  ${welcomeBackgroundCss}
`;

const cardSurface = css`
  box-sizing: border-box;
  width: 100%;
  margin-inline: auto;
  padding: ${p => p.theme.size(7)};
  border-radius: ${p => p.theme.radius};
  border: 1px solid ${p => p.theme.colors.bg2};
  background: ${p => p.theme.colors.bg1};
  box-shadow: ${p => p.theme.boxShadowSoft};
  backdrop-filter: blur(10px);
`;

export const Card = styled.div`
  ${cardSurface}
  max-width: 26.5rem;
`;

export const CardTitle = styled.h2`
  margin: 0 0 ${p => p.theme.size(6)} 0;
  font-size: 1.4rem;
  font-weight: 700;
  line-height: 1.25;
  text-align: center;
`;

export const CardSubtitle = styled.p`
  margin: 0 0 ${p => p.theme.size(2)} 0;
  font-size: 0.95rem;
  color: ${p => p.theme.colors.textLight};
  text-align: center;
`;

export const CardError = styled.p`
  margin: ${p => p.theme.size(4)} 0 0 0;
  font-size: 0.9rem;
  color: ${p => p.theme.colors.alert};
`;

export const CtaButton = styled(Button)`
  width: fit-content;
  min-width: 12.5rem;
  align-self: center;
  justify-content: center;
`;

export const OnboardingWrap = styled.div`
  width: 100%;
  max-width: 40rem;
  margin-inline: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
`;

export const OnboardingCard = styled.div`
  ${cardSurface}
  max-width: 36rem;
`;

export const FooterBar = styled.div`
  width: 100%;
  max-width: 36rem;
  margin-inline: auto;
  margin-top: ${p => p.theme.size(5)};
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: ${p => p.theme.size(4)};
`;

export const BackLabel = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 0.4em;
`;

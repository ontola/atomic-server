import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useSettings } from '../../helpers/AppSettings';
import { styled } from 'styled-components';
import { transition } from '../../helpers/transition';

import type { JSX } from 'react';

export function OverlapSpacer(): JSX.Element {
  const narrow = useMediaQuery('(max-width: 950px)');
  const { navbarTop } = useSettings();
  // The floating-navbar setting was folded into `navbarTop`. When the
  // navbar sits at the bottom on narrow screens, the sidebar content
  // gets covered, so we lift it with a spacer.
  const elevate = narrow && !navbarTop;

  return <Elevator elevate={elevate} />;
}

const Elevator = styled.div<{ elevate: boolean }>`
  height: ${p => (p.elevate ? '3.8rem' : '0rem')};
  ${transition('height')}
`;

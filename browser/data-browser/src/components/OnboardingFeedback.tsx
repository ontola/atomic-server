import { styled } from 'styled-components';
import { FeedbackButton } from './SideBar/FeedbackButton';

/** Shared corner placement for onboarding pages and their dialogs. */
export function OnboardingFeedback() {
  return (
    <Corner>
      <FeedbackButton />
    </Corner>
  );
}

const Corner = styled.div`
  position: fixed;
  right: max(1rem, env(safe-area-inset-right));
  bottom: max(1rem, env(safe-area-inset-bottom));
  z-index: ${p => p.theme.zIndex.sidebar};
`;

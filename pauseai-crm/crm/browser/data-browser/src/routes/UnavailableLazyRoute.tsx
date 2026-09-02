import { createLazyRoute } from '@tanstack/react-router';

export const unavailableLazyRoute = createLazyRoute('/$')({
  component: () => <div>Unavailable</div>,
});

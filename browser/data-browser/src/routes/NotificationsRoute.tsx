import { createRoute } from '@tanstack/react-router';
import { ContainerNarrow } from '../components/Containers';
import { Main } from '../components/Main';
import { NotificationList } from '../components/Notifications/NotificationList';
import { pathNames } from './paths';
import { appRoute } from './RootRoutes';

export const NotificationsRoute = createRoute({
  path: pathNames.notifications,
  component: () => (
    <Main>
      <ContainerNarrow>
        <NotificationList />
      </ContainerNarrow>
    </Main>
  ),
  getParentRoute: () => appRoute,
});

import { ContainerNarrow } from '../components/Containers';
import { NotificationList } from '../components/Notifications/NotificationList';

/** The Inbox resource itself shows the same list as the Notifications page. */
export function InboxPage(): React.JSX.Element {
  return (
    <ContainerNarrow>
      <NotificationList />
    </ContainerNarrow>
  );
}

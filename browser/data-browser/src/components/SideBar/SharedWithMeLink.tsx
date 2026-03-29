import { useArray, useResource, core } from '@tomic/react';
import {
  SideBarMenuItemLink,
  SideBarMenuRow,
  SideBarMenuRowIcon,
  SideBarMenuRowLabel,
} from './SideBarMenuItem';
import { getIconForClass } from '../../helpers/iconMap';
import type { JSX } from 'react';

type SharedWithMeLinkProps = {
  subject: string;
  onClick: () => void;
  'data-testid'?: string;
};

/** One shared resource: same row layout as {@link SideBarMenuItem} (icon + label). */
export function SharedWithMeLink({
  subject,
  onClick,
  'data-testid': dataTestId,
}: SharedWithMeLinkProps): JSX.Element {
  const resource = useResource(subject);
  const [isA] = useArray(resource, core.properties.isA);
  const Icon = getIconForClass(isA[0] ?? '');
  const label = resource.title || subject;
  const description = resource.get(core.properties.description) as
    | string
    | undefined;

  return (
    <SideBarMenuItemLink subject={subject} clean data-testid={dataTestId}>
      <SideBarMenuRow onClick={onClick} title={description}>
        <SideBarMenuRowIcon>
          <Icon />
        </SideBarMenuRowIcon>
        <SideBarMenuRowLabel>{label}</SideBarMenuRowLabel>
      </SideBarMenuRow>
    </SideBarMenuItemLink>
  );
}

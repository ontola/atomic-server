import { commits, unknownSubject, useResource } from '@tomic/react';

import { styled } from 'styled-components';
import { ErrorLook } from '../ErrorLook';

import type { JSX } from 'react';
import { ResourceRow } from '@views/ResourceRow';

interface UsageRowProps {
  subject: string;
}

export function UsageRow({ subject }: UsageRowProps): JSX.Element {
  const resource = useResource(subject);

  if (subject === unknownSubject) {
    return (
      <ListItem>
        <ErrorLook>Insufficient rights to view resource</ErrorLook>
      </ListItem>
    );
  }

  if (resource.hasClasses(commits.classes.commit)) {
    return <></>;
  }

  return <ResourceRow clickable subject={subject} />;
}

const ListItem = styled.li`
  display: flex;
  align-items: center;
  list-style: none;
  padding: 0.5rem 1rem;
  border-radius: ${({ theme }) => theme.radius};
  margin: 0;
  height: 3rem;
  &:nth-child(odd) {
    background-color: ${({ theme }) => theme.colors.bg1};
  }
`;

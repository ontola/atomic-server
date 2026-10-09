import { useState, type JSX } from 'react';
import { styled } from 'styled-components';
import toast from 'react-hot-toast';
import {
  core,
  urls,
  useArray,
  useCanWrite,
  useResource,
  useStore,
  useTitle,
} from '@tomic/react';
import type { ResourcePageProps } from './ResourcePage';
import { ContainerNarrow } from '../components/Containers';
import { Column } from '../components/Row';
import { EditableTitle } from '../components/EditableTitle';
import { SearchBox } from '../components/forms/SearchBox';
import { GroupMemberRow } from '../components/Group/GroupMemberRow';
import { GROUP_MEMBERS, isGroup } from '../components/Group/groups';
import { useEffectiveMembers } from '../components/Group/useEffectiveMembers';
import { plural } from '../helpers/plural';

export function GroupPage({ resource }: ResourcePageProps): JSX.Element {
  const store = useStore();
  const canWrite = useCanWrite(resource);
  const [members, setMembers] = useArray(resource, GROUP_MEMBERS, {
    commit: true,
  });
  const { agents, loading } = useEffectiveMembers(resource);
  const [error, setError] = useState<string>();

  const addMember = async (subject: string | undefined) => {
    if (!subject) return;

    setError(undefined);

    if (members.includes(subject)) {
      setError('Already a member.');

      return;
    }

    if (subject === resource.subject) {
      setError('A group cannot contain itself.');

      return;
    }

    try {
      const member = await store.getResource(subject);

      if (!member.hasClasses(urls.classes.agent) && !isGroup(member)) {
        setError('Only people and groups can be members.');

        return;
      }

      await setMembers([...members, subject]);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const removeMember = async (subject: string, name: string) => {
    try {
      await setMembers(members.filter(m => m !== subject));
      toast.success(`Removed ${name}`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <ContainerNarrow>
      <Column gap='1.5rem'>
        <EditableTitle resource={resource} />
        <section aria-labelledby='group-members-heading'>
          <Heading id='group-members-heading'>
            {plural(members.length, ['# member', '# members'])}
          </Heading>
          <List data-testid='group-members'>
            {members.length === 0 && (
              <Empty>This group has no members yet.</Empty>
            )}
            {members.map(subject => (
              <RemovableMember
                key={subject}
                subject={subject}
                onRemove={canWrite ? removeMember : undefined}
              />
            ))}
          </List>
        </section>
        {canWrite && (
          <Column gap='0.5rem'>
            <Heading as='h3'>Add members</Heading>
            <SearchBox
              value={undefined}
              isA={core.classes.agent}
              placeholder='Search for a person or paste their agent URL...'
              onChange={addMember}
            />
            <SearchBox
              value={undefined}
              isA={urls.classes.group}
              placeholder='Search for a group...'
              onChange={addMember}
            />
            {error && <ErrorText role='alert'>{error}</ErrorText>}
          </Column>
        )}
        {members.length > 0 && (
          <Note>
            {loading
              ? 'Counting everyone covered...'
              : plural(agents.length, [
                  '# person is covered when this group is given access, including through other groups.',
                  '# people are covered when this group is given access, including through other groups.',
                ])}
          </Note>
        )}
      </Column>
    </ContainerNarrow>
  );
}

function RemovableMember({
  subject,
  onRemove,
}: {
  subject: string;
  onRemove?: (subject: string, name: string) => void;
}): JSX.Element {
  const resource = useResource(subject);
  const [name] = useTitle(resource);

  return (
    <GroupMemberRow
      subject={subject}
      onRemove={onRemove && (() => onRemove(subject, name))}
    />
  );
}

const Heading = styled.h2`
  font-size: 1rem;
  font-weight: bold;
  margin: 0 0 0.4rem;
`;

const List = styled.div`
  display: flex;
  flex-direction: column;
`;

const Empty = styled.p`
  margin: 0;
  color: ${p => p.theme.colors.textLight};
`;

const Note = styled.p`
  margin: 0;
  color: ${p => p.theme.colors.textLight};
  font-size: 0.95rem;
`;

const ErrorText = styled.span`
  color: ${p => p.theme.colors.alert};
`;

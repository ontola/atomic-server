import { useState, type JSX } from 'react';
import { styled } from 'styled-components';
import toast from 'react-hot-toast';
import { urls, useStore } from '@tomic/react';
import { SearchBox } from '../forms/SearchBox';
import { RoleSwitch, type ShareRole } from './RoleSelect';
import { isGroup } from '../Group/groups';
import type { DirectRight } from './useShareRights';

interface GroupPickerProps {
  rights: DirectRight[];
  onAdd: (group: string, role: ShareRole) => Promise<void>;
}

/**
 * Give an existing Group access, next to the individual people. A Group goes in
 * the same read / write lists as an Agent, so adding one is a role change like
 * any other and the list above takes care of showing and removing it.
 */
export function GroupPicker({ rights, onAdd }: GroupPickerProps): JSX.Element {
  const store = useStore();
  const [role, setRole] = useState<ShareRole>('read');
  const [busy, setBusy] = useState(false);

  const handleSelect = async (subject: string | undefined) => {
    if (!subject) return;

    if (rights.some(r => r.agentSubject === subject)) {
      toast.error('That group already has access.');

      return;
    }

    setBusy(true);

    try {
      const group = await store.getResource(subject);

      if (isGroup(group)) {
        await onAdd(subject, role);
        toast.success(
          `${group.title} ${role === 'write' ? 'can write' : 'can read'}`,
        );
      } else {
        toast.error('That is not a group.');
      }
    } catch (e) {
      toast.error((e as Error).message);
    }

    setBusy(false);
  };

  return (
    <section aria-labelledby='share-group-heading'>
      <Heading id='share-group-heading'>Add a group</Heading>
      <Controls>
        <Search>
          <SearchBox
            value={undefined}
            isA={urls.classes.group}
            placeholder='Search for a group...'
            disabled={busy}
            onChange={handleSelect}
          />
        </Search>
        <RoleSwitch
          value={role}
          onChange={setRole}
          disabled={busy}
          aria-label='Role for the group'
        />
      </Controls>
    </section>
  );
}

const Heading = styled.h2`
  font-size: 1rem;
  font-weight: bold;
  margin: 0 0 0.4rem;
`;

const Controls = styled.div`
  display: flex;
  align-items: center;
  gap: 0.75rem;

  @media (max-width: 500px) {
    flex-direction: column;
    align-items: stretch;
  }
`;

const Search = styled.div`
  flex: 1;
  min-width: 0;
`;

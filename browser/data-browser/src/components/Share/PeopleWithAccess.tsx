import { useState, type JSX } from 'react';
import { styled } from 'styled-components';
import toast from 'react-hot-toast';
import {
  urls,
  useArray,
  useResource,
  useTitle,
  type Resource,
} from '@tomic/react';
import { AgentAvatar } from '../Presence/AgentAvatar';
import { RoleSelect, roleLabel, type ShareRole } from './RoleSelect';
import type { DirectRight } from './useShareRights';
import type { MergedRight } from '../../routes/Share/useRights';
import { useClassLabel } from './useClassLabel';
import { AtomicLink } from '../AtomicLink';
import { GroupAvatar } from '../Group/GroupAvatar';
import { GROUP_MEMBERS, isGroup } from '../Group/groups';
import { useEffectiveMembers } from '../Group/useEffectiveMembers';
import { plural } from '../../helpers/plural';

interface PeopleWithAccessProps {
  rights: DirectRight[];
  inheritedRights: MergedRight[];
  currentAgent?: string;
  /** Effective role of the current agent on this resource */
  currentRole?: ShareRole;
  /** Shown under the current agent's name, e.g. their account email */
  currentAgentDetail?: string;
  onSetRole?: (agent: string, role: ShareRole | 'remove') => Promise<void>;
}

/**
 * Everyone who can open the resource: people added here (with a role menu
 * when the viewer may change it), the viewer themself, and a summary of the
 * people who get in through a parent.
 */
export function PeopleWithAccess({
  rights,
  inheritedRights,
  currentAgent,
  currentRole,
  currentAgentDetail,
  onSetRole,
}: PeopleWithAccessProps): JSX.Element {
  const people = rights.filter(
    r =>
      r.agentSubject !== urls.instances.publicAgent &&
      r.agentSubject !== currentAgent,
  );
  const shown = new Set([...people.map(p => p.agentSubject), currentAgent]);
  const inheritedByParent = groupInherited(inheritedRights, shown);

  return (
    <section aria-labelledby='share-people-heading'>
      <Heading id='share-people-heading'>People with access</Heading>
      <List>
        {people.map(right => (
          <PersonRow
            key={right.agentSubject}
            agentSubject={right.agentSubject}
            control={
              onSetRole ? (
                <PersonRoleSelect right={right} onSetRole={onSetRole} />
              ) : (
                <StaticRole>{roleLabel(right.role)}</StaticRole>
              )
            }
          />
        ))}
        {currentAgent && currentRole && (
          <PersonRow
            agentSubject={currentAgent}
            isYou
            detail={currentAgentDetail}
            control={<StaticRole>{roleLabel(currentRole)}</StaticRole>}
          />
        )}
        {Array.from(inheritedByParent.entries()).map(([setIn, agents]) => (
          <InheritedGroup key={setIn} setIn={setIn} agents={agents} />
        ))}
      </List>
    </section>
  );
}

function PersonRoleSelect({
  right,
  onSetRole,
}: {
  right: DirectRight;
  onSetRole: (agent: string, role: ShareRole | 'remove') => Promise<void>;
}): JSX.Element {
  const agent = useResource(right.agentSubject);
  const [name] = useTitle(agent);
  const [busy, setBusy] = useState(false);

  const handleChange = async (role: ShareRole | 'remove') => {
    setBusy(true);

    try {
      await onSetRole(right.agentSubject, role);
      toast.success(
        role === 'remove' ? `Removed ${name}` : `${name} ${roleLabel(role)}`,
      );
    } catch (e) {
      toast.error((e as Error).message);
    }

    setBusy(false);
  };

  return (
    <RoleSelect
      value={right.role}
      allowRemove
      disabled={busy}
      onChange={handleChange}
      aria-label={`Access for ${name}`}
    />
  );
}

interface PersonRowProps {
  agentSubject: string;
  isYou?: boolean;
  detail?: string;
  control?: React.ReactNode;
}

function PersonRow({
  agentSubject,
  isYou,
  detail,
  control,
}: PersonRowProps): JSX.Element {
  const agent = useResource(agentSubject);
  const [name] = useTitle(agent);
  const [members] = useArray(agent, GROUP_MEMBERS);
  const [showCovered, setShowCovered] = useState(false);
  const group = isGroup(agent);
  const shownDetail = group
    ? plural(members.length, ['Group, # member', 'Group, # members'])
    : detail;

  return (
    <>
      <Row
        data-test={group ? undefined : 'share-person'}
        data-testid={group ? 'share-group' : undefined}
      >
        {group ? (
          <GroupAvatar />
        ) : (
          <AgentAvatar agentSubject={agentSubject} size='2.6rem' />
        )}
        <Who>
          <Name $wrap={group}>
            <ProfileLink subject={agentSubject} clean>
              {name}
            </ProfileLink>
            {isYou && ' (you)'}
          </Name>
          {shownDetail && (
            <Detail $wrap={group}>
              {shownDetail}
              {group && members.length > 0 && (
                <>
                  {' · '}
                  <CoveredToggle
                    type='button'
                    aria-expanded={showCovered}
                    onClick={() => setShowCovered(!showCovered)}
                  >
                    {showCovered ? 'Hide' : 'Show'}
                  </CoveredToggle>
                </>
              )}
            </Detail>
          )}
        </Who>
        {control}
      </Row>
      {group && showCovered && <CoveredPeople group={agent} />}
    </>
  );
}

/** Who a group in the list actually lets in, nested groups included. */
function CoveredPeople({ group }: { group: Resource }): JSX.Element {
  const { agents, loading } = useEffectiveMembers(group);

  return (
    <Covered data-testid='share-group-covered'>
      {loading && <Detail>Loading...</Detail>}
      {agents.map(subject => (
        <PersonRow key={subject} agentSubject={subject} />
      ))}
    </Covered>
  );
}

function InheritedGroup({
  setIn,
  agents,
}: {
  setIn: string;
  agents: MergedRight[];
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const parent = useResource(setIn);
  const [title] = useTitle(parent);
  const classLabel = useClassLabel(parent).toLowerCase();

  return (
    <>
      <Row>
        <CountCircle aria-hidden>+{agents.length}</CountCircle>
        <Who>
          <InheritedText>
            {agents.length} more through {classLabel} <strong>{title}</strong>
          </InheritedText>
        </Who>
        <ShowButton
          type='button'
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Hide' : 'Show'}
        </ShowButton>
      </Row>
      {open &&
        agents.map(right => (
          <PersonRow
            key={right.agentSubject}
            agentSubject={right.agentSubject}
            control={
              <StaticRole>
                {roleLabel(right.write ? 'write' : 'read')}
              </StaticRole>
            }
          />
        ))}
    </>
  );
}

/** Rights set on parents, per parent, leaving out people already listed. */
function groupInherited(
  inherited: MergedRight[],
  shown: Set<string | undefined>,
): Map<string, MergedRight[]> {
  const groups = new Map<string, MergedRight[]>();
  const seen = new Set<string>();

  for (const right of inherited) {
    if (
      right.agentSubject === urls.instances.publicAgent ||
      shown.has(right.agentSubject) ||
      seen.has(right.agentSubject) ||
      !(right.read || right.write)
    ) {
      continue;
    }

    seen.add(right.agentSubject);
    const group = groups.get(right.setIn) ?? [];
    group.push(right);
    groups.set(right.setIn, group);
  }

  return groups;
}

export function effectiveRole(
  agent: string | undefined,
  rights: DirectRight[],
  inherited: MergedRight[],
  canWrite: boolean,
): ShareRole | undefined {
  if (!agent) return undefined;
  if (canWrite) return 'write';

  const direct = rights.find(r => r.agentSubject === agent);

  if (direct) return direct.role;

  const parent = inherited.filter(r => r.agentSubject === agent);

  if (parent.some(r => r.write)) return 'write';
  if (parent.some(r => r.read)) return 'read';

  return undefined;
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

const Row = styled.div`
  display: flex;
  align-items: center;
  gap: 0.9rem;
  min-height: 3.6rem;
  padding-block: 0.3rem;
`;

const Who = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
`;

const Name = styled.span<{ $wrap?: boolean }>`
  font-size: 1.05rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: ${p => (p.$wrap ? 'normal' : 'nowrap')};
  overflow-wrap: anywhere;
`;

const ProfileLink = styled(AtomicLink)`
  color: inherit;
  text-decoration: none;

  &:hover,
  &:focus-visible {
    text-decoration: underline;
  }
`;

const CoveredToggle = styled.button`
  border: none;
  background: none;
  padding: 0;
  color: ${p => p.theme.colors.main};
  font: inherit;
  font-weight: 600;
  cursor: pointer;

  &:hover {
    text-decoration: underline;
  }
`;

const Covered = styled.div`
  display: flex;
  flex-direction: column;
  margin-left: 1.3rem;
  padding-left: 1.3rem;
  border-left: 2px solid ${p => p.theme.colors.bg2};
`;

const Detail = styled.span<{ $wrap?: boolean }>`
  color: ${p => p.theme.colors.textLight};
  font-size: 0.95rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: ${p => (p.$wrap ? 'normal' : 'nowrap')};
`;

const StaticRole = styled.span`
  flex-shrink: 0;
  padding-inline: 0.75rem 1.1rem;
  color: ${p => p.theme.colors.textLight};
  font-size: 0.95rem;
`;

const CountCircle = styled.span`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 2.6rem;
  height: 2.6rem;
  border-radius: 50%;
  border: 2px dashed ${p => p.theme.colors.bg2};
  color: ${p => p.theme.colors.textLight};
  font-size: 0.85rem;
  font-weight: bold;
`;

const InheritedText = styled.span`
  color: ${p => p.theme.colors.text1};

  strong {
    color: ${p => p.theme.colors.text};
  }
`;

const ShowButton = styled.button`
  flex-shrink: 0;
  border: none;
  background: none;
  padding: 0.4rem 0;
  color: ${p => p.theme.colors.main};
  font: inherit;
  font-weight: 600;
  cursor: pointer;

  &:hover {
    text-decoration: underline;
  }
`;

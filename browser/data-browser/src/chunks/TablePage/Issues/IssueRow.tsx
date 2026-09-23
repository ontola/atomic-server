import { commits, useResource, useTitle } from '@tomic/react';
import { styled } from 'styled-components';
import { type JSX } from 'react';
import {
  FaRegCircleDot,
  FaRegCircleCheck,
  FaRegComment,
} from 'react-icons/fa6';
import { AtomicLink } from '@components/AtomicLink';
import { Button } from '@components/Button';
import { Tag } from '@components/Tag';
import { formatTimeAgo } from '@helpers/formatTimeAgo';
import { plural } from '@helpers/plural';
import { useCommentCount } from '../../../hooks/useCommentCount';
import {
  isIssueClosed,
  statusPills,
  type IssueStatusModel,
} from './issueStatus';

interface IssueRowProps {
  subject: string;
  /** What decides open vs closed, and which status tags earn a pill. */
  model: IssueStatusModel;
  /** An integer column holding the issue's number, when the table has one. */
  numberProp: string | undefined;
  readOnly: boolean;
  onToggleClosed: (subject: string, closed: boolean) => void | Promise<void>;
}

/**
 * One line of the issue list: state icon, title, any non-default status as a
 * pill, then `#number opened …` underneath and the comment count on the right.
 * The title links to the issue's own page, where its description and the
 * Comments panel live — the list stays a list.
 */
export function IssueRow({
  subject,
  model,
  numberProp,
  readOnly,
  onToggleClosed,
}: IssueRowProps): JSX.Element {
  const resource = useResource(subject);
  const [title] = useTitle(resource);
  // `useResource` re-renders on any change to the row, so plain reads are
  // live: a status flipped from the issue page or by a sync shows up here.
  const status = resource.get(model.property);
  const createdAt = resource.get(commits.properties.createdAt);
  const number = numberProp ? resource.get(numberProp) : undefined;
  const { count, hasUnseen } = useCommentCount(subject);

  const closed = isIssueClosed(model, status);
  const pills = statusPills(model, status);
  const opened =
    typeof createdAt === 'number' ? formatTimeAgo(new Date(createdAt)) : '';
  const shownNumber = typeof number === 'number' ? number : undefined;

  return (
    <Row data-testid='issue-row' data-closed={closed || undefined}>
      <StateIcon
        role='img'
        $closed={closed}
        aria-label={closed ? 'Closed' : 'Open'}
      >
        {closed ? (
          <FaRegCircleCheck aria-hidden />
        ) : (
          <FaRegCircleDot aria-hidden />
        )}
      </StateIcon>
      <Body>
        <TitleLine>
          <TitleLink subject={subject}>{title}</TitleLink>
          {pills.map(tag => (
            <Tag key={tag} subject={tag} />
          ))}
        </TitleLine>
        <Meta>
          {shownNumber !== undefined && <span>#{shownNumber}</span>}
          {opened && <span>opened {opened}</span>}
        </Meta>
      </Body>
      <Side>
        {count > 0 && (
          <Comments
            $unseen={hasUnseen}
            title={plural(count, ['# comment', '# comments'])}
          >
            <FaRegComment aria-hidden /> {count}
          </Comments>
        )}
        {!readOnly && (
          <ToggleButton
            subtle
            type='button'
            // The visible word alone is ambiguous in a list of them.
            aria-label={closed ? `Reopen ${title}` : `Close ${title}`}
            onClick={() => void onToggleClosed(subject, !closed)}
          >
            {closed ? 'Reopen' : 'Close'}
          </ToggleButton>
        )}
      </Side>
    </Row>
  );
}

const ToggleButton = styled(Button)`
  opacity: 0;
  transition: opacity 0.1s;
  padding-block: 0.15rem;
  font-size: 0.85em;

  &:focus-visible {
    opacity: 1;
  }
`;

const Row = styled.li`
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  padding: 0.55rem 0.9rem;
  border-top: 1px solid ${p => p.theme.colors.bg2};

  &:hover,
  &:focus-within {
    background: ${p => p.theme.colors.bg1};
  }

  &:hover ${ToggleButton}, &:focus-within ${ToggleButton} {
    opacity: 1;
  }
`;

const StateIcon = styled.span<{ $closed: boolean }>`
  display: inline-flex;
  margin-top: 0.15rem;
  font-size: 1.05em;
  flex-shrink: 0;
  color: ${p => (p.$closed ? '#8250df' : '#1a7f37')};
`;

const Body = styled.div`
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
`;

const TitleLine = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.4rem;
`;

const TitleLink = styled(AtomicLink)`
  font-weight: 600;
  color: ${p => p.theme.colors.text};
  text-decoration: none;
  overflow-wrap: anywhere;

  &:hover {
    color: ${p => p.theme.colors.main};
    text-decoration: underline;
  }
`;

const Meta = styled.div`
  display: flex;
  gap: 0.5rem;
  font-size: 0.8em;
  color: ${p => p.theme.colors.textLight};
`;

const Side = styled.div`
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-shrink: 0;
`;

const Comments = styled.span<{ $unseen: boolean }>`
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.85em;
  color: ${p => (p.$unseen ? p.theme.colors.main : p.theme.colors.textLight)};
`;

import { styled } from 'styled-components';
import { FaMessage } from 'react-icons/fa6';
import { useCommentCount } from '../hooks/useCommentCount';

interface CommentCountBadgeProps {
  subject: string;
  className?: string;
}

/**
 * Small pill showing the number of comments on a resource (Messages whose
 * `about` points at it). Renders nothing when there are none. Highlighted when
 * there are messages the user hasn't seen on this device.
 */
export function CommentCountBadge({
  subject,
  className,
}: CommentCountBadgeProps) {
  const { count: commentCount, hasUnseen } = useCommentCount(subject);

  if (!commentCount) {
    return null;
  }

  return (
    <Badge
      className={className}
      data-unseen={hasUnseen ? '' : undefined}
      data-testid='comment-count-badge'
      title={
        hasUnseen
          ? /* @wc-ignore */ `${commentCount} comments (new messages)`
          : /* @wc-ignore */ `${commentCount} comments`
      }
    >
      <FaMessage />
      {commentCount}
    </Badge>
  );
}

const Badge = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 0.4ch;
  font-size: 0.75rem;
  padding: 0.1rem 0.5rem;
  border-radius: 1em;
  background: ${p => p.theme.colors.bg1};
  color: ${p => p.theme.colors.textLight};

  & > svg {
    font-size: 0.65rem;
  }

  &[data-unseen] {
    background: ${p => p.theme.colors.main};
    color: ${p => p.theme.colors.bg};
  }
`;

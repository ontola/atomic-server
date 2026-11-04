import { FaRegStar, FaStar } from 'react-icons/fa6';
import { styled } from 'styled-components';
import { useSavedDriveToggle } from '../../hooks/useSavedDriveToggle';

interface FavoriteButtonProps {
  subject: string;
  className?: string;
}

export function FavoriteButton({ subject, className }: FavoriteButtonProps) {
  const [isFavorite, handleClick] = useSavedDriveToggle(subject);
  const Icon = isFavorite ? FaStar : FaRegStar;

  return (
    <StyledButton
      className={className}
      onClick={handleClick}
      title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
    >
      <Icon />
    </StyledButton>
  );
}

const StyledButton = styled.button`
  background: none;
  border: none;
  cursor: pointer;
  color: ${p => p.theme.colors.main};
  width: 1.3rem;
  display: flex;
  align-items: center;
  padding: 0;
`;

import { useCallback } from 'react';
import { canonicalizeScheme } from '@tomic/react';
import { FaRegStar, FaStar } from 'react-icons/fa6';
import { styled } from 'styled-components';
import { useDriveHistory } from '../../hooks/useDriveHistory';
import { useSavedDrives } from '../../hooks/useSavedDrives';

interface FavoriteButtonProps {
  subject: string;
  className?: string;
}

export function FavoriteButton({ subject, className }: FavoriteButtonProps) {
  const [savedDrives, addSaveDrive, removeSaveDrive] = useSavedDrives();
  const [_, , removeFromHistory] = useDriveHistory();

  const isFavorite = savedDrives.some(
    s => canonicalizeScheme(s) === canonicalizeScheme(subject),
  );
  const Icon = isFavorite ? FaStar : FaRegStar;

  const handleClick = useCallback(() => {
    if (isFavorite) {
      removeSaveDrive(subject);
      removeFromHistory(subject);
    } else {
      addSaveDrive(subject);
      removeFromHistory(subject);
    }
  }, [subject, removeFromHistory, addSaveDrive, removeSaveDrive, isFavorite]);

  return (
    <StyledButton
      className={className}
      onClick={handleClick}
      title={isFavorite ? 'Remove from My drives' : 'Add to My drives'}
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

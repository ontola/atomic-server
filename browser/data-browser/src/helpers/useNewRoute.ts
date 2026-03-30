import { useCallback } from 'react';
import { paths } from '../routes/paths';
import { useNavigate } from '@tanstack/react-router';

export function useNewRoute(parent?: string) {
  const navigate = useNavigate();

  const navigateToNewRoute = useCallback(() => {
    navigate({
      to: paths.new,
      search: parent ? { parentSubject: parent } : {},
    });
  }, [navigate, parent]);

  return navigateToNewRoute;
}

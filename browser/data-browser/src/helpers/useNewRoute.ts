import { useCallback } from 'react';
import { paths } from '../routes/paths';
import { useNavigate } from '@tanstack/react-router';

export function useNewRoute(parent?: string) {
  const navigate = useNavigate();

  const navigateToNewRoute = useCallback(() => {
    navigate({
      to: paths.new,
      search: {
        classSubject: undefined,
        parent: undefined,
        parentSubject: parent,
        newSubject: undefined,
      },
    });
  }, [navigate, parent]);

  return navigateToNewRoute;
}

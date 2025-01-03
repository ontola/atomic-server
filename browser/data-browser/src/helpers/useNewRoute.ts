import { useCallback } from 'react';
import { paths } from '../routes/paths';
import { useNavigate } from '@tanstack/react-router';

function buildURL(parent?: string) {
  const params = new URLSearchParams({
    ...(parent ? { parentSubject: parent } : {}),
  });

  return `${paths.new}?${params.toString()}`;
}

export function useNewRoute(parent?: string) {
  const navigate = useNavigate();

  const navigateToNewRoute = useCallback(() => {
    const url = buildURL(parent);
    navigate({ to: url });
  }, [parent]);

  return navigateToNewRoute;
}

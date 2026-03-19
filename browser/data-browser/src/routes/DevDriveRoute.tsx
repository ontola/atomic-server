import { createLazyRoute } from '@tanstack/react-router';
import { useEffect } from 'react';
import { useDevDrive } from '../hooks/useDevDrive';

const DevDriveRoute: React.FC = () => {
  const { createDevDrive } = useDevDrive();

  useEffect(() => {
    createDevDrive();
  }, []);

  return <p style={{ padding: '1rem' }}>Setting up dev drive...</p>;
};

export const devDriveRouteLazy = createLazyRoute('/app/dev-drive')({
  component: DevDriveRoute,
});

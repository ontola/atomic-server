import { describe, expect, it, vi } from 'vitest';
import { useCurrentSubject } from './useCurrentSubject';
const route = vi.hoisted(() => ({
  pathname: '/app',
  subject: undefined as string | undefined,
}));
vi.mock('@tanstack/react-router', () => ({
  useSearch: () => ({ subject: route.subject }),
  useLocation: () => route,
}));
vi.mock('../hooks/useNavigateWithTransition', () => ({
  useNavigateWithTransition: () => vi.fn(),
}));
vi.mock('../routes/ShowRoute', () => ({
  ShowRoute: { useNavigate: () => vi.fn() },
}));
vi.mock('@tomic/react', () => ({
  useStore: () => ({ getServerUrl: () => 'http://localhost:9896' }),
}));
vi.mock('./tauri', () => ({
  getLocalServerOrigin: () => 'http://localhost:9896',
}));
vi.mock('./homeDrive', () => ({ getHomeDrive: () => undefined }));
vi.mock('../config', () => ({ isDev: () => true }));
describe('current resource on application routes', () => {
  it.each(['/app', '/app/', '/app/settings'])(
    'does not treat %s as an Atomic resource',
    pathname => {
      route.pathname = pathname;
      route.subject = undefined;
      expect(useCurrentSubject()[0]).toBeUndefined();
    },
  );
  it('retains an explicit resource on the show route', () => {
    route.pathname = '/app/show';
    route.subject = 'did:ad:bread';
    expect(useCurrentSubject()[0]).toBe('did:ad:bread');
  });
});

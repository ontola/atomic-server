// @wc-ignore-file
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ThemeProvider, type DefaultTheme } from 'styled-components';
import { GettingStartedPanel } from './GettingStartedPanel';

type Step = { id: string; done: boolean; needs?: string };
let steps: Step[] = [];
let agent: string | undefined = 'did:ad:agent:me';
let writers = ['did:ad:agent:me'];
let isPrivate = false;
let canEdit = true;

vi.mock('@tomic/react', () => ({
  core: { properties: { name: 'name', write: 'write' } },
  useResource: () => drive,
  useCanWrite: () => canEdit,
  useArray: () => [writers],
  server: { classes: { drive: 'drive' } },
  useString: () => ['Welcome to Atomic'],
  useCurrentAgent: () => [agent ? { subject: agent } : undefined],
}));
vi.mock('@helpers/useNewRoute', () => ({
  useNewRoute: () => vi.fn(),
}));
vi.mock('@hooks/useOnboardingProgress', () => ({
  useOnboardingProgress: () => ({
    steps,
    doneCount: steps.filter(s => s.done).length,
  }),
}));
vi.mock('@hooks/useUserSetting', () => ({
  userSettingProps: {},
  useUserSetting: (_p: string, _k: string, fallback: unknown) => [
    fallback,
    () => {},
  ],
}));
vi.mock('@hooks/useIsPrivateDrive', () => ({
  useIsPrivateDrive: () => isPrivate,
}));
vi.mock('@hooks/useNavigateWithTransition', () => ({
  useNavigateWithTransition: () => () => {},
}));
vi.mock('@components/AI/AISidebarContext', () => ({
  useAISidebar: () => ({ openChat: () => {} }),
}));
vi.mock('@hooks/useKnownPortalUrl', () => ({
  useKnownPortalUrl: () => 'https://portal.example',
}));
vi.mock('@components/SaveWork/saveWorkDialogState', () => ({
  openSaveWorkDialog: vi.fn(),
}));
vi.mock('@components/Share/shareDialogState', () => ({
  openShareDialog: () => {},
}));
vi.mock('@helpers/AppSettings', () => ({
  useSettings: () => ({ drive: 'did:ad:drive' }),
}));
vi.mock('../UiHint', () => ({
  UiHint: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('./SideBarPanel', () => ({
  SideBarPanel: ({
    children,
    title,
    actions,
  }: {
    children: React.ReactNode;
    title: string;
    actions: React.ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {actions}
      {children}
    </section>
  ),
}));
const drive: never = {
  subject: 'did:ad:drive',
  get: (p: string) => (p === 'write' ? writers : 'Welcome to Atomic'),
} as never;
const render = () =>
  renderToStaticMarkup(
    <ThemeProvider theme={{ colors: {} } as unknown as DefaultTheme}>
      <GettingStartedPanel />
    </ThemeProvider>,
  );
const fresh = (): Step[] =>
  ['name', 'create', 'ai', 'invite', 'save'].map(id => ({
    id,
    done: false,
  }));

beforeEach(() => {
  steps = fresh();
  agent = 'did:ad:agent:me';
  writers = ['did:ad:agent:me'];
  isPrivate = false;
  canEdit = true;
});

describe('GettingStartedPanel', () => {
  it('shows the count and every step, as rows, without a blocked row', () => {
    steps[0].done = true;
    const html = render();

    expect(html).toMatch(/1\s*(<!-- -->)?\s*of/);
    for (const title of [
      'Name your drive',
      'Make something',
      'Talk to the AI',
      'Invite someone',
      'Register with email',
    ])
      expect(html).toContain(title);
  });

  it('keeps hints in the tooltip and done rows inert', () => {
    steps[0].done = true;
    steps[2].needs = 'ai-source';
    const html = render();

    expect(html).toContain('Needs an AI source');
    expect(html).not.toMatch(/<strong/);
    const row = (title: string) =>
      html.split('<button').find(b => b.includes(`>${title}<`));
    expect(row('Name your drive')).toContain('disabled=""');
    expect(row('Talk to the AI')).not.toContain('disabled=""');
  });

  it("is gone when finished, read-only, private or someone else's", () => {
    steps = steps.map(s => ({ ...s, done: true }));
    expect(render()).toBe('');
    steps = fresh();
    canEdit = false;
    expect(render()).toBe('');
    canEdit = true;
    isPrivate = true;
    expect(render()).toBe('');
    isPrivate = false;
    writers = ['did:ad:agent:other', 'did:ad:agent:me'];
    expect(render()).toBe('');
  });
});

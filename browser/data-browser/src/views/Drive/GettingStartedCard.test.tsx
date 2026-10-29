// @wc-ignore-file
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ThemeProvider, type DefaultTheme } from 'styled-components';
import { GettingStartedCard } from './GettingStartedCard';

type Step = { id: string; done: boolean; needs?: string };
let steps: Step[] = [];
let hidden = false;
let agent: string | undefined = 'did:ad:agent:me';
let writers = ['did:ad:agent:me'];
let isPrivate = false;

vi.mock('@tomic/react', () => ({
  core: { properties: { name: 'name', write: 'write' } },
  useString: () => ['Welcome to Atomic'],
  useCurrentAgent: () => [agent ? { subject: agent } : undefined],
}));
vi.mock('@hooks/useOnboardingProgress', () => ({
  useOnboardingProgress: () => ({
    steps,
    projectDrive: 'did:ad:project',
    doneCount: steps.filter(s => s.done).length,
    hidden,
    hide: () => {},
  }),
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
vi.mock('@components/Share/shareDialogState', () => ({
  openShareDialog: () => {},
}));
vi.mock('@components/Card', () => ({
  Card: ({ children }: { children: React.ReactNode }) => (
    <section>{children}</section>
  ),
}));
vi.mock('@components/Button', () => ({
  Button: ({
    children,
    disabled,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
  }) => <button disabled={disabled}>{children}</button>,
}));
vi.mock('@components/Row', () => ({
  Row: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Column: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
const drive = {
  subject: 'did:ad:drive',
  get: (p: string) => (p === 'write' ? writers : 'Welcome to Atomic'),
} as never;
const render = (canEdit = true) =>
  renderToStaticMarkup(
    <ThemeProvider theme={{ colors: {} } as unknown as DefaultTheme}>
      <GettingStartedCard drive={drive} canEdit={canEdit} />
    </ThemeProvider>,
  );
const fresh = (): Step[] =>
  ['name', 'project', 'ai', 'invite', 'save'].map(id => ({ id, done: false }));

beforeEach(() => {
  steps = fresh();
  steps[3].needs = 'project';
  hidden = false;
  agent = 'did:ad:agent:me';
  writers = ['did:ad:agent:me'];
  isPrivate = false;
});

describe('GettingStartedCard', () => {
  it('shows the count and every step, with Invite disabled for a reason', () => {
    steps[0].done = true;
    const html = render();

    expect(html).toMatch(/1\s*(<!-- -->)?\s*of/);
    for (const title of [
      'Name your drive',
      'Start a project',
      'Talk to the AI',
      'Invite someone',
      'Save your work',
    ])
      expect(html).toContain(title);
    expect(html).toContain('Start a project first');
    expect(html).toMatch(/<button disabled="">Invite<\/button>/);
  });

  it('says what the AI needs and offers setup instead', () => {
    steps[2].needs = 'ai-source';
    const html = render();

    expect(html).toContain('Needs an AI source');
    expect(html).toContain('Set up AI');
  });

  it("is gone when hidden, finished, read-only, private or someone else's", () => {
    hidden = true;
    expect(render()).toBe('');
    hidden = false;
    steps = steps.map(s => ({ ...s, done: true }));
    expect(render()).toBe('');
    steps = fresh();
    expect(render(false)).toBe('');
    isPrivate = true;
    expect(render()).toBe('');
    isPrivate = false;
    writers = ['did:ad:agent:other', 'did:ad:agent:me'];
    expect(render()).toBe('');
  });
});

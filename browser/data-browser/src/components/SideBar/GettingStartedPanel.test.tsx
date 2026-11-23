// @wc-ignore-file
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ThemeProvider, type DefaultTheme } from 'styled-components';
import { GettingStartedPanel } from './GettingStartedPanel';

type Step = { id: string; done: boolean; needs?: string };
let steps: Step[] = [];
let advancedSteps: Step[] = [];
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
    advancedSteps,
    advancedDoneCount: advancedSteps.filter(s => s.done).length,
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
  useAISidebar: () => ({ openChat: () => {}, askAI: () => {} }),
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
vi.mock('../Dialog', () => ({
  Dialog: () => null,
  useDialog: () => [{}, () => {}, () => {}, false],
}));
vi.mock('@views/Conversation/NewMessageDialog', () => ({
  NewMessageDialogBody: () => null,
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
const render = (placement?: 'sidebar' | 'page') =>
  renderToStaticMarkup(
    <ThemeProvider theme={{ colors: {} } as unknown as DefaultTheme}>
      <GettingStartedPanel placement={placement} />
    </ThemeProvider>,
  );
const fresh = (): Step[] =>
  ['name', 'create', 'ai', 'invite', 'save'].map(id => ({
    id,
    done: false,
  }));

const freshAdvanced = (): Step[] =>
  ['table', 'form', 'app', 'message'].map(id => ({ id, done: false }));

beforeEach(() => {
  steps = fresh();
  advancedSteps = freshAdvanced();
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
      'Save your work',
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

  it('renders the same steps as a drive page section, without the panel', () => {
    const html = render('page');

    expect(html).toContain('data-testid="getting-started-page"');
    expect(html).not.toContain('<h2>Getting started</h2>');
    expect(html).toContain('Getting started');
    expect(html).toMatch(/0\s*(<!-- -->)?\s*of/);
    expect(html).toContain('Name your drive');
    expect(html).toContain('Save your work');
    steps = steps.map(s => ({ ...s, done: true }));
    advancedSteps = advancedSteps.map(s => ({ ...s, done: true }));
    expect(render('page')).toBe('');
  });

  it('moves on to the advanced round once the basics are done, then goes', () => {
    steps = steps.map(s => ({ ...s, done: true }));
    const html = render();

    expect(html).toContain('Next steps');
    expect(html).not.toContain('Getting started');
    expect(html).toMatch(/0\s*(<!-- -->)?\s*of\s*(<!-- -->)?\s*4/);
    expect(html).toContain('Make a table');
    expect(html).toContain('Make a form');
    expect(html).toContain('Build an app with AI');
    expect(html).toContain('Send someone a message');
    expect(html).not.toContain('Name your drive');
    advancedSteps[2].needs = 'ai-source';
    expect(render()).toContain('Needs an AI source');
    advancedSteps[0].done = true;
    expect(render()).toMatch(/1\s*(<!-- -->)?\s*of/);
    advancedSteps = advancedSteps.map(s => ({ ...s, done: true }));
    expect(render()).toBe('');
  });

  it("is gone when finished, read-only, private or someone else's", () => {
    steps = steps.map(s => ({ ...s, done: true }));
    advancedSteps = advancedSteps.map(s => ({ ...s, done: true }));
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

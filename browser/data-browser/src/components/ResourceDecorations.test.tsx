// @vitest-environment jsdom
// @wc-ignore-file
import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render as renderReact,
  screen,
} from '@testing-library/react';
import {
  ThemeProvider,
  buildTheme,
} from '../../../resource-ui/test/providers.js';
import {
  IconPickerDialog,
  TitleIcon,
} from '@tomic/resource-ui/components/ResourceDecorations';

function render(ui: React.ReactNode) {
  return renderReact(ui, {
    wrapper: ({ children }) => (
      <ThemeProvider theme={buildTheme()}>{children}</ThemeProvider>
    ),
  });
}

// The resource's properties, shared between the mocked hooks and the asserts.
const db = vi.hoisted(() => ({ props: {} as Record<string, unknown> }));

vi.mock('@tomic/react', async () => {
  const react = await import('react');

  const useProp = (_resource: unknown, property: string) => {
    const [, rerender] = react.useState(0);

    return [
      db.props[property],
      async (value: unknown) => {
        db.props[property] = value;
        rerender(n => n + 1);
      },
    ];
  };

  return {
    Image: () => null,
    core: { properties: { isA: 'isA' }, classes: { agent: 'agent' } },
    dataBrowser: {
      properties: {
        emoji: 'emoji',
        icon: 'icon',
        coverImage: 'coverImage',
        coverImageFocus: 'coverImageFocus',
      },
    },
    useArray: () => [[]],
    useCanWrite: () => db.props.canWrite !== false,
    useNumber: useProp,
    useString: useProp,
    useSubject: useProp,
  };
});
vi.mock('@tomic/resource-ui/hooks/useUpload', () => ({
  useUpload: () => ({ upload: vi.fn() }),
}));
vi.mock('@tomic/resource-ui/components/ErrorBoundary', () => ({
  ErrorBoundary: () => null,
}));
vi.mock('@tomic/resource-ui/components/ResourceGlyph', () => ({
  ResourceGlyph: () => <i>glyph</i>,
}));
vi.mock('@tomic/resource-ui/components/AvatarCropper', () => ({
  AvatarCropper: () => null,
}));
vi.mock('@tomic/ui/components/Button', () => ({
  Button: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => <button onClick={onClick}>{children}</button>,
}));
vi.mock('@tomic/ui/components/Row', () => ({
  Row: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Column: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
// A dialog that is open exactly as long as its owner says so.
vi.mock('@tomic/resource-ui/components/Dialog/index', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  useDialog: ({ bindShow }: { bindShow: (show: boolean) => void }) => [
    {},
    () => undefined,
    () => bindShow(false),
  ],
}));
vi.mock(
  '@tomic/resource-ui/components/forms/FilePicker/FilePickerDialog',
  () => ({
    FilePickerDialog: ({
      show,
      onResourcePicked,
    }: {
      show: boolean;
      onResourcePicked: (subject: string) => void;
    }) =>
      show ? (
        <button onClick={() => onResourcePicked('did:ad:file')}>
          the file
        </button>
      ) : null,
  }),
);
vi.mock('@tomic/resource-ui/chunks/EmojiInput/EmojiInput', () => ({
  EmojiPickerPanel: ({
    onEmojiSelect,
  }: {
    onEmojiSelect: (e: { native: string }) => void;
  }) => (
    <button onClick={() => onEmojiSelect({ native: '🦊' })}>an emoji</button>
  ),
}));

const resource = { subject: 'did:ad:page' } as never;

/** Closes like the real owner does when the dialog reports it closed. */
const Harness = () => {
  const [show, setShow] = useState(true);

  return (
    <IconPickerDialog resource={resource} show={show} onShowChange={setShow} />
  );
};

beforeEach(() => {
  db.props = {};
});
afterEach(cleanup);

describe('IconPickerDialog', () => {
  it('opens the file picker after "Pick existing"; the picked file becomes the icon and clears the emoji', async () => {
    db.props.emoji = '🦊';
    render(<Harness />);

    expect(screen.queryByText('the file')).toBeNull();
    fireEvent.click(screen.getByText('Pick existing'));

    // The dialog has closed itself, and the file picker is still there.
    expect(screen.queryByText('Pick existing')).toBeNull();
    fireEvent.click(await screen.findByText('the file'));

    await vi.waitFor(() => expect(db.props.icon).toBe('did:ad:file'));
    expect(db.props.emoji).toBeUndefined();
  });

  it('a picked emoji replaces an image icon', async () => {
    db.props.icon = 'did:ad:file';
    render(<Harness />);

    fireEvent.click(screen.getByText('an emoji'));

    await vi.waitFor(() => expect(db.props.emoji).toBe('🦊'));
    expect(db.props.icon).toBeUndefined();
  });

  it('"Remove icon" clears both, and is only offered when there is an icon', async () => {
    const { unmount } = render(<Harness />);
    expect(screen.queryByText('Remove icon')).toBeNull();
    unmount();

    db.props.emoji = '🦊';
    db.props.icon = 'did:ad:file';
    render(<Harness />);
    fireEvent.click(screen.getByText('Remove icon'));

    await vi.waitFor(() => expect(db.props.emoji).toBeUndefined());
    expect(db.props.icon).toBeUndefined();
  });
});

describe('TitleIcon', () => {
  it('opens the picker through its callback without clicking the title', () => {
    db.props.emoji = '🦊';
    const onPickIcon = vi.fn();
    const onTitleClick = vi.fn();
    render(
      // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- stands in for the click-to-edit title
      <h1 onClick={onTitleClick}>
        <TitleIcon resource={resource} onPickIcon={onPickIcon} />
      </h1>,
    );

    fireEvent.click(screen.getByTitle('Change icon'));

    expect(onPickIcon).toHaveBeenCalledTimes(1);
    expect(onTitleClick).not.toHaveBeenCalled();
  });

  it('is plain, non-interactive glyph when the resource cannot be edited', () => {
    db.props.emoji = '🦊';
    db.props.canWrite = false;
    render(<TitleIcon resource={resource} onPickIcon={vi.fn()} />);

    expect(screen.queryByTitle('Change icon')).toBeNull();
    expect(screen.getByText('glyph')).toBeTruthy();
  });

  it('renders nothing without an icon', () => {
    const { container } = render(
      <TitleIcon resource={resource} onPickIcon={vi.fn()} />,
    );

    expect(container.innerHTML).toBe('');
  });
});

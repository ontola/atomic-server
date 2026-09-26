import {
  Collection,
  Datatype,
  JSONValue,
  Property,
  Resource,
  commits,
  core,
  useResources,
  useStore,
} from '@tomic/react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { styled } from 'styled-components';
import { FaRegCircleDot, FaRegCircleCheck } from 'react-icons/fa6';
import { LoaderBlock } from '@components/Loader';
import { Button } from '@components/Button';
import { InputStyled } from '@components/forms/InputStyles';
import { useAllMembers } from '../helpers/useAllMembers';
import { useCreateRow } from '../helpers/useCreateRow';
import { IssueRow } from './IssueRow';
import { useIssueStatus } from './useIssueStatus';
import {
  isIssueClosed,
  matchesIssueFilter,
  statusValueFor,
} from './issueStatus';

interface IssuesViewProps {
  /** The Table resource; new issues are created as its children. */
  tableSubject: string;
  tableClass: Resource;
  /** Every property of the class (used to find/adopt the status enum). */
  allColumns: Property[];
  collection: Collection;
  ready: boolean;
  viewGroupBy: string | undefined;
  setViewGroupBy: (property: string) => void;
  readOnly: boolean;
}

type Filter = 'open' | 'closed';

/**
 * A GitHub-style issue list over a table with a status column: an Open /
 * Closed split, a filter box, a New issue box, and one line per issue that
 * links to its page. Same data as the kanban board — the status property the
 * board groups by is what decides open vs closed here — so a table can offer
 * both and nothing about its rows changes.
 */
export function IssuesView({
  tableSubject,
  tableClass,
  allColumns,
  collection,
  ready,
  viewGroupBy,
  setViewGroupBy,
  readOnly,
}: IssuesViewProps): JSX.Element {
  const store = useStore();

  const { model, status } = useIssueStatus(
    tableClass,
    allColumns,
    viewGroupBy,
    setViewGroupBy,
    !readOnly,
  );

  // "GitHub issue number", "Ticket number", "Number": the first integer column
  // named like one. Shown as `#12` under the title, and searchable.
  const numberProp = useMemo(
    () =>
      allColumns.find(
        c =>
          c.datatype === Datatype.INTEGER &&
          /number|\bno\.?$|^#$/i.test(c.shortname),
      )?.subject,
    [allColumns],
  );

  // Every row, loaded up front: the open/closed split and the text filter both
  // need the whole table, not one page of it.
  const memberSubjects = useAllMembers(collection);
  const rows = useResources(memberSubjects);

  const [filter, setFilter] = useState<Filter>('open');
  const [search, setSearch] = useState('');

  const { open, closed } = useMemo(() => {
    const result = { open: [] as string[], closed: [] as string[] };

    if (!model) return result;

    for (const subject of memberSubjects) {
      const value = rows.get(subject)?.get(model.property);
      (isIssueClosed(model, value) ? result.closed : result.open).push(subject);
    }

    // Newest first, like GitHub's default.
    const createdAt = (s: string) =>
      (rows.get(s)?.get(commits.properties.createdAt) as number | undefined) ??
      0;
    result.open.sort((a, b) => createdAt(b) - createdAt(a));
    result.closed.sort((a, b) => createdAt(b) - createdAt(a));

    return result;
  }, [memberSubjects, rows, model]);

  const shown = useMemo(() => {
    const list = filter === 'open' ? open : closed;

    if (!search.trim()) return list;

    return list.filter(subject => {
      const resource = rows.get(subject);
      const title = (resource?.get(core.properties.name) as string) ?? '';
      const number = numberProp ? resource?.get(numberProp) : undefined;

      return matchesIssueFilter(
        search,
        title,
        typeof number === 'number' ? number : undefined,
      );
    });
  }, [filter, open, closed, search, rows, numberProp]);

  const [draft, setDraft] = useState('');
  const [creating, setCreating] = useState(false);
  const draftRef = useRef<HTMLInputElement>(null);

  const createRow = useCreateRow(tableSubject, tableClass);

  const handleCreate = useCallback(async () => {
    const trimmed = draft.trim();

    if (!trimmed || readOnly) return;

    const extra: Record<string, JSONValue> = {};
    const openValue = model && statusValueFor(model, false);

    if (model && openValue !== undefined) extra[model.property] = openValue;

    try {
      await createRow(trimmed, extra);
    } catch (error) {
      // Keep the draft: a failed create should not also lose what was typed.
      store.notifyError(error as Error);

      return;
    }

    setDraft('');
    setCreating(false);
    setFilter('open');
  }, [draft, readOnly, model, createRow, store]);

  const handleToggleClosed = useCallback(
    async (subject: string, toClosed: boolean) => {
      const target = model && statusValueFor(model, toClosed);

      if (!model || target === undefined) return;

      try {
        const resource = store.getResourceLoading(subject);
        await resource.set(model.property, target);
        await resource.save();
      } catch (error) {
        store.notifyError(error as Error);
      }
    },
    [store, model],
  );

  useEffect(() => {
    if (creating) draftRef.current?.focus();
  }, [creating]);

  if (status === 'creating' || (!ready && memberSubjects.length === 0)) {
    return (
      <Center>
        <LoaderBlock />
      </Center>
    );
  }

  if (status === 'resolving') {
    // A reader cannot create the Status column, so with no select or checkbox
    // column to read open/closed from this would never resolve. Say so rather
    // than look busy forever. (No columns at all is still the loading state.)
    if (readOnly && allColumns.length > 0) {
      return (
        <Center data-testid='issues-view-unavailable'>
          This table has no status or checkbox column to tell open from closed,
          so it cannot be shown as an issue list.
        </Center>
      );
    }

    return <Center>Setting up the issue tracker…</Center>;
  }

  const rowName = tableClass.title || 'Issue';
  // A select with only open tags (or only closed ones) has nowhere to move
  // an issue to; hide the button rather than offer a no-op.
  const canToggle =
    !!model &&
    statusValueFor(model, true) !== undefined &&
    statusValueFor(model, false) !== undefined;

  return (
    <Wrapper data-testid='issues-view'>
      <Toolbar>
        <Search
          type='search'
          placeholder='Filter by title or #number'
          aria-label='Filter by title or number'
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        {!readOnly && !creating && (
          <Button onClick={() => setCreating(true)}>
            New {rowName.toLowerCase()}
          </Button>
        )}
      </Toolbar>
      {creating && (
        <NewIssue
          onSubmit={e => {
            e.preventDefault();
            void handleCreate();
          }}
        >
          <InputStyled
            ref={draftRef}
            placeholder='Title'
            aria-label={`New ${rowName.toLowerCase()} title`}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              // The table page owns Enter for its grid; handle it here rather
              // than relying on implicit form submission (same as the board).
              if (e.key === 'Enter') {
                e.preventDefault();
                void handleCreate();
              } else if (e.key === 'Escape') {
                setCreating(false);
                setDraft('');
              }
            }}
          />
          <Button type='submit' disabled={!draft.trim()}>
            Submit new {rowName.toLowerCase()}
          </Button>
          <Button
            subtle
            type='button'
            onClick={() => {
              setCreating(false);
              setDraft('');
            }}
          >
            Cancel
          </Button>
        </NewIssue>
      )}
      <ListBox>
        <ListHeader role='group' aria-label='Issue state'>
          <StateTab
            type='button'
            aria-pressed={filter === 'open'}
            $active={filter === 'open'}
            onClick={() => setFilter('open')}
          >
            <FaRegCircleDot aria-hidden />
            <span>{open.length} Open</span>
          </StateTab>
          <StateTab
            type='button'
            aria-pressed={filter === 'closed'}
            $active={filter === 'closed'}
            onClick={() => setFilter('closed')}
          >
            <FaRegCircleCheck aria-hidden />
            <span>{closed.length} Closed</span>
          </StateTab>
        </ListHeader>
        <List>
          {model &&
            shown.map(subject => (
              <IssueRow
                key={subject}
                subject={subject}
                model={model}
                numberProp={numberProp}
                readOnly={readOnly || !canToggle}
                onToggleClosed={handleToggleClosed}
              />
            ))}
          {shown.length === 0 && (
            <Empty>
              {search.trim()
                ? `Nothing matches "${search.trim()}".`
                : filter === 'open'
                  ? 'Nothing open.'
                  : 'Nothing closed.'}
            </Empty>
          )}
        </List>
      </ListBox>
    </Wrapper>
  );
}

const Wrapper = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding-block: 0.5rem;
`;

const Toolbar = styled.div`
  display: flex;
  gap: 0.5rem;
  align-items: center;
`;

const Search = styled(InputStyled)`
  flex: 1;
`;

const NewIssue = styled.form`
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;

  & > input {
    flex: 1;
    min-width: 12rem;
  }
`;

const ListBox = styled.div`
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
  overflow: hidden;
`;

const ListHeader = styled.div`
  display: flex;
  gap: 0.25rem;
  padding: 0.5rem 0.9rem;
  background: ${p => p.theme.colors.bg1};
`;

const StateTab = styled.button<{ $active: boolean }>`
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  background: none;
  border: none;
  cursor: pointer;
  padding: 0.2rem 0.5rem;
  border-radius: ${p => p.theme.radius};
  font: inherit;
  font-size: 0.9em;
  font-weight: ${p => (p.$active ? 600 : 400)};
  color: ${p => (p.$active ? p.theme.colors.text : p.theme.colors.textLight)};

  &:hover {
    color: ${p => p.theme.colors.text};
  }
`;

const List = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;
`;

const Empty = styled.li`
  padding: 2rem 0.9rem;
  text-align: center;
  color: ${p => p.theme.colors.textLight};
  border-top: 1px solid ${p => p.theme.colors.bg2};
`;

const Center = styled.div`
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 2rem;
  color: ${p => p.theme.colors.textLight};
`;

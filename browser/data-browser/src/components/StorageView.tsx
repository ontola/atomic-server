import { useMemo, useState, type ReactNode } from 'react';
import { styled } from 'styled-components';
import { ContainerWide } from './Containers';
import { Main } from './Main';
import { squarify, type StorageNode } from '../helpers/storageMap';

export type Loaded =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'ready'; root: StorageNode };

const MAP_W = 1000;
const MAP_H = 560;

/**
 * Where a drive's space goes, as a size map (like WizTree or dua): one tile per
 * item, area proportional to its size, files and edit history told apart.
 * Click a folder to look inside it; the list underneath is the same data for
 * small screens and screen readers.
 */
export function StorageView({
  loaded,
  onOpen,
  backTo,
}: {
  loaded: Loaded;
  onOpen: (subject: string) => void;
  /** Rendered under the map; the host decides where "back" goes. */
  backTo?: ReactNode;
}) {
  const [trail, setTrail] = useState<string[]>([]);

  const current = useMemo(() => {
    if (loaded.state !== 'ready') return null;

    let node = loaded.root;
    const path: StorageNode[] = [node];

    for (const subject of trail) {
      const next = node.children.find(c => c.subject === subject);

      if (!next) break;
      node = next;
      path.push(node);
    }

    return { node, path };
  }, [loaded, trail]);

  const items = useMemo(() => {
    if (!current) return [];

    const { node } = current;
    // What the item itself holds, apart from what is inside it.
    const self: StorageNode[] =
      node.children.length > 0 && node.ownBytes > 0
        ? [
            {
              ...node,
              name: 'This item itself',
              totalBytes: node.ownBytes,
              totalFileBytes: node.ownFileBytes,
              children: [],
            },
          ]
        : [];

    return [...node.children, ...self].sort(
      (a, b) => b.totalBytes - a.totalBytes,
    );
  }, [current]);

  const tiles = useMemo(
    () =>
      squarify(items, i => i.totalBytes, { x: 0, y: 0, w: MAP_W, h: MAP_H }),
    [items],
  );

  return (
    <Main>
      <ContainerWide>
        <h1>Where space goes</h1>
        <Intro>
          Each tile is an item in this workspace. Bigger tile, more space.{' '}
          <Swatch $files /> files and images, <Swatch /> edit history.
        </Intro>

        {loaded.state === 'loading' && (
          <p data-testid='storage-loading'>Measuring…</p>
        )}
        {loaded.state === 'failed' && (
          <p data-testid='storage-failed'>
            This server could not report storage for the workspace. It may be an
            older version, or you may not be allowed to read it.
          </p>
        )}

        {current && (
          <>
            <Crumbs aria-label='Location'>
              {current.path.map((n, i) => (
                <span key={n.subject}>
                  {i > 0 && ' / '}
                  {i < current.path.length - 1 ? (
                    <CrumbButton
                      type='button'
                      onClick={() => setTrail(trail.slice(0, i))}
                    >
                      {n.name}
                    </CrumbButton>
                  ) : (
                    <strong>{n.name}</strong>
                  )}
                </span>
              ))}{' '}
              <Muted>· {formatBytes(current.node.totalBytes)}</Muted>
            </Crumbs>

            {tiles.length === 0 ? (
              <p data-testid='storage-empty'>Nothing here takes up space.</p>
            ) : (
              <MapBox
                data-testid='storage-map'
                style={{ aspectRatio: `${MAP_W} / ${MAP_H}` }}
              >
                {tiles.map(({ item, rect }) => (
                  <Tile
                    key={item.subject + item.name}
                    type='button'
                    $files={item.totalFileBytes * 2 > item.totalBytes}
                    data-testid='storage-tile'
                    title={`${item.name} · ${formatBytes(item.totalBytes)}`}
                    onClick={() => openItem(item)}
                    style={{
                      left: `${(rect.x / MAP_W) * 100}%`,
                      top: `${(rect.y / MAP_H) * 100}%`,
                      width: `${(rect.w / MAP_W) * 100}%`,
                      height: `${(rect.h / MAP_H) * 100}%`,
                    }}
                  >
                    <TileLabel>
                      <span>{item.name}</span>
                      <Muted>{formatBytes(item.totalBytes)}</Muted>
                    </TileLabel>
                  </Tile>
                ))}
              </MapBox>
            )}

            <List data-testid='storage-list'>
              {items.slice(0, 50).map(item => (
                <li key={item.subject + item.name}>
                  <Bar
                    style={{
                      width: `${Math.max(
                        1,
                        (item.totalBytes / (items[0]?.totalBytes || 1)) * 100,
                      )}%`,
                    }}
                    $files={item.totalFileBytes * 2 > item.totalBytes}
                  />
                  <ListRow>
                    <button type='button' onClick={() => openItem(item)}>
                      {item.name}
                    </button>
                    <Muted>{item.kind ?? ''}</Muted>
                    <span>{formatBytes(item.totalBytes)}</span>
                  </ListRow>
                </li>
              ))}
            </List>
          </>
        )}

        {backTo}
      </ContainerWide>
    </Main>
  );

  function openItem(item: StorageNode) {
    if (item.children.length > 0 && item.name !== 'This item itself') {
      setTrail([...trail, item.subject]);

      return;
    }

    onOpen(item.subject);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }

  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

const Intro = styled.p`
  color: ${p => p.theme.colors.textLight};
`;

const Muted = styled.span`
  color: ${p => p.theme.colors.textLight};
`;

const Swatch = styled.span<{ $files?: boolean }>`
  display: inline-block;
  width: 0.8em;
  height: 0.8em;
  border-radius: 2px;
  background: ${p => (p.$files ? '#d9822b' : '#3b6fe0')};
`;

const Crumbs = styled.nav`
  margin: 0.5rem 0;
`;

const CrumbButton = styled.button`
  padding: 0;
  border: none;
  background: none;
  color: ${p => p.theme.colors.main};
  text-decoration: underline;
  cursor: pointer;
`;

const MapBox = styled.div`
  position: relative;
  width: 100%;
  min-height: 220px;
  border-radius: 8px;
  overflow: hidden;
  background: ${p => p.theme.colors.bg1};
`;

const Tile = styled.button<{ $files: boolean }>`
  position: absolute;
  box-sizing: border-box;
  padding: 4px 6px;
  border: 1px solid ${p => p.theme.colors.bg};
  background: ${p => (p.$files ? '#d9822b' : '#3b6fe0')};
  color: #fff;
  text-align: left;
  cursor: pointer;
  overflow: hidden;

  &:hover,
  &:focus-visible {
    filter: brightness(1.12);
  }
`;

const TileLabel = styled.span`
  display: flex;
  flex-direction: column;
  font-size: 0.78rem;
  line-height: 1.25;
  overflow: hidden;

  & > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: inherit;
  }
`;

const List = styled.ol`
  list-style: none;
  margin: 1rem 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;

  li {
    position: relative;
  }
`;

const Bar = styled.span<{ $files: boolean }>`
  position: absolute;
  inset: 0 auto 0 0;
  background: ${p => (p.$files ? '#d9822b' : '#3b6fe0')};
  opacity: 0.18;
  border-radius: 4px;
`;

const ListRow = styled.div`
  position: relative;
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 1rem;
  padding: 0.25rem 0.5rem;

  button {
    padding: 0;
    border: none;
    background: none;
    color: inherit;
    text-align: left;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`;

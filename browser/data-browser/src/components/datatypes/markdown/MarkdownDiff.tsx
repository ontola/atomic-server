import { diffWordsWithSpace } from 'diff';
import type { Components } from 'react-markdown';
import { styled } from 'styled-components';

const INS_START = '\uE000';
const INS_END = '\uE001';
const DEL_START = '\uE002';
const DEL_END = '\uE003';
const NEWLINE_MARKER = '\uE004';

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * A local remark plugin that parses our custom diff markers statefully.
 * This allows markers to span across multiple markdown nodes (like bold, links, etc.)
 */
export function remarkDiff() {
  return (tree: unknown) => {
    let activeType: 'ins' | 'del' | null = null;

    const processNode = (node: any): any => {
      if (typeof node.value === 'string' && !node.children) {
        const regex = new RegExp(
          `([${INS_START}${DEL_START}${INS_END}${DEL_END}${NEWLINE_MARKER}])`,
          'g',
        );
        const parts = node.value.split(regex);
        const children: any[] = [];

        for (const part of parts) {
          if (part === INS_START) {
            activeType = 'ins';
          } else if (part === DEL_START) {
            activeType = 'del';
          } else if (part === INS_END || part === DEL_END) {
            activeType = null;
          } else if (part === NEWLINE_MARKER) {
            if (activeType) {
              children.push({
                type: activeType,
                data: {
                  hName: activeType,
                  hProperties: {
                    className: 'diff-newline',
                  },
                },
                children: [{ ...node, value: ' ' }],
              });
            }
          } else if (part) {
            const newNode = { ...node, value: part };

            if (activeType) {
              children.push({
                type: activeType,
                data: {
                  hName: activeType,
                  hProperties: {
                    className: /^\s+$/.test(part)
                      ? 'diff-whitespace'
                      : undefined,
                  },
                },
                children: [newNode],
              });
            } else {
              children.push(newNode);
            }
          }
        }

        return children;
      }

      if (node.children) {
        const newChildren: any[] = [];

        for (const child of node.children) {
          const result = processNode(child);

          if (Array.isArray(result)) {
            newChildren.push(...result);
          } else {
            newChildren.push(result);
          }
        }

        node.children = newChildren;
      }

      // If we are currently "inside" a diff, and this is a non-text node (like strong or em),
      // we don't wrap the node itself, but its content will have been wrapped by the recursive calls.
      return node;
    };

    processNode(tree);
  };
}

/**
 *  Creates a new markdown string with insertion and deletion markers for the changes between two text strings.
 *  Long text without changes will be truncated to highlight the actual changes better, unless `noTruncate` is true.
 *  Can be rendered as markdown using the remarkDiff plugin.
 */
export function createMarkdownDiff(
  text1: string,
  text2: string,
  noTruncate = false,
): string {
  const rawChanges = diffWordsWithSpace(text1, text2);
  // Merge adjacent changes of the same type to keep markdown markers together
  const changes: { added?: boolean; removed?: boolean; value: string }[] = [];

  for (const change of rawChanges) {
    const last = changes[changes.length - 1];

    if (
      last &&
      !!last.added === !!change.added &&
      !!last.removed === !!change.removed
    ) {
      last.value += change.value;
    } else {
      changes.push({ ...change });
    }
  }

  const combined = changes
    .map((change, index) => {
      let value = change.value;

      if (!change.added && !change.removed) {
        if (!noTruncate) {
          if (index === 0) {
            value = truncateStart(value);
          } else if (index === changes.length - 1) {
            value = truncateEnd(value);
          } else {
            value = truncateInnerLines(value);
          }
        }

        return value;
      }

      const start = change.added ? INS_START : DEL_START;
      const end = change.added ? INS_END : DEL_END;

      // Split by newline and wrap each non-newline part.
      // This prevents markers from spanning across block boundaries.
      return value
        .split(/(\n)/)
        .map(part => {
          if (part.length === 0) {
            return part;
          }

          if (part === '\n') {
            if (change.added) {
              return `${start}${NEWLINE_MARKER}${end}\n`;
            } else {
              return `${start}${NEWLINE_MARKER}${end}`;
            }
          }

          // We only move past block-level markers like headers or list item dashes.
          // We NO LONGER move past inline markers like bolding, because the stateful
          // plugin can handle diffs that wrap around markdown nodes.
          const match = part.match(
            /^(\s*(?:#+\s+|[-*+]\s+|\d+\.\s+)?)([\s\S]*)$/,
          );

          if (match) {
            const [, control, content] = match;

            if (content.length === 0) {
              if (/^\s+$/.test(control)) {
                return `${start}${control}${end}`;
              }

              return control;
            }

            return `${control}${start}${content}${end}`;
          }

          return `${start}${part}${end}`;
        })
        .join('');
    })
    .join('');

  return repairMarkdownDiffOutput(combined);
}

/**
 * Markdown is parsed before remarkDiff runs. If `**` sits inside our private-use
 * markers, micromark often does not treat it as an emphasis delimiter, so the
 * opening `**` never closes and the rest of the paragraph stays bold.
 *
 * Move the **first** `**…**` pair to sit outside the markers so delimiters are
 * valid. If there is more text after that pair inside the same marker span (e.g.
 * one big insertion containing `**Answered:**` + long paragraph), split into two
 * marked regions so only the label stays inside `**…**`, not the whole paragraph.
 */
function moveBoldDelimitersOutsideMarkers(text: string): string {
  let result = text;
  let prev = '';
  let guard = 0;

  while (result !== prev && guard < 50) {
    prev = result;
    result = splitFirstBoldPairAcrossMarkerBlock(result, DEL_START, DEL_END);
    result = splitFirstBoldPairAcrossMarkerBlock(result, INS_START, INS_END);
    guard++;
  }

  return result;
}

function escapeRe(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

function splitFirstBoldPairAcrossMarkerBlock(
  text: string,
  start: string,
  end: string,
): string {
  const innerRe = new RegExp(`${escapeRe(start)}([^]*?)${escapeRe(end)}`, 'g');

  return text.replace(innerRe, (match, inner) => {
    const open = inner.indexOf('**');

    if (open === -1) {
      return match;
    }

    const close = inner.indexOf('**', open + 2);

    if (close === -1) {
      return match;
    }

    const before = inner.slice(0, open);

    if (/[^\s]/.test(before)) {
      return match;
    }

    const em = inner.slice(open + 2, close);

    const after = inner.slice(close + 2);

    if (after === '') {
      return `${before}**${start}${em}${end}**`;
    }

    return `${before}**${start}${em}${end}**${start}${after}${end}`;
  });
}

/** Keeps adjacent replace hunks from gluing word characters (e.g. for+and → forand). */
function padAdjacentDiffMarkers(text: string): string {
  return text
    .replace(
      new RegExp(`(\\w)(${DEL_END})(${INS_START})(\\w)`, 'g'),
      '$1$2 $3$4',
    )
    .replace(
      new RegExp(`(\\w)(${INS_END})(${DEL_START})(\\w)`, 'g'),
      '$1$2 $3$4',
    );
}

/**
 * When word-diff wraps only the first word after `**` (e.g. `**\uE000…Answered:\uE001`)
 * and the closing `**` was merged into the following unchanged chunk, CommonMark
 * never sees a closer and treats the rest of the paragraph as bold.
 *
 * Insert the missing `**` right after the first marked block when it is still
 * short/label-like and not already followed by `**`. Do NOT append `**` at EOF —
 * that incorrectly closes emphasis at the end of the document.
 */
function insertMissingBoldCloserAfterMarkedPrefix(text: string): string {
  const markedBlock = `(?:${INS_START}[^${INS_END}]*${INS_END}|${DEL_START}[^${DEL_END}]*${DEL_END})`;

  return text.replace(
    new RegExp(`(\\*\\*)(${markedBlock})(?!\\*\\*)([ \\t\\n])`, 'g'),
    (full, open, block, ws) => {
      const inner = extractFirstMarkedInner(block);

      if (inner.includes('\n') || inner.length > 120) {
        return full;
      }

      // Long runs are usually intentional bold spans; label-style lines end with ':'.
      if (inner.length > 60 && !/:$/.test(inner.trimEnd())) {
        return full;
      }

      return `${open}${block}**${ws}`;
    },
  );
}

function extractFirstMarkedInner(block: string): string {
  if (block.startsWith(INS_START) && block.endsWith(INS_END)) {
    return block.slice(INS_START.length, -INS_END.length);
  }

  if (block.startsWith(DEL_START) && block.endsWith(DEL_END)) {
    return block.slice(DEL_START.length, -DEL_END.length);
  }

  return block;
}

function repairMarkdownDiffOutput(text: string): string {
  return insertMissingBoldCloserAfterMarkedPrefix(
    padAdjacentDiffMarkers(moveBoldDelimitersOutsideMarkers(text)),
  );
}

function truncateInnerLines(text: string): string {
  const lines = text.split('\n');

  if (lines.length > 8) {
    return [...lines.slice(0, 4), '\n...\n', ...lines.slice(-4)].join('\n');
  }

  return text;
}

function truncateStart(text: string): string {
  const lines = text.split('\n');

  if (lines.length > 5) {
    return ['...\n', ...lines.slice(-4)].join('\n');
  }

  return text;
}

function truncateEnd(text: string): string {
  const lines = text.split('\n');

  if (lines.length > 5) {
    return [...lines.slice(0, 4), '\n...\n'].join('\n');
  }

  return text;
}

const Deletion = styled.del`
  background-color: ${p => p.theme.colors.diff.removedBg};
  color: ${p => p.theme.colors.diff.removedFg};
  text-decoration: line-through;
  color: inherit;
  white-space: pre-wrap;

  &.diff-newline::before {
    content: '';
    opacity: 0.4;
  }

  &.diff-whitespace {
    min-width: 0.5em;
    display: inline-block;
  }
`;

const Insertion = styled.ins`
  background-color: ${p => p.theme.colors.diff.addedBg};
  color: ${p => p.theme.colors.diff.addedFg};
  text-decoration: none;
  color: inherit;
  white-space: pre-wrap;

  &.diff-newline::before {
    content: '';
    opacity: 0.4;
  }

  &.diff-whitespace {
    min-width: 0.5em;
    display: inline-block;
  }
`;

export const diffComponents: Partial<Components> = {
  ins: Insertion,
  del: Deletion,
};

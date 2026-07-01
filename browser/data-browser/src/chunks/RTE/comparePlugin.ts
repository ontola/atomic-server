import { Extension, type JSONContent } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { diffWords, diffArrays } from 'diff';

/** Stored baseline document; empty string means “no comparison”. */
type ComparisonContent = string | JSONContent;

export interface ComparePluginOptions {
  comparisonContent: ComparisonContent;
  /** CSS class(es) for added text and block nodes (space-separated). */
  classAdded: string;
  /** CSS class(es) for removed inline text (widget spans). */
  classRemoved: string;
  /** CSS class(es) for removed block nodes (widget elements). */
  classRemovedNode: string;
}

interface ComparePluginState {
  comparisonContent: ComparisonContent;
  options: ComparePluginOptions;
}

type DiffOp =
  | { type: 'keep'; node: JSONContent }
  | { type: 'add'; node: JSONContent }
  | { type: 'remove'; node: JSONContent }
  | { type: 'modify'; oldNode: JSONContent; newNode: JSONContent };

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    compare: {
      setComparisonContent: (content: ComparisonContent) => ReturnType;
    };
  }
}

const pluginKey = new PluginKey('comparePlugin');

const ComparePlugin = Extension.create<ComparePluginOptions>({
  name: 'compare',

  addOptions() {
    return {
      comparisonContent: '',
      classAdded: 'diff-added',
      classRemoved: 'diff-removed',
      classRemovedNode: 'diff-removed-node',
    };
  },

  addCommands() {
    return {
      setComparisonContent:
        (content: ComparisonContent) =>
        ({ state, dispatch }) => {
          const tr = state.tr.setMeta(pluginKey, {
            comparisonContent: content,
          });

          if (dispatch) dispatch(tr);

          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: pluginKey,
        state: {
          init: (): ComparePluginState => {
            return {
              comparisonContent: this.options.comparisonContent,
              options: this.options,
            };
          },
          apply(tr, pluginState: ComparePluginState): ComparePluginState {
            const meta = tr.getMeta(pluginKey) as
              | { comparisonContent?: ComparisonContent }
              | undefined;

            if (meta && meta.comparisonContent !== undefined) {
              return {
                ...pluginState,
                comparisonContent: meta.comparisonContent,
              };
            }

            return pluginState;
          },
        },
        props: {
          decorations(state) {
            const pluginState = pluginKey.getState(state);
            if (!pluginState) return null;

            const { classAdded, classRemoved, classRemovedNode } =
              pluginState.options;
            const { comparisonContent } = pluginState;
            if (!comparisonContent) return null;
            if (
              typeof comparisonContent === 'string' ||
              !comparisonContent.content
            )
              return null;

            const decos: Decoration[] = [];
            const oldContent = comparisonContent;
            const newContent = state.doc.toJSON() as JSONContent;

            function diffNodes(
              oldNodes: JSONContent[],
              newNodes: JSONContent[],
              startPos: number,
            ) {
              let pos = startPos;

              const diffResult = diffArrays(oldNodes, newNodes, {
                comparator: (a: JSONContent, b: JSONContent) =>
                  JSON.stringify(a) === JSON.stringify(b),
              });

              const ops: DiffOp[] = [];
              let removedQueue: JSONContent[] = [];
              let addedQueue: JSONContent[] = [];

              function flushQueues() {
                let rIdx = 0;

                while (rIdx < removedQueue.length) {
                  const rNode = removedQueue[rIdx];
                  // Relax the matching heuristic: if both nodes are complex blocks, or both are textblocks, pair them up.
                  const aIdx = addedQueue.findIndex(
                    aNode =>
                      aNode.type === rNode.type ||
                      (isBlockType(rNode.type) && isBlockType(aNode.type)),
                  );

                  if (aIdx !== -1) {
                    const aNode = addedQueue[aIdx];

                    for (let i = 0; i < aIdx; i++) {
                      ops.push({ type: 'add', node: addedQueue[i] });
                    }

                    ops.push({
                      type: 'modify',
                      oldNode: rNode,
                      newNode: aNode,
                    });
                    addedQueue = addedQueue.slice(aIdx + 1);
                  } else {
                    ops.push({ type: 'remove', node: rNode });
                  }

                  rIdx++;
                }

                for (const aNode of addedQueue) {
                  ops.push({ type: 'add', node: aNode });
                }

                removedQueue = [];
                addedQueue = [];
              }

              /** Uses the editor schema: block nodes are those whose spec includes the `block` group. */
              function isBlockType(typeName: string | undefined) {
                if (!typeName) return false;

                return state.schema.nodes[typeName]?.isBlock ?? false;
              }

              for (const part of diffResult) {
                if (part.added) {
                  addedQueue.push(...(part.value as JSONContent[]));
                } else if (part.removed) {
                  removedQueue.push(...(part.value as JSONContent[]));
                } else {
                  flushQueues();

                  for (const node of part.value as JSONContent[]) {
                    ops.push({ type: 'keep', node });
                  }
                }
              }

              flushQueues();

              for (const op of ops) {
                if (op.type === 'keep') {
                  const nodeSize = state.doc.nodeAt(pos)?.nodeSize || 0;
                  pos += nodeSize;
                } else if (op.type === 'add') {
                  const nodeSize = state.doc.nodeAt(pos)?.nodeSize || 0;

                  if (nodeSize > 0) {
                    decos.push(
                      Decoration.node(pos, pos + nodeSize, {
                        class: classAdded,
                      }),
                    );
                  }

                  pos += nodeSize;
                } else if (op.type === 'remove') {
                  decos.push(
                    Decoration.widget(pos, () =>
                      createRemovedNode(op.node, classRemovedNode),
                    ),
                  );
                } else if (op.type === 'modify') {
                  const { oldNode, newNode } = op;
                  const pmNode = state.doc.nodeAt(pos);
                  const nodeSize = pmNode?.nodeSize || 0;

                  if (pmNode && !pmNode.isTextblock && !pmNode.isLeaf) {
                    const oldChildren = oldNode.content || [];
                    const newChildren = newNode.content || [];
                    diffNodes(oldChildren, newChildren, pos + 1);
                  } else {
                    const oldText = nodeToText(oldNode);
                    const newText = nodeToText(newNode);

                    if (oldText !== newText) {
                      const diff = diffWords(oldText, newText);
                      let nodePos = pos + 1; // +1 to skip the node start tag
                      const maxNodePos = pos + Math.max(0, nodeSize - 1);

                      diff.forEach(part => {
                        const length = part.value.length;

                        if (length > 0) {
                          if (part.added) {
                            const from = Math.min(nodePos, maxNodePos);
                            const to = Math.min(nodePos + length, maxNodePos);

                            if (from < to) {
                              decos.push(
                                Decoration.inline(from, to, {
                                  class: classAdded,
                                }),
                              );
                            }

                            nodePos += length;
                          } else if (part.removed) {
                            const widgetPos = Math.min(nodePos, maxNodePos);
                            decos.push(
                              Decoration.widget(widgetPos, () =>
                                createRemovedSpan(part.value, classRemoved),
                              ),
                            );
                          } else {
                            nodePos += length;
                          }
                        }
                      });
                    }
                  }

                  pos += nodeSize;
                }
              }
            }

            diffNodes(oldContent.content || [], newContent.content || [], 0);

            if (decos.length === 0) {
              return null;
            }

            decos.sort((a, b) => a.from - b.from);

            return DecorationSet.create(state.doc, decos);
          },
        },
      }),
    ];
  },
});

function nodeToText(node: JSONContent): string {
  if (node.type === 'text') {
    return node.text || '';
  } else if (node.content) {
    return node.content.map(nodeToText).join('');
  }

  return ' '; // Return a single space for non-text leaf nodes to keep position tracking somewhat aligned
}

function readableNodeToText(node: JSONContent): string {
  if (node.type === 'text') {
    return node.text || '';
  } else if (node.type === 'paragraph') {
    if (!node.content) return ' \n';

    return node.content?.map(readableNodeToText).join('') + '\n';
  } else if (node.type === 'image') {
    return `[Image: ${node.attrs?.alt || 'No alt text'} (${node.attrs?.src || ''})]\n`;
  } else if (node.content) {
    return node.content.map(readableNodeToText).join('');
  }

  return '';
}

function createRemovedSpan(text: string, className: string) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;

  return span;
}

function createRemovedNode(node: JSONContent, className: string) {
  const div = document.createElement('div');
  div.className = className;
  div.textContent = readableNodeToText(node);

  return div;
}

export { ComparePlugin };

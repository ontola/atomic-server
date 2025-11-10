import { Node } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { unknownSubject, type Store } from '@tomic/react';
import {
  ResourceComponent,
  ResourceInlineComponent,
} from './ResourceComponent';
import styles from './ResourceNode.module.css';

interface ResourceNodeOptions {
  store?: Store;
}

export interface SetResourceNodeOptions {
  subject: string;
}

const TYPES = {
  BLOCK: 'resource-block',
  INLINE: 'resource-inline',
} as const;

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    resource: {
      /**
       * Add a resource view to the document.
       * @param options Object containing the subject.
       */
      setResource: (options: SetResourceNodeOptions) => ReturnType;
    };
    resourceInline: {
      setResourceInline: (options: SetResourceNodeOptions) => ReturnType;
    };
  }
}

export const ResourceNode = Node.create<ResourceNodeOptions>({
  name: 'atomic-data-resource',
  group: 'block',
  atom: true,

  addOptions() {
    return {
      store: undefined,
    };
  },

  parseHTML() {
    return [
      {
        tag: `a[data-type="${TYPES.BLOCK}"]`,
        getAttrs: node => {
          const dataType = node.getAttribute('data-type');

          if (dataType !== TYPES.BLOCK) {
            return false; // Not a resource-block, ignore
          }

          return {
            subject: node.getAttribute('href'), // Extract the attribute
          };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    const title =
      this.options.store?.getResourceLoading(HTMLAttributes['subject']).title ??
      '';

    return [
      'a',
      {
        'data-type': TYPES.BLOCK,
        href: HTMLAttributes['subject'],
      },
      title,
    ];
  },

  addCommands() {
    return {
      setResource:
        options =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: options,
          });
        },
    };
  },

  addAttributes() {
    return {
      subject: {
        default: unknownSubject,
      },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(ResourceComponent, {
      className: styles.nodeRenderer,
      contentDOMElementTag: 'div',
      ignoreMutation: ({ mutation }) => {
        return (
          mutation.type === 'attributes' &&
          mutation.attributeName === 'aria-hidden'
        );
      },
    });
  },
});

export const ResourceNodeInline = ResourceNode.extend<ResourceNodeOptions>({
  name: 'atomic-data-resource-inline',
  group: 'inline',
  inline: true,
  parseHTML() {
    return [
      {
        tag: `a[data-type="${TYPES.INLINE}"]`,
        getAttrs: node => {
          const dataType = node.getAttribute('data-type');

          if (dataType !== TYPES.INLINE) {
            return false; // Not a resource-block, ignore
          }

          return {
            'data-type': TYPES.INLINE,
            subject: node.getAttribute('href'),
          };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    const title =
      this.options.store?.getResourceLoading(HTMLAttributes['subject']).title ??
      '';

    return [
      'a',
      {
        'data-type': TYPES.INLINE,
        href: HTMLAttributes['subject'],
      },
      title,
    ];
  },

  addCommands() {
    return {
      setResourceInline:
        options =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: options,
          });
        },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(ResourceInlineComponent);
  },
});

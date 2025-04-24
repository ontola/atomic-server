import { mergeAttributes, Node } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';
import { unknownSubject } from '@tomic/react';
import {
  ResourceComponent,
  ResourceInlineComponent,
} from './ResourceComponent';

export interface ResourceNodeOptions {
  subject: string;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    resource: {
      /**
       * Add a resource view to the document.
       * @param options Object containing the subject.
       */
      setResource: (options: ResourceNodeOptions) => ReturnType;
    };
    resourceInline: {
      setResourceInline: (options: ResourceNodeOptions) => ReturnType;
    };
  }
}

export const ResourceNode = Node.create({
  name: 'atomic-data-resource',
  group: 'block',

  parseHTML() {
    return [
      {
        tag: 'a',
        getAttrs: node => {
          const dataType = node.getAttribute('data-type');

          if (dataType !== 'resource-block') {
            return false; // Not a resource-block, ignore
          }

          return {
            subject: node.getAttribute('data-subject'), // Extract the attribute
          };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      'a',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'resource-block',
        'data-subject': node.attrs['subject'],
      }),
    ];
  },

  addOptions() {
    return {
      subject: unknownSubject,
    };
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
        parseHTML: e => e.getAttribute('data-subject'),
      },
    };
  },
  addNodeView() {
    if (this.options.inline) {
      return ReactNodeViewRenderer(ResourceInlineComponent);
    }

    return ReactNodeViewRenderer(ResourceComponent);
  },
});

export const ResourceNodeInline = ResourceNode.extend<ResourceNodeOptions>({
  name: 'atomic-data-resource-inline',
  group: 'inline',
  inline: true,
  parseHTML() {
    return [
      {
        tag: 'a',
        getAttrs: node => {
          const dataType = node.getAttribute('data-type');

          if (dataType !== 'resource-inline') {
            return false; // Not a resource-block, ignore
          }

          return {
            'data-type': 'resource-inline',
            subject: node.getAttribute('data-subject'),
          };
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      'a',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'resource-inline',
        'data-subject': node.attrs['subject'],
      }),
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

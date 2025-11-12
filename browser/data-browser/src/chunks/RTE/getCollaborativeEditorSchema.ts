import { getSchema, type Extensions } from '@tiptap/core';
import { Link } from '@tiptap/extension-link';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import TextAlign from '@tiptap/extension-text-align';
import {
  TextStyle,
  Color,
  BackgroundColor,
} from '@tiptap/extension-text-style';
import Typography from '@tiptap/extension-typography';
import StarterKit from '@tiptap/starter-kit';
import { type Store } from '@tomic/react';
import {
  ResourceNode,
  ResourceNodeInline,
} from './ResourceExtension/ResourceNode';
import Image from '@tiptap/extension-image';
import type { Schema } from '@tiptap/pm/model';

export function getCollaborativeEditorSchema(store: Store): {
  schema: Schema;
  extensions: Extensions;
} {
  const extensions = [
    StarterKit.configure({
      undoRedo: false,
      link: false,
    }),
    Typography,
    Link.extend({
      parseHTML: () => [
        {
          tag: 'a[href]',
          getAttrs: node => {
            // Links with a data-type are custom nodes that should be ignored by the link extension
            if (node.getAttribute('data-type')) {
              return false;
            }

            // Default link parsing
            return {
              href: node.getAttribute('href'),
              target: node.getAttribute('target'),
            };
          },
        },
      ],
    }).configure({
      autolink: true,
      openOnClick: true,
      protocols: [
        'http',
        'https',
        'mailto',
        {
          scheme: 'tel',
          optionalSlashes: true,
        },
      ],
      HTMLAttributes: {
        class: 'tiptap-link',
        rel: 'noopener noreferrer',
        target: '_blank',
      },
    }),
    Image.configure({
      HTMLAttributes: {
        class: 'tiptap-image',
      },
    }),
    ResourceNode.configure({
      store,
    }),
    ResourceNodeInline.configure({
      store,
    }),
    TextAlign.configure({
      types: ['heading', 'paragraph'],
    }),
    TaskList,
    TaskItem.configure({
      nested: true,
    }),
    TextStyle,
    Color,
    BackgroundColor,
  ];

  return { schema: getSchema(extensions), extensions };
}

import toast from 'react-hot-toast';
import { core } from '@tomic/react';
import {
  FaArrowUpRightFromSquare,
  FaClock,
  FaCode,
  FaDownload,
  FaMagnifyingGlass,
  FaMessage,
  FaPencil,
  FaPlus,
  FaRegStar,
  FaShare,
  FaStar,
  FaTrash,
  FaTurnUp,
} from 'react-icons/fa6';
import {
  constructOpenURL,
  dataURL,
  editURL,
  historyURL,
  importerURL,
  shareURL,
} from '../helpers/navigation';
import { paths } from '../routes/paths';
import { shortcuts } from '../components/HotKeyWrapper';
import { ResourceInline } from '../views/ResourceInline';
import { ResourceUsage } from '../components/ResourceUsage';
import type { ActionContext, ActionDefinition } from './types';

const getParent = (ctx: ActionContext): string | undefined =>
  ctx.resource.get(core.properties.parent) as string | undefined;

/**
 * All actions on a resource, in menu order. Ids keep the historical
 * `ContextMenuOptions` values so `showOnly` call sites and `menu-item-<id>`
 * test ids stay valid.
 */
export const resourceActions: ActionDefinition[] = [
  {
    id: 'view',
    scope: 'resource',
    section: 'view',
    label: () => 'Normal View',
    helper: () => 'Open the regular, default View.',
    keywords: ['show', 'open'],
    disabled: ctx => ctx.pathname.startsWith(paths.show),
    run: ctx => ctx.navigate(constructOpenURL(ctx.subject)),
  },
  {
    id: 'data',
    scope: 'resource',
    section: 'view',
    label: () => 'Data View',
    helper: () => 'View the resource and its properties in the Data View.',
    keywords: ['json', 'raw', 'properties'],
    shortcut: shortcuts.data,
    disabled: ctx => ctx.pathname.startsWith(paths.data),
    run: ctx => ctx.navigate(dataURL(ctx.subject)),
  },
  {
    id: 'favorite',
    scope: 'resource',
    section: 'action',
    label: ctx =>
      ctx.isFavorite ? 'Remove from favorites' : 'Add to favorites',
    helper: () => 'Toggle whether this resource appears in your Favorites.',
    keywords: ['star', 'bookmark', 'pin'],
    icon: ctx => (ctx.isFavorite ? <FaStar /> : <FaRegStar />),
    run: ctx =>
      ctx.isFavorite
        ? ctx.removeFavorite(ctx.subject)
        : ctx.addFavorite(ctx.subject),
  },
  {
    id: 'open',
    scope: 'resource',
    section: 'action',
    label: () => 'Open',
    helper: () => 'Open the resource',
    icon: () => <FaArrowUpRightFromSquare />,
    available: ctx => !!ctx.external,
    run: ctx => ctx.navigate(constructOpenURL(ctx.subject)),
  },
  {
    id: 'edit',
    scope: 'resource',
    section: 'action',
    label: () => 'Edit',
    helper: () => 'Open the edit form.',
    keywords: ['change', 'modify', 'form'],
    icon: () => <FaPencil />,
    shortcut: shortcuts.edit,
    available: ctx => ctx.canWrite,
    run: ctx => ctx.navigate(editURL(ctx.subject)),
  },
  {
    id: 'newChild',
    scope: 'resource',
    section: 'action',
    label: () => 'Add child',
    helper: () => 'Create a new resource under this resource.',
    keywords: ['new', 'create'],
    icon: () => <FaPlus />,
    available: ctx => ctx.canWrite,
    run: ctx => ctx.addChild(),
  },
  {
    id: 'useInCode',
    scope: 'resource',
    section: 'action',
    label: () => 'Use in code',
    helper: () =>
      'Usage instructions for how to fetch and use the resource in your code.',
    keywords: ['developer', 'snippet', 'api'],
    icon: () => <FaCode />,
    available: ctx => !!ctx.showCodeUsageDialog,
    run: ctx => ctx.showCodeUsageDialog?.(),
  },
  {
    id: 'addToChat',
    scope: 'resource',
    section: 'action',
    label: () => 'Add to chat',
    helper: () => 'Add the resource as context to the AI sidebar',
    keywords: ['ai', 'assistant', 'context'],
    icon: () => <FaMessage />,
    run: ctx => ctx.addToChat(),
  },
  {
    id: 'scope',
    scope: 'resource',
    section: 'action',
    label: () => 'Search children',
    helper: () => 'Scope search to resource',
    keywords: ['find', 'filter'],
    icon: () => <FaMagnifyingGlass />,
    run: ctx => ctx.enableScope(),
  },
  {
    id: 'share',
    scope: 'resource',
    section: 'action',
    label: () => 'Permissions & Invites',
    helper: () => 'Edit permissions and create invites.',
    keywords: ['share', 'access', 'rights', 'invite'],
    icon: () => <FaShare />,
    run: ctx => ctx.navigate(shareURL(ctx.subject)),
  },
  {
    id: 'history',
    scope: 'resource',
    section: 'action',
    label: () => 'History',
    helper: () => 'Show the history of this resource',
    keywords: ['versions', 'changes', 'undo'],
    icon: () => <FaClock />,
    run: ctx => ctx.navigate(historyURL(ctx.subject)),
  },
  {
    id: 'parent',
    scope: 'resource',
    section: 'action',
    label: () => 'Go to parent',
    helper: () => 'Open the parent of this resource.',
    keywords: ['up', 'back', 'enclosing', 'folder'],
    icon: () => <FaTurnUp />,
    shortcut: shortcuts.parent,
    available: ctx => !!getParent(ctx),
    run: ctx => {
      const parent = getParent(ctx);

      if (parent) {
        ctx.navigate(constructOpenURL(parent));
      }
    },
  },
  {
    id: 'import',
    scope: 'resource',
    section: 'action',
    label: () => 'Import',
    helper: () => 'Import Atomic Data to this resource',
    keywords: ['upload', 'json'],
    icon: () => <FaDownload />,
    available: ctx => ctx.canWrite,
    run: ctx => ctx.navigate(importerURL(ctx.subject)),
  },
  {
    id: 'delete',
    scope: 'resource',
    section: 'action',
    label: () => 'Delete',
    helper: () => 'Delete this resource.',
    keywords: ['remove', 'destroy', 'trash'],
    icon: () => <FaTrash />,
    available: ctx => ctx.canWrite,
    danger: true,
    dangerLabel: () => 'Confirm Delete',
    confirmation: {
      title: () => 'Delete resource',
      confirmLabel: () => 'Delete',
      body: ctx => (
        <>
          <p>
            Are you sure you want to delete{' '}
            <ResourceInline subject={ctx.subject} />
          </p>
          <ResourceUsage resource={ctx.resource} />
        </>
      ),
    },
    run: async ctx => {
      const parent = getParent(ctx);

      try {
        await ctx.resource.destroy();
        ctx.onAfterDelete?.();
        toast.success('Resource deleted!');

        if (ctx.currentSubject === ctx.subject) {
          ctx.navigate(parent ? constructOpenURL(parent) : '/');
        }
      } catch (error) {
        toast.error((error as Error).message);
      }
    },
  },
];

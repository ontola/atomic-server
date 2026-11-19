import type { ComponentType, ReactNode } from 'react';
import {
  FaPlus,
  FaFont,
  FaHashtag,
  FaCalendar,
  FaCheck,
  FaCircleChevronDown,
  FaFile,
  FaCode,
  FaLanguage,
  FaLink,
  FaCalculator,
  FaBolt,
} from 'react-icons/fa6';
import { DefaultPropertyMenu } from './PropertyMenu.js';

export type TableNewColumnKind =
  | 'text'
  | 'number'
  | 'date'
  | 'checkbox'
  | 'select'
  | 'file'
  | 'json'
  | 'localizedText'
  | 'relation'
  | 'computed'
  | 'action'
  | 'external';
export interface TableNewColumnAction {
  run?: () => void;
  disabled?: boolean;
  reason?: string;
}
export interface TableNewColumnItem {
  key: TableNewColumnKind;
  label: string;
  icon: ReactNode;
  disabled: boolean;
  reason?: string;
  run: () => void;
}
export interface TableNewColumnMenuPresentation {
  label: string;
  items: readonly TableNewColumnItem[];
  disabled: boolean;
}
export interface TableNewColumnMenuProps {
  actions: Partial<Record<TableNewColumnKind, TableNewColumnAction>>;
  disabled?: boolean;
  Menu?: ComponentType<TableNewColumnMenuPresentation>;
  messages?: Partial<Record<TableNewColumnKind | 'label', string>>;
  icons?: Partial<Record<TableNewColumnKind, ReactNode>>;
}
const kinds: TableNewColumnKind[] = [
  'text',
  'number',
  'date',
  'checkbox',
  'select',
  'file',
  'json',
  'localizedText',
  'relation',
  'computed',
  'action',
  'external',
];
const labels = {
  label: 'Add column',
  text: 'Text',
  number: 'Number',
  date: 'Date',
  checkbox: 'Checkbox',
  select: 'Select',
  file: 'File',
  json: 'JSON',
  localizedText: 'Localized Text',
  relation: 'Relation',
  computed: 'Computed',
  action: 'Action',
  external: 'External Property',
};
const defaultIcons: Record<TableNewColumnKind, ReactNode> = {
  text: <FaFont />,
  number: <FaHashtag />,
  date: <FaCalendar />,
  checkbox: <FaCheck />,
  select: <FaCircleChevronDown />,
  file: <FaFile />,
  json: <FaCode />,
  localizedText: <FaLanguage />,
  relation: <FaLink />,
  computed: <FaCalculator />,
  action: <FaBolt />,
  external: <FaHashtag />,
};

/** Shared add-column choices; storage adapters explicitly supply each capability. */
export function TableNewColumnMenu({
  actions,
  disabled = false,
  Menu = DefaultNewColumnMenu,
  messages,
  icons,
}: TableNewColumnMenuProps) {
  const text = { ...labels, ...messages };
  const items = kinds.map(key => {
    const action = actions[key];
    const unavailable = disabled || !action?.run || !!action.disabled;

    return {
      key,
      label: text[key],
      icon: icons?.[key] ?? defaultIcons[key],
      disabled: unavailable,
      reason: action?.reason,
      run: () => {
        if (!unavailable) action?.run?.();
      },
    };
  });

  return (
    <Menu
      label={text.label}
      items={items}
      disabled={disabled || items.every(item => item.disabled)}
    />
  );
}

const ignoreClose = () => {};

function DefaultNewColumnMenu(props: TableNewColumnMenuPresentation) {
  return (
    <DefaultPropertyMenu
      {...props}
      triggerIcon={<FaPlus />}
      onContextClose={ignoreClose}
    />
  );
}

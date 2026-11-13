import { IconButton } from '../IconButton/IconButton';
import { buildDefaultTrigger as sharedBuildDefaultTrigger } from '@tomic/ui/components/Dropdown/DefaultTrigger';
import type { DropdownTriggerComponent } from './DropdownTrigger';

/** Preserve translated fallback text in the host. */
export const buildDefaultTrigger = (
  icon: React.ReactNode,
  title: string | (() => string) = () => 'Open menu',
  ButtonComp: typeof IconButton = IconButton,
): DropdownTriggerComponent =>
  sharedBuildDefaultTrigger(icon, title, ButtonComp);

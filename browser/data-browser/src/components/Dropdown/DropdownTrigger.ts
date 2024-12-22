export interface DropdownTriggerProps {
  onClick: (event: React.MouseEvent) => void;
  menuId: string;
  isActive: boolean;
  ref: React.Ref<HTMLButtonElement | null>;
  id: string;
}

export type DropdownTriggerComponent = React.FC<DropdownTriggerProps>;

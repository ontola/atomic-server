import { FC, PropsWithChildren } from 'react';
import * as RadixTabs from '@radix-ui/react-tabs';
import { styled } from 'styled-components';
import { transition } from '../helpers/transition';

type TabItem = {
  label: string;
  value: string;
  disabled?: boolean;
};

interface TabsProps {
  tabs: TabItem[];
  rounded?: boolean;
  className?: string;
  label: string;
  defaultValue?: string;
}

export const TAB_PANEL_HAS_ERROR_CLASS = 'tab-panel-has-error';

export function Tabs({
  children,
  tabs,
  label,
  className,
  defaultValue,
  rounded,
}: PropsWithChildren<TabsProps>) {
  return (
    <StyledTabsRoot
      defaultValue={defaultValue ?? tabs[0].value}
      className={className}
    >
      <TabList aria-label={label}>
        {tabs.map(tab => (
          <TabButton
            key={tab.value}
            value={tab.value}
            className={rounded ? 'rounded-tab' : ''}
            disabled={tab.disabled}
          >
            {tab.label}
          </TabButton>
        ))}
      </TabList>
      {children}
    </StyledTabsRoot>
  );
}

interface TabPanelProps {
  value: string;
  className?: string;
}

export const TabPanel: FC<PropsWithChildren<TabPanelProps>> = ({
  value,
  className,
  children,
}) => {
  return (
    <RadixTabs.Content className={className} value={value}>
      {children}
    </RadixTabs.Content>
  );
};

Tabs.Panel = TabPanel;

const TabList = styled(RadixTabs.List)`
  display: flex;
  justify-content: space-evenly;
  margin-bottom: var(--space-3);
`;

const TabButton = styled(RadixTabs.Trigger)`
  --tab-active-color: var(--color-accent);
  background: none;
  border: none;
  color: var(--color-text);
  border-bottom: 1px solid var(--color-border);
  padding: 1rem;
  flex: 1;
  ${transition('background', 'border-color', 'box-shadow')}
  cursor: pointer;
  &:hover,
  &:focus-visible {
    outline: none;
    background: var(--color-bg-subtle);
  }

  &[data-state='active'] {
    border-color: var(--tab-active-color);
    // We use a box-shadow for one half of the border to avoid minor layout shift.
    box-shadow: inset 0 -1px 0 0 var(--tab-active-color);
  }

  &.${TAB_PANEL_HAS_ERROR_CLASS} {
    --tab-active-color: var(--color-alert);
  }

  &.rounded-tab:first-child {
    border-top-left-radius: var(--radius-md);
  }

  &.rounded-tab:last-child {
    border-top-right-radius: var(--radius-md);
  }
`;

const StyledTabsRoot = styled(RadixTabs.Root)`
  &:has(*.${TAB_PANEL_HAS_ERROR_CLASS}) {
    & ${TabButton} {
      --tab-active-color: var(--color-alert);
    }
  }
`;

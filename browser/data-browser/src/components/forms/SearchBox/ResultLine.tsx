import {
  core,
  dataBrowser,
  useResource,
  useString,
  type Resource,
} from '@tomic/react';
import React, { useEffect, useRef, type JSX } from 'react';
import { styled, css } from 'styled-components';
import { dataTypeIconMap, getIconForClass } from '../../../helpers/iconMap';
import { FaAtom } from 'react-icons/fa6';
import { Row } from '../../Row';

interface ResultLineProps {
  selected: boolean;
  onMouseOver: () => void;
  onClick: () => void;
}

interface ResourceResultLineProps extends ResultLineProps {
  subject: string;
}

export function ResultLine({
  selected,
  children,
  onMouseOver,
  onClick,
}: React.PropsWithChildren<ResultLineProps>): JSX.Element {
  const ref = useRef<HTMLLIElement>(null);
  // We need to track mouse hover state but we don't want to re-render the component on every mouse move.
  const hasMouseHover = useRef(false);

  useEffect(() => {
    if (selected && !hasMouseHover.current) {
      ref.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [selected, hasMouseHover]);

  return (
    <ListItem
      selected={selected}
      ref={ref}
      tabIndex={-1}
      onMouseMove={() => {
        hasMouseHover.current = true;
        onMouseOver();
      }}
      onMouseLeave={() => (hasMouseHover.current = false)}
      onClick={onClick}
    >
      {children}
    </ListItem>
  );
}

export function ResourceResultLine({
  subject,
  ...props
}: ResourceResultLineProps): JSX.Element {
  const resource = useResource(subject);
  const [description] = useString(resource, core.properties.description);

  return (
    <ResultLine {...props}>
      <Row gap='1ch' center>
        <Icon resource={resource} />
        <Name>{resource.title}</Name>
      </Row>
      {description && (
        <Description>
          {description.slice(0, 70).trim()}
          {description.length > 70 ? '...' : ''}
        </Description>
      )}
    </ResultLine>
  );
}

type IconProps = {
  resource: Resource;
};

function Icon({ resource }: IconProps): React.ReactElement {
  let IconComp = getIconForClass(resource.getClasses()[0] ?? '');

  if (resource.hasClasses(dataBrowser.classes.tag)) {
    const emoji = resource.get(dataBrowser.properties.emoji);

    return emoji ? <span>{emoji}</span> : <IconComp />;
  } else if (resource.hasClasses(core.classes.property)) {
    IconComp =
      dataTypeIconMap.get(resource.get(core.properties.datatype)) ?? FaAtom;
  }

  return <IconComp />;
}

const Description = styled.span`
  white-space: nowrap;
  color: ${({ theme }) => theme.colors.textLight};
  grid-column: 2/2;
  overflow: hidden;
  text-overflow: ellipsis;
`;

export const ListItem = styled.li<{ selected: boolean; gridColumn?: string }>`
  --list-item-bg: none;
  --list-item-color: currentColor;
  --list-item-svg-color: ${({ theme }) => theme.colors.textLight};

  background-color: var(--list-item-bg);
  color: var(--list-item-color);
  grid-column: 1/3;
  padding: 0.5rem;
  list-style: none;
  margin: 0;
  padding-left: ${({ theme }) => theme.size()};
  width: 100cqw;
  white-space: nowrap;
  display: grid;
  grid-template-columns: subgrid;
  grid-template-rows: 1fr;

  cursor: pointer;
  &:has(+ div) {
    padding-bottom: 1rem;
  }

  div + & {
    padding-top: 1rem;
  }

  svg {
    color: var(--list-item-svg-color);
    min-width: 1rem;
    height: 1rem;
  }

  ${({ selected, theme }) =>
    selected &&
    css`
      --list-item-bg: ${theme.colors.mainSelectedBg};
      --list-item-color: ${theme.colors.mainSelectedFg};
      --list-item-svg-color: var(--list-item-color);

      @media (prefers-contrast: more) {
        --list-item-bg: ${theme.darkMode ? 'white' : 'black'};
        --list-item-color: ${theme.darkMode ? 'black' : 'white'};
      }
    `}

  @container (max-width: 520px) {
    grid-column: 1/2;
  }
`;

const Name = styled.span`
  overflow: hidden;
  text-overflow: ellipsis;
`;

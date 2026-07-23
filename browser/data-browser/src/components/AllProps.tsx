import { Resource, useResource, type Core } from '@tomic/react';

import { styled, css } from 'styled-components';
import PropVal from './PropVal';
import { ALL_PROPS_CONTAINER } from '../helpers/containers';
import { isNeverEditableProp } from '../helpers/hiddenProperties';

import type { JSX } from 'react';

type Props = {
  resource: Resource;
  /** A list of property subjects (URLs) that need not be rendered */
  except?: string[];
  /** If set to true, adds a button which opens up a form for each property */
  editable?: boolean;
  /**
   * Render the properties in the left column, and the Values in the right one,
   * but only on large screens.
   */
  columns?: boolean;
  basic?: boolean;
};

/** Lists all PropVals for some resource. Optionally ignores a bunch of subjects */
function AllProps({ resource, except = [], editable, columns, basic }: Props) {
  const props = useSortedProps(resource, except, !!editable);

  if (!props || props.length === 0) {
    return null;
  }

  return (
    <AllPropsWrapper basic={basic}>
      {props.map(
        (prop): JSX.Element => (
          <StyledPropVal
            columns={columns}
            key={prop}
            basic={basic}
            propertyURL={prop}
            resource={resource}
            editable={!!editable}
          />
        ),
      )}
    </AllPropsWrapper>
  );
}

/**
 * The property subjects to render, in the class's declared order. When
 * `editable`, also includes the class's `requires` + `recommends` properties
 * that the resource hasn't set yet — so they show up as empty rows the user can
 * fill in, rather than being invisible until they already have a value.
 */
function useSortedProps(
  resource: Resource,
  exept: string[],
  editable: boolean,
): string[] {
  const classResource = useResource<Core.Class>(resource.getClasses()[0]);
  const classProps = [
    ...(classResource.props.requires ?? []),
    ...(classResource.props.recommends ?? []),
  ];

  const present = resource.getEntries().map(([prop]) => prop);
  const presentSet = new Set(present);

  const missing = editable
    ? classProps.filter(prop => !presentSet.has(prop))
    : [];

  const all = [...present, ...missing];

  all.sort((a, b) => {
    const pA = classProps.indexOf(a);
    const pB = classProps.indexOf(b);

    if (pA === -1) {
      return pB === -1 ? 0 : 1;
    }

    if (pB === -1) {
      return -1;
    }

    return pA - pB;
  });

  return all.filter(
    prop => !exept.includes(prop) && !isNeverEditableProp(prop),
  );
}

const AllPropsWrapper = styled.div<{ basic: boolean | undefined }>`
  container: ${ALL_PROPS_CONTAINER} / inline-size;

  display: flex;
  flex-direction: column;
  border-radius: ${p => p.theme.radius};
  background-color: ${p => (p.basic ? 'transparent' : p.theme.colors.bg)};
  border: ${p => (p.basic ? 'none' : `1px solid ${p.theme.colors.bg2}`)};
`;

const StyledPropVal = styled(PropVal)<{ basic: boolean | undefined }>`
  ${p =>
    !p.basic &&
    css`
      padding: 0.5rem;
      border-top: solid 1px ${p.theme.colors.bg1};

      &:nth-child(1) {
        border-top-left-radius: ${p.theme.radius};
        border-top: none;
        border-top-right-radius: ${p.theme.radius};
      }
    `}
`;

export default AllProps;

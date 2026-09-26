import {
  core,
  useProperty,
  useResource,
  useString,
  truncateUrl,
  Resource,
} from '@tomic/react';
import { useId } from 'react';
import { FaArrowUpRightFromSquare } from 'react-icons/fa6';

import { styled } from 'styled-components';
import { AtomicLink } from './AtomicLink';
import { columnLabel } from '@chunks/TablePage/helpers/columnLabel';
import { constructOpenURL } from '@helpers/navigation';
import { ErrorLook } from './ErrorLook';
import { ValueForm } from './forms/ValueForm';
import ValueComp from './ValueComp';
import { ALL_PROPS_CONTAINER } from '../helpers/containers';
import { LoaderInline } from './Loader';

import type { JSX } from 'react';
import { JSON_RENDERER_CLASS } from './datatypes/JSON';

type Props = {
  propertyURL: string;
  resource: Resource;
  editable: boolean;
  // If set to true, will render the properties in a left column, and the Values in the right one, but only on large screens.
  columns?: boolean;
  className?: string;
  /**
   * Label the value with the property's name ("Due date") instead of its
   * shortname (`due-date`), as a form label rather than a link. For places
   * where leaving the page is not what a click on a label should do, like the
   * row dialog over a table. The property opens in a new tab from a separate
   * icon, and the shortname is in the label's tooltip.
   */
  labelByName?: boolean;
};

/**
 * A single Property / Value renderer that shows a label on the left, and the
 * value on the right. The value is editable.
 */
function PropVal({
  propertyURL,
  resource,
  editable,
  columns,
  className,
  labelByName,
}: Props): JSX.Element {
  const property = useProperty(propertyURL);
  const propertyResource = useResource(propertyURL);
  // The property's own name, not its title: see `columnLabel`.
  const [name] = useString(propertyResource, core.properties.name);
  const truncated = truncateUrl(propertyURL, 10, true);
  const inputId = useId();

  if (property.loading || resource.loading) {
    return (
      <PropValRow columns={columns}>
        <StyledLoader title={`Loading ${truncated}`} />
      </PropValRow>
    );
  }

  if (property.error) {
    return (
      <PropValRow columns={columns}>
        <PropertyLabel title={propertyURL + ' could not be loaded'}>
          <AtomicLink subject={propertyURL}>
            <ErrorLook>{truncated}</ErrorLook>
          </AtomicLink>
        </PropertyLabel>
        <code>{JSON.stringify(resource.get(propertyURL))}</code>
      </PropValRow>
    );
  }

  const shortname = property.shortname || truncated;
  const label = labelByName ? columnLabel(name, shortname) : shortname;

  return (
    <PropValRow columns={columns} className={className}>
      {labelByName ? (
        <LabelRow>
          <PropertyLabel
            as='label'
            htmlFor={inputId}
            title={
              property.description
                ? `${shortname}: ${property.description}`
                : shortname
            }
          >
            {label}
          </PropertyLabel>
          <OpenPropertyLink
            href={constructOpenURL(propertyURL)}
            target='_blank'
            rel='noopener noreferrer'
            aria-label={`Open ${label} in a new tab`}
            title={`Open ${label} in a new tab`}
          >
            <FaArrowUpRightFromSquare aria-hidden />
          </OpenPropertyLink>
        </LabelRow>
      ) : (
        <AtomicLink subject={propertyURL}>
          <PropertyLabel title={property.description}>{label}</PropertyLabel>
        </AtomicLink>
      )}
      {editable ? (
        <ValueForm
          resource={resource}
          propertyURL={propertyURL}
          inputId={inputId}
        />
      ) : (
        <ValueComp
          datatype={property.datatype}
          value={resource.get(propertyURL)}
        />
      )}
    </PropValRow>
  );
}

export default PropVal;

export const PropValRow = styled.div<PropValRowProps>`
  word-break: break-word;
  display: grid;
  grid-template-columns: 1fr;
  grid-template-rows: auto 1fr;

  @container ${ALL_PROPS_CONTAINER} (min-width: 500px) {
    &:has(.${JSON_RENDERER_CLASS}) {
      grid-template-columns: 1fr;
      gap: 0.5rem;
    }

    grid-template-columns: 23ch auto;
    grid-template-rows: 1fr;
  }
`;

export const PropertyLabel = styled.span`
  font-weight: bold;
`;

const LabelRow = styled.span`
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
  color: ${p => p.theme.colors.main};
`;

const OpenPropertyLink = styled.a`
  color: ${p => p.theme.colors.textLight};
  font-size: 0.75em;
  line-height: 1;

  &:hover,
  &:focus-visible {
    color: ${p => p.theme.colors.main};
  }
`;

const StyledLoader = styled(LoaderInline)`
  grid-column: 1 / 3;
  margin-inline: 1rem;
  margin-block: 0.5rem;
  width: calc(100% - 2rem);
`;

interface PropValRowProps {
  columns?: boolean;
}

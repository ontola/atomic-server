import Markdown from '@components/datatypes/Markdown';
import { createMarkdownDiff } from '@components/datatypes/markdown/MarkdownDiff';
import { JsonDiff } from '@components/datatypes/json/JsonDiff';
import { Column, Row } from '@components/Row';
import {
  Datatype,
  isJSONObject,
  isYDoc,
  useProperty,
  YLoader,
  type AtomicValue,
  type Property,
  type Resource,
} from '@tomic/react';
import { ResourceInline } from '@views/ResourceInline';
import { FaArrowRight } from 'react-icons/fa6';
import styled from 'styled-components';
import ValueComp from '@components/ValueComp';
import { YDocMarkdownDiff } from './YDocMarkdownDiff';

export interface AtomicDiff {
  oldResource?: Resource;
  newResource: Resource;
  changedProps: string[];
}

interface ResourceDiffProps {
  diff: AtomicDiff;
  className?: string;
}

export function isPropEqual(
  oldProp: AtomicValue,
  newProp: AtomicValue,
): boolean {
  if (isYDoc(oldProp) && isYDoc(newProp)) {
    const Y = YLoader.Y;

    return (
      Y.encodeStateAsUpdateV2(oldProp) === Y.encodeStateAsUpdateV2(newProp)
    );
  }

  // This helps typescript assert that they are both not YDocs.
  if (isYDoc(oldProp) || isYDoc(newProp)) {
    return false;
  }

  if (isJSONObject(oldProp) && isJSONObject(newProp)) {
    return JSON.stringify(oldProp) === JSON.stringify(newProp);
  }

  if (Array.isArray(oldProp) && Array.isArray(newProp)) {
    return JSON.stringify(oldProp) === JSON.stringify(newProp);
  }

  return oldProp === newProp;
}

function getChangedProps(
  oldResource: Resource | undefined,
  newResource: Resource,
): string[] {
  const changedProps: string[] = [];

  if (!oldResource) {
    return Array.from(newResource.getPropVals().keys());
  }

  for (const [key, value] of oldResource.getPropVals()) {
    if (!isPropEqual(value, newResource.get(key))) {
      changedProps.push(key);
    }
  }

  for (const [key] of newResource.getPropVals()) {
    if (!oldResource.getPropVals().has(key)) {
      changedProps.push(key);
    }
  }

  return changedProps;
}

export function useResourceDiff(
  oldResource: Resource | undefined,
  newResource: Resource,
): AtomicDiff {
  const changedProps = getChangedProps(oldResource, newResource);

  return {
    oldResource,
    newResource,
    changedProps,
  };
}

export const ResourceDiff: React.FC<ResourceDiffProps> = ({
  diff,
  className,
}) => {
  const { oldResource, newResource, changedProps } = diff;

  return (
    <Column className={className}>
      {changedProps.map(prop => (
        <PropertyLine
          key={prop}
          prop={prop}
          oldResource={oldResource}
          newResource={newResource}
        />
      ))}
    </Column>
  );
};

const basicTypes = [
  Datatype.STRING,
  Datatype.SLUG,
  Datatype.INTEGER,
  Datatype.FLOAT,
  Datatype.BOOLEAN,
  Datatype.URI,
  Datatype.DATE,
];

interface PropertyLineProps {
  prop: string;
  oldResource?: Resource;
  newResource: Resource;
}

const PropertyLine = ({
  prop,
  oldResource,
  newResource,
}: PropertyLineProps) => {
  const property = useProperty(prop);

  const hasOld = oldResource?.getPropVals().has(prop);
  const hasNew = newResource.getPropVals().has(prop);

  let type: 'added' | 'removed' | 'changed' = 'changed';

  if (!hasOld) {
    type = 'added';
  } else if (!hasNew) {
    type = 'removed';
  }

  return (
    <PropLineWrapper>
      <Row center gap='1ch'>
        <DiffTag type={type}>{type}</DiffTag>
        <Title>
          <ResourceInline subject={prop} />
        </Title>
      </Row>
      <ChangeSwitcher
        property={property}
        oldResource={oldResource}
        newResource={newResource}
      />
    </PropLineWrapper>
  );
};

interface ChangeSwitcherProps {
  property: Property;
  oldResource?: Resource;
  newResource: Resource;
  showFullValue?: boolean;
}

export const ChangeSwitcher: React.FC<ChangeSwitcherProps> = ({
  property,
  oldResource,
  newResource,
  showFullValue = false,
}) => {
  if (!oldResource) {
    return (
      <div>
        <ValueComp
          datatype={property.datatype}
          value={newResource.get(property.subject)}
        />
      </div>
    );
  }

  if (basicTypes.includes(property.datatype)) {
    return (
      <BasicChange
        oldValue={oldResource.get(property.subject)}
        newValue={newResource.get(property.subject)}
      />
    );
  }

  if (
    property.datatype === Datatype.DATE ||
    property.datatype === Datatype.TIMESTAMP
  ) {
    return (
      <DateTimeChange
        oldValue={oldResource.get(property.subject)}
        newValue={newResource.get(property.subject)}
      />
    );
  }

  if (property.datatype === Datatype.MARKDOWN) {
    return (
      <MarkdownChange
        oldValue={oldResource.get(property.subject)}
        newValue={newResource.get(property.subject)}
        showFullValue={showFullValue}
      />
    );
  }

  if (property.datatype === Datatype.ATOMIC_URL) {
    return (
      <AtomicUrlChange
        oldValue={oldResource.get(property.subject)}
        newValue={newResource.get(property.subject)}
      />
    );
  }

  const valOld = oldResource.get(property.subject);
  const valNew = newResource.get(property.subject);

  if (isYDoc(valOld) || isYDoc(valNew)) {
    return (
      <YDocMarkdownDiff
        oldResource={oldResource}
        newResource={newResource}
        propertySubject={property.subject}
        showFullValue={showFullValue}
      />
    );
  }

  if (
    property.datatype === Datatype.JSON ||
    isJSONObject(valOld) ||
    isJSONObject(valNew) ||
    Array.isArray(valOld) ||
    Array.isArray(valNew)
  ) {
    return <JsonChange oldValue={valOld} newValue={valNew} />;
  }

  return null;
};

const JsonChange = ({
  oldValue = {},
  newValue = {},
}: {
  oldValue?: AtomicValue;
  newValue?: AtomicValue;
}) => {
  return <JsonDiff oldValue={oldValue} newValue={newValue} />;
};

const BasicChange = ({
  oldValue,
  newValue,
}: {
  oldValue?: string | number | boolean;
  newValue?: string | number | boolean;
}) => {
  if (oldValue === undefined) {
    return <span>{newValue?.toString() ?? <Empty>unset</Empty>}</span>;
  }

  return (
    <DiffRow center wrapItems>
      <OldDiffValue>
        {oldValue?.toString() ?? <Empty>unset</Empty>}
      </OldDiffValue>
      <DiffArrow />
      <span>{newValue?.toString() ?? <Empty>unset</Empty>}</span>
    </DiffRow>
  );
};

const MarkdownChange = ({
  oldValue = '',
  newValue = '',
  showFullValue = false,
}: {
  oldValue?: string;
  newValue?: string;
  showFullValue?: boolean;
}) => {
  const diff = createMarkdownDiff(oldValue, newValue, showFullValue);

  return <Markdown preserveLineBreaks text={diff} />;
};

const DateTimeChange = ({
  oldValue,
  newValue,
}: {
  oldValue?: number;
  newValue?: number;
}) => {
  const formatter = new Intl.DateTimeFormat('default', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  const format = (val?: number) => {
    if (val === undefined || val === null) {
      return <Empty>unset</Empty>;
    }

    const date = new Date(val as string | number);

    if (isNaN(date.getTime())) {
      return val.toString();
    }

    return formatter.format(date);
  };

  if (oldValue === undefined) {
    return <span>{format(newValue)}</span>;
  }

  return (
    <Row center>
      <OldDiffValue>{format(oldValue)}</OldDiffValue>
      <DiffArrow />
      <span>{format(newValue)}</span>
    </Row>
  );
};

const AtomicUrlChange = ({
  oldValue,
  newValue,
}: {
  oldValue?: string;
  newValue?: string;
}) => {
  if (oldValue === undefined && newValue !== undefined) {
    return <ResourceInline subject={newValue} />;
  }

  return (
    <DiffRow center wrapItems>
      {oldValue ? <ResourceInline subject={oldValue} /> : <Empty>unset</Empty>}
      <DiffArrow />
      {newValue ? <ResourceInline subject={newValue} /> : <Empty>unset</Empty>}
    </DiffRow>
  );
};

const Title = styled.h3`
  margin: 0;
`;

const DiffTag = styled.span<{ type: 'added' | 'removed' | 'changed' }>`
  --tag-color: ${p => {
    switch (p.type) {
      case 'added':
        return '#3cad3c';
      case 'removed':
        return p.theme.colors.alert;
      case 'changed':
        return p.theme.colors.main;
    }
  }};
  padding: 0 5px;
  border-radius: ${p => p.theme.radius};
  font-size: 0.55rem;
  font-weight: bold;
  text-transform: uppercase;
  color: var(--tag-color);
  border: 1px solid var(--tag-color);
  display: inline-flex;
  align-items: center;
  height: fit-content;
  align-self: center;
`;

const PropLineWrapper = styled(Column)`
  &:not(:last-child) {
    border-bottom: 1px solid ${p => p.theme.colors.bg2};
    padding-bottom: ${p => p.theme.size()};
  }
`;

const Empty = styled.span`
  color: ${p => p.theme.colors.textLight};
  font-style: italic;
`;

const OldDiffValue = styled.span`
  color: ${p => p.theme.colors.textLight};
`;

const DiffArrow = styled(FaArrowRight)`
  color: ${p => p.theme.colors.main};
`;

const DiffRow = styled(Row)`
  & svg {
    min-width: 1rem;
    flex-basis: content;
  }
`;

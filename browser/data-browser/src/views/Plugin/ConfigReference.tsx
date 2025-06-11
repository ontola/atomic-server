import type { JSONSchema7 } from 'ai';
import styled from 'styled-components';
import { Column, Row } from '@components/Row';
import Markdown from '@components/datatypes/Markdown';
import { Details } from '@components/Details';

interface ConfigReferenceProps {
  schema: JSONSchema7;
}

export const ConfigReference: React.FC<ConfigReferenceProps> = ({ schema }) => {
  const properties = schema.properties;

  if (!properties || Object.keys(properties).length === 0) {
    return null;
  }

  return (
    <Column>
      <Details noIndent title={<Title>Config Reference</Title>}>
        <ReferenceContent gap='1rem'>
          {Object.entries(properties).map(([key, value]) => (
            <PropertyRow
              key={key}
              name={key}
              definition={value}
              required={schema.required?.includes(key)}
            />
          ))}
        </ReferenceContent>
      </Details>
    </Column>
  );
};

interface PropertyRowProps {
  name: string;
  definition: JSONSchema7 | boolean;
  required?: boolean;
  level?: number;
}

const PropertyRow: React.FC<PropertyRowProps> = ({
  name,
  definition,
  required,
  level = 0,
}) => {
  if (typeof definition === 'boolean') {
    return null;
  }

  const hasProperties =
    definition.type === 'object' &&
    definition.properties &&
    Object.keys(definition.properties).length > 0;

  const hasItems =
    definition.type === 'array' &&
    definition.items &&
    typeof definition.items !== 'boolean';

  return (
    <PropertyContainer $level={level}>
      <Row justify='space-between' center>
        <PropertyName>
          {name}
          {required && <RequiredBadge>required</RequiredBadge>}
        </PropertyName>
        <PropertyType>{definition.type}</PropertyType>
      </Row>
      {definition.description && (
        <DescriptionWrapper>
          <Markdown text={definition.description} />
        </DescriptionWrapper>
      )}
      {definition.default !== undefined && (
        <DefaultValue>
          <span>Default: </span>
          <code>{JSON.stringify(definition.default)}</code>
        </DefaultValue>
      )}
      {definition.enum && (
        <EnumWrapper>
          <span>Possible values: </span>
          {definition.enum.map((v, i) => (
            <code key={i}>{JSON.stringify(v)}</code>
          ))}
        </EnumWrapper>
      )}
      {hasProperties && (
        <SubPropertiesWrapper>
          <Column gap='1rem'>
            {Object.entries(definition.properties!).map(([key, value]) => (
              <PropertyRow
                key={key}
                name={key}
                definition={value}
                required={definition.required?.includes(key)}
                level={level + 1}
              />
            ))}
          </Column>
        </SubPropertiesWrapper>
      )}
      {hasItems && (
        <SubPropertiesWrapper>
          <Column gap='1rem'>
            <PropertyRow
              name='items'
              definition={definition.items as JSONSchema7}
              level={level + 1}
            />
          </Column>
        </SubPropertiesWrapper>
      )}
    </PropertyContainer>
  );
};

const Title = styled.span`
  font-weight: bold;
  font-size: 1rem;
  margin: 0;
  font-family: ${p => p.theme.fontFamilyHeader};
`;

const ReferenceContent = styled(Column)`
  margin-top: ${p => p.theme.size()};
`;

const PropertyContainer = styled.div<{ $level: number }>`
  background-color: ${p =>
    p.$level % 2 === 0 ? p.theme.colors.bg1 : p.theme.colors.bg};
  padding: ${p => p.theme.size()};
  border-radius: ${p => p.theme.radius};
  border: 1px solid ${p => p.theme.colors.bg2};
`;

const SubPropertiesWrapper = styled.div`
  margin-top: ${p => p.theme.size(2)};
  border-left: 2px solid ${p => p.theme.colors.main};
  padding-left: ${p => p.theme.size(2)};
`;

const PropertyName = styled.span`
  font-weight: bold;
  font-family: ${p => p.theme.fontFamilyHeader};
  font-size: 1.1rem;
`;

const RequiredBadge = styled.span`
  color: ${p => p.theme.colors.alert};
  font-size: 0.7rem;
  margin-left: ${p => p.theme.size(2)};
  text-transform: uppercase;
  font-weight: bold;
  vertical-align: middle;
`;

const PropertyType = styled.span`
  color: ${p => p.theme.colors.main};
  font-family: monospace;
  font-size: 0.9rem;
`;

const DescriptionWrapper = styled.div`
  margin-top: ${p => p.theme.size(2)};
  color: ${p => p.theme.colors.text};
  font-size: 0.9rem;

  & p {
    margin-bottom: 0;
  }
`;

const DefaultValue = styled.div`
  margin-top: ${p => p.theme.size(2)};
  font-size: 0.8rem;
  color: ${p => p.theme.colors.textLight};

  & span {
    font-weight: bold;
  }

  & code {
    background-color: ${p => p.theme.colors.bg2};
    padding: 2px 4px;
    border-radius: 4px;
    font-family: monospace;
  }
`;

const EnumWrapper = styled.div`
  margin-top: ${p => p.theme.size(2)};
  font-size: 0.8rem;
  color: ${p => p.theme.colors.textLight};
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;

  & span {
    font-weight: bold;
  }

  & code {
    background-color: ${p => p.theme.colors.bg2};
    padding: 2px 4px;
    border-radius: 4px;
    font-family: monospace;
  }
`;

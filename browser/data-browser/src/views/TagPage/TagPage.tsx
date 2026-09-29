import {
  core,
  dataBrowser,
  useCanWrite,
  useProperty,
  useResource,
  useString,
  type DataBrowser,
} from '@tomic/react';
import type { ResourcePageProps } from '../ResourcePage';
import { ContainerNarrow } from '../../components/Containers';
import { Column, Row } from '../../components/Row';
import { ReferenceUsage } from '../../components/ResourceUsage/ReferenceUsage';
import { PalettePicker } from '../../components/PalettePicker';
import { tagColours } from '../../components/Tag/tagColours';
import { Card } from '../../components/Card';
import { Tag } from '../../components/Tag';
import { EmojiInput } from '../../components/forms/EmojiInput';
import { styled } from 'styled-components';
import InputSwitcher from '../../components/forms/InputSwitcher';
import { TagPropertyCard } from './TagPropertyCard';

export function TagPage({ resource }: ResourcePageProps<DataBrowser.Tag>) {
  const [, setColor] = useString(resource, dataBrowser.properties.color, {
    commit: true,
  });
  const [emoji, setEmoji] = useString(resource, dataBrowser.properties.emoji, {
    commit: true,
  });
  const shortnameProp = useProperty(core.properties.shortname);
  const canWrite = useCanWrite(resource);

  // A select column's tags are children of its property, and rows point at them
  // through that property (a task's Status), not through `tags`. Counting only
  // `tags` references showed "0 resources reference Doing" for every task in
  // Doing. Drive and ontology tags have a non-property parent and keep `tags`.
  const parentSubject = resource.get(core.properties.parent) as
    | string
    | undefined;
  const parent = useResource(parentSubject);
  const referencingProperty =
    parentSubject && parent.hasClasses(core.classes.property)
      ? parentSubject
      : dataBrowser.properties.tags;

  return (
    <ContainerNarrow>
      <Column>
        <TagWrapper>
          <Tag subject={resource.subject} />
        </TagWrapper>
        {canWrite && (
          <Card>
            <Column>
              <h2>Edit tag</h2>
              <Row gap='0.5rem'>
                <EmojiInputWrapper>
                  <EmojiInput initialValue={emoji} onChange={setEmoji} />
                </EmojiInputWrapper>
                <InputSwitcher
                  commit
                  resource={resource}
                  property={shortnameProp}
                  commitDebounceInterval={1000}
                />
              </Row>
              <PalettePicker palette={tagColours} onChange={setColor} />
            </Column>
          </Card>
        )}
        <TagPropertyCard resource={resource} />
        <ReferenceUsage
          resource={resource}
          property={referencingProperty}
          initialOpenState={true}
        />
      </Column>
    </ContainerNarrow>
  );
}

const EmojiInputWrapper = styled.div`
  border: 1px solid ${p => p.theme.colors.bg2};
  height: 2.2rem;
  width: 2.2rem;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: ${p => p.theme.radius};
`;

const TagWrapper = styled.span`
  font-size: 2rem;
  width: fit-content;
`;

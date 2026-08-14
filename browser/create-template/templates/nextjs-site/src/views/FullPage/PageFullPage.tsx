import type { Resource } from '@tomic/lib';
import BlockView from '../Block/BlockView';
import { type Page } from '@/ontologies/website';
import Container from '@/components/Layout/Container';
import VStack from '@/components/Layout/VStack';
import { EditableName } from '@/components/EditableField';

const PageFullPage = ({ resource }: { resource: Resource<Page> }) => {
  const title = resource.title;

  return (
    <Container>
      <VStack>
        <EditableName subject={resource.subject} initialValue={title} />

        {resource.props.blocks?.map(block => (
          <BlockView key={block} subject={block} />
        ))}
      </VStack>
    </Container>
  );
};

export default PageFullPage;

import { styled } from 'styled-components';

interface TemplateListItemProps {
  title: string;
  id: string;
  Image: React.FC;
  onClick: (id: string) => void;
}

export function TemplateListItem({
  title,
  id,
  onClick,
  Image,
}: TemplateListItemProps): React.JSX.Element {
  return (
    <Wrapper onClick={() => onClick(id)} data-testid='template-button'>
      <Image />
      <Content>
        <span>{title}</span>
      </Content>
    </Wrapper>
  );
}

const Wrapper = styled.button`
  --template-color-bg: var(--color-bg);
  --template-color-bg1: var(--color-border);
  --template-color-bg2: var(--color-text-subtle);

  appearance: none;
  padding: 0;
  cursor: pointer;
  background-color: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: clip;

  color: var(--color-text);

  &:hover,
  &:focus-visible {
    border-color: var(--color-accent);
    --template-color-bg2: var(--color-accent);
  }

  & svg {
    width: 100%;
    height: auto;
  }
`;

const Content = styled.div`
  border-top: 1px solid var(--color-border);
  padding: 1rem;
`;

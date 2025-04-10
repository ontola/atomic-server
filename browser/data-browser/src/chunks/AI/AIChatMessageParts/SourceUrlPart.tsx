import { styled } from 'styled-components';
import type { SourceUrlUIPart } from 'ai';
import { FaGlobe } from 'react-icons/fa6';

interface SourceUrlPartProps {
  part: SourceUrlUIPart;
}

export const SourceUrlPart = ({ part }: SourceUrlPartProps) => {
  return (
    <Wrapper>
      <FaGlobe />
      <a href={part.url} target='_blank' rel='noopener noreferrer'>
        {part.title ?? part.url}
      </a>
    </Wrapper>
  );
};

const Wrapper = styled.a`
  --source-url-width: 16rem;
  display: flex;
  align-items: center;
  gap: 1ch;
  padding: 0.5em 1em;
  background-color: ${p => p.theme.colors.bg1};
  border-radius: 50px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  margin-bottom: ${p => p.theme.size(2)};
  max-width: var(--source-url-width);
  color: ${p => p.theme.colors.textLight};
  font-size: 0.8rem;
  a {
    color: ${p => p.theme.colors.textLight};
    text-decoration: none;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: calc(var(--source-url-width) - 3.4rem);
    &:hover {
      text-decoration: underline;
    }
  }
`;

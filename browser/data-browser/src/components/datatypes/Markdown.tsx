import ReactMarkdown, { Components } from 'react-markdown';
import { styled } from 'styled-components';
import remarkGFM from 'remark-gfm';
import { Button } from '@components/Button';
import { truncateMarkdown } from '@helpers/markdown';
import { FC, useState } from 'react';
import { AtomicLink, AtomicLinkProps } from '@components/AtomicLink';
import { remarkMention, Mention } from './MarkdownMention';
import { addFieldsIf } from '@helpers/addIf';

type Props = {
  text: string;
  renderGFM?: boolean;
  /**
   * If this is set, and the markdown is more characters than this number, the
   * text will be truncated and a button will be shown
   */
  maxLength?: number;
  className?: string;
  nestedInLink?: boolean;
  markExternalLinks?: boolean;
};

const disableElementsInLink = ['a'];

const ExternalLinkComponent = ({
  children: linkChildren,
  ...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
  return (
    <AtomicLink {...(props as AtomicLinkProps)}>{linkChildren}</AtomicLink>
  );
};

/** Renders a markdown value */
const Markdown: FC<Props> = ({
  text,
  renderGFM = true,
  maxLength = 5000,
  className,
  nestedInLink = false,
  markExternalLinks = false,
}) => {
  const [collapsed, setCollapsed] = useState(true);

  if (!text) {
    return null;
  }

  return (
    <MarkdownWrapper className={className}>
      <ReactMarkdown
        remarkPlugins={renderGFM ? [remarkGFM, remarkMention] : [remarkMention]}
        disallowedElements={nestedInLink ? disableElementsInLink : undefined}
        components={
          {
            mention: Mention,
            ...addFieldsIf(markExternalLinks, {
              a: ExternalLinkComponent,
            }),
            // ReactMarkdowns typing only allows existing html elements but our plugin creates a new type. It works fine, the types are just too strict.
          } as unknown as Components
        }
      >
        {collapsed ? truncateMarkdown(text, maxLength) : text}
      </ReactMarkdown>
      {text.length > maxLength && collapsed && (
        <Button subtle onClick={() => setCollapsed(false)}>
          {'Read more '}
        </Button>
      )}
    </MarkdownWrapper>
  );
};

const MarkdownWrapper = styled.div`
  width: 100%;
  overflow-x: hidden;
  img {
    max-width: 100%;
  }

  * {
    white-space: unset;
  }

  p,
  h1,
  h2,
  h3,
  h4,
  h5,
  h6 {
    margin-bottom: 1.5rem;
  }

  p:only-child {
    margin-bottom: 0;
  }

  blockquote {
    margin-inline-start: 0rem;
    padding-inline-start: 1rem;
    border-inline-start: solid 3px ${props => props.theme.colors.bg2};
    color: ${props => props.theme.colors.textLight};
  }

  code {
    font-family: Monaco, monospace;
    font-size: 0.8em;
  }

  :not(pre) > code {
    background-color: ${props => props.theme.colors.bg1};
    padding: 0rem 0.2rem;
    font-family: Monaco, monospace;
    display: inline-flex;
    white-space: nowrap;
    overflow: auto;
    max-width: 100%;
  }

  pre {
    background-color: ${p => p.theme.colors.bg1};
    padding: 0.5rem ${p => p.theme.margin}rem;
    border-radius: ${p => p.theme.radius};
    white-space: pre;
    overflow-x: auto;
  }

  table {
    margin-bottom: 1.5rem;
    width: 100%;
  }

  table,
  thead,
  tbody,
  th,
  td {
    border-collapse: collapse;
    padding: 0.5rem;

    border: 1px solid ${props => props.theme.colors.bg2};
  }

  a {
    word-break: break-word;
  }
`;

export default Markdown;

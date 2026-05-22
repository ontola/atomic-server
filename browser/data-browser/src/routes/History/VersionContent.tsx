import { styled } from 'styled-components';

interface VersionContentProps {
  containers: Map<string, unknown>;
}

/**
 * Renders the non-propval content captured at a Version — top-level Loro
 * containers that aren't part of the `properties` map. The chief consumer is
 * the `doc` container that loro-prosemirror writes Document bodies into; its
 * shape is a ProseMirror JSON tree and we surface the readable text.
 *
 * Renders nothing when there are no containers, so resources without a
 * rich-text body (folders, agents, etc.) don't get an empty section.
 */
export function VersionContent({ containers }: VersionContentProps) {
  if (containers.size === 0) return null;

  return (
    <Wrap>
      {[...containers.entries()].map(([key, value]) => {
        const isProseMirror = key === 'doc';
        const body = isProseMirror
          ? extractProseMirrorText(value).trim()
          : JSON.stringify(value, null, 2);

        return (
          <Section key={key}>
            <Heading>{isProseMirror ? 'Document body' : key}</Heading>
            {body ? <Pre>{body}</Pre> : <Muted>(empty)</Muted>}
          </Section>
        );
      })}
    </Wrap>
  );
}

/**
 * Extract readable text from a ProseMirror JSON tree. Walks the doc,
 * concatenates text nodes, and adds a newline after each block-level node so
 * paragraphs don't run together. Best-effort: this is for human-readable
 * history previews, not for round-tripping ProseMirror state.
 */
function extractProseMirrorText(node: unknown): string {
  if (node === null || node === undefined) return '';

  if (Array.isArray(node)) {
    return node.map(extractProseMirrorText).join('');
  }

  if (typeof node !== 'object') return '';

  const obj = node as Record<string, unknown>;

  if (typeof obj.text === 'string') {
    return obj.text;
  }

  const children = Array.isArray(obj.content) ? obj.content : null;

  if (!children) return '';

  const joined = children.map(extractProseMirrorText).join('');
  const type = typeof obj.type === 'string' ? obj.type : '';
  // Add a newline after block-level nodes so paragraphs separate; inline
  // marks/text nodes stay inline.
  const isBlock = type !== '' && type !== 'text' && type !== 'hardBreak';

  return joined + (isBlock ? '\n' : '');
}

const Wrap = styled.div`
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1rem;
  border-top: 1px solid ${p => p.theme.colors.bg2};
`;

const Section = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
`;

const Heading = styled.div`
  font-weight: bold;
  color: ${p => p.theme.colors.textLight};
`;

const Pre = styled.pre`
  white-space: pre-wrap;
  font-family: inherit;
  margin: 0;
`;

const Muted = styled.span`
  color: ${p => p.theme.colors.textLight};
  font-style: italic;
`;

import type { Editor } from '@tiptap/core';
import { FloatingMenu } from '@tiptap/react/menus';
import { styled } from 'styled-components';

interface FloatingHintProps {
  editor: Editor;
}

export const FloatingHint: React.FC<
  React.PropsWithChildren<FloatingHintProps>
> = ({ editor, children }) => {
  const floatingMenuRef = (node: HTMLDivElement) => {
    if (node) {
      node.tabIndex = -1;

      const observer = new MutationObserver(mutations => {
        for (const mutation of mutations) {
          if (
            mutation.type === 'attributes' &&
            node.getAttribute('tabindex') !== '-1'
          ) {
            node.setAttribute('tabindex', '-1');
          }
        }
      });

      observer.observe(node, {
        attributes: true,
        attributeFilter: ['tabindex'],
      });

      return () => observer.disconnect();
    }
  };

  return (
    <FloatingMenu editor={editor} ref={floatingMenuRef}>
      <FloatingMenuText>{children}</FloatingMenuText>
    </FloatingMenu>
  );
};

export const FloatingMenuText = styled.span`
  color: ${p => p.theme.colors.textLight};
  user-select: none;
`;

import { styled } from 'styled-components';
import {
  RESOURCE_PAGE_TRANSITION_TAG,
  getTransitionStyle,
} from '../helpers/transitionName';
import { CARD_CONTAINER } from '../helpers/containers';

type CardProps = {
  /** Adds a colorful border */
  highlight?: boolean;
  /** Sets a maximum height */
  small?: boolean;
};

const Content = styled.div`
  padding: var(--space-3);
`;

const CardBase = styled.div.attrs<CardProps>(p => ({
  // When we render a lot of cards it is more performant to use styles instead of classes when each card has a unique style
  style: getTransitionStyle(RESOURCE_PAGE_TRANSITION_TAG, p.about),
}))`
  background-color: var(--color-bg);
  container: ${CARD_CONTAINER} / inline-size;
  border: solid 1px
    ${p => (p.highlight ? 'var(--color-accent)' : 'var(--color-border)')};

  padding: var(--space-3);
  border-radius: var(--radius-md);
  max-height: ${p => (p.small ? 'var(--space-12)' : 'initial')};
  overflow: ${p => (p.small ? 'hidden' : 'visible')};

  &:has(${Content}) {
    padding: 0;
  }
`;

/** A Card with a border.
 * By default the Card has padding but if you use `Card.Content` inside the card, only the content will have padding.
 */
export const Card = Object.assign(CardBase, { Content });

export interface CardRowProps {
  noBorder?: boolean;
}

/** A Row in a Card. Should probably be used inside a CardInsideFull */
export const CardRow = styled.div<CardRowProps>`
  --border: solid 1px var(--color-border);
  display: block;
  border-top: ${p => (p.noBorder ? 'none' : 'var(--border)')};
  padding: var(--space-2) var(--space-3);
`;

/** A block inside a Card which has full width */
export const CardInsideFull = styled.div`
  margin-left: calc(var(--space-3) * -1);
  margin-right: calc(var(--space-3) * -1);
  padding-inline: var(--space-3);
`;

export const Margin = styled.div`
  display: block;
  height: var(--space-3);
`;

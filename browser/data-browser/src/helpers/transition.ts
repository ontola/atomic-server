import { css } from 'styled-components';

/** Standard transition for a set of properties, on the shared motion token. */
export function transition(...properties: string[]) {
  const value = properties
    .map(property => `${property} var(--duration-fast) ease-in-out`)
    .join(',');

  return css`
    transition: ${value};
  `;
}

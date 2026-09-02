import { i18n, useResource, useValue } from '@tomic/react';
import { useSettings } from '../helpers/AppSettings';

/**
 * The languages the current drive declares via the `languages` property
 * (a JSON array of BCP 47 tags), or undefined when it declares none.
 * The declared set is the contract completeness UI checks against: with it,
 * language pickers become enums and absent translations count as "missing".
 */
export function useDeclaredLanguages(): string[] | undefined {
  const { drive } = useSettings();
  const driveResource = useResource(drive);
  const [languages] = useValue(driveResource, i18n.properties.languages);

  if (!Array.isArray(languages)) {
    return undefined;
  }

  const tags = languages.filter(tag => typeof tag === 'string') as string[];

  return tags.length > 0 ? tags : undefined;
}

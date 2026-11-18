import { useState, Fragment, type JSX } from 'react';
import {
  isLensEndpointKey,
  JSONValue,
  lensEndpointKeysAllowedInRenders,
} from '@tomic/react';
import { styled } from 'styled-components';
import { ResourceInline } from '../../views/ResourceInline';

type Props = {
  subjects: JSONValue[];
};

const MAX_COUNT = 10;

/** Renders an array of subject URLs as links with commas between them */
function ResourceArray({ subjects: subjectsIn }: Props): JSX.Element {
  const [showAll, setShowMore] = useState(false);

  const tooMany = subjectsIn.length > MAX_COUNT;
  let subjects = subjectsIn;

  if (!showAll && tooMany) {
    subjects = subjects.slice(0, MAX_COUNT);
  }

  return (
    <>
      {subjects.map((url, index) => {
        if (typeof url !== 'string') {
          console.warn(`ResourceArray: subject ${url} isn't a string`, url);

          return null;
        }

        // A lens endpoint key in an App's `renders` (`record:…`, `rdf:…`,
        // split-pieces flag only) is not a subject, so it is shown as text
        // rather than fetched.
        const endpointKey =
          lensEndpointKeysAllowedInRenders() && isLensEndpointKey(url);

        return (
          <Fragment key={url}>
            {endpointKey ? (
              <code>{url}</code>
            ) : (
              <ResourceInline subject={url} />
            )}
            {index !== subjects.length - 1 && ', '}
          </Fragment>
        );
      })}
      {tooMany && (
        <ShowMoreButton onClick={() => setShowMore(!showAll)}>
          {showAll ? 'show less' : `show ${subjectsIn.length - MAX_COUNT} more`}
        </ShowMoreButton>
      )}
    </>
  );
}

const ShowMoreButton = styled.span`
  cursor: pointer;
  margin-left: 0.5em;

  &:hover {
    text-decoration: underline;
  }
`;

export default ResourceArray;

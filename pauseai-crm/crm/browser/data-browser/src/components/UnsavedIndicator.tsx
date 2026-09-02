import {
  ResourceEvents,
  StoreEvents,
  type Resource,
  useStore,
} from '@tomic/react';
import { useEffect, useState } from 'react';
import styled from 'styled-components';

interface UnsavedIndicatorProps {
  resource: Resource;
}

export const UnsavedIndicator: React.FC<UnsavedIndicatorProps> = ({
  resource,
}) => {
  const store = useStore();
  const [hasChanges, setHasChanges] = useState(resource.hasUnsavedChanges());

  useEffect(() => {
    const check = () => setHasChanges(resource.hasUnsavedChanges());

    check();

    // Update when properties change (set/remove)
    const unsubLocal = resource.on(ResourceEvents.LocalChange, check);

    // Update when save completes (clears dirty flag)
    const unsubSaved = store.on(StoreEvents.ResourceSaved, saved => {
      if (saved.subject === resource.subject) {
        check();
      }
    });

    // Update when store notifies (e.g. after offline save calls addResources)
    const unsubStore = store.subscribe(resource.subject, check);

    return () => {
      unsubLocal();
      unsubSaved();
      unsubStore();
    };
  }, [resource, store]);

  if (!hasChanges) {
    return null;
  }

  return <Indicator>*</Indicator>;
};

const Indicator = styled.span`
  color: ${p => p.theme.colors.warning};
`;

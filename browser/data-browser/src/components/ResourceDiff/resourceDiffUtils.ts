import {
  isJSONObject,
  isYDoc,
  YLoader,
  type AtomicValue,
  type Resource,
} from '@tomic/react';

export interface AtomicDiff {
  oldResource?: Resource;
  newResource: Resource;
  changedProps: string[];
}

export function isPropEqual(
  oldProp: AtomicValue,
  newProp: AtomicValue,
): boolean {
  if (isYDoc(oldProp) && isYDoc(newProp)) {
    const Y = YLoader.Y;

    return (
      Y.encodeStateAsUpdateV2(oldProp) === Y.encodeStateAsUpdateV2(newProp)
    );
  }

  if (isYDoc(oldProp) || isYDoc(newProp)) {
    return false;
  }

  if (isJSONObject(oldProp) && isJSONObject(newProp)) {
    return JSON.stringify(oldProp) === JSON.stringify(newProp);
  }

  if (Array.isArray(oldProp) && Array.isArray(newProp)) {
    return JSON.stringify(oldProp) === JSON.stringify(newProp);
  }

  return oldProp === newProp;
}

function getChangedProps(
  oldResource: Resource | undefined,
  newResource: Resource,
): string[] {
  const changedProps: string[] = [];

  if (!oldResource) {
    return Array.from(newResource.getPropVals().keys());
  }

  for (const [key, value] of oldResource.getPropVals()) {
    if (!isPropEqual(value, newResource.get(key))) {
      changedProps.push(key);
    }
  }

  for (const [key] of newResource.getPropVals()) {
    if (!oldResource.getPropVals().has(key)) {
      changedProps.push(key);
    }
  }

  return changedProps;
}

export function useResourceDiff(
  oldResource: Resource | undefined,
  newResource: Resource,
): AtomicDiff {
  const changedProps = getChangedProps(oldResource, newResource);

  return {
    oldResource,
    newResource,
    changedProps,
  };
}

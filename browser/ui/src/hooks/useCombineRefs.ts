/**
 * Returns a callback ref that sets all given refs to the same passed in node.
 * Usefull if you want multiple refs to reference the same dom element.
 */
export function useCombineRefs<T>(
  refs: Array<React.Ref<T> | undefined>,
): (node: T) => void {
  return (node: T) => {
    for (const ref of refs) {
      if (!ref) continue;

      if (typeof ref === 'function') {
        ref(node);
      } else if (ref) {
        ref.current = node;
      }
    }
  };
}

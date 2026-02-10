# VirtualizedCollectionList

The `VirtualizedCollectionList` component is a helper for rendering large Atomic Data Collections. It implements "infinite scroll" by loading pages of a collection as the user scrolls to the bottom of the list.

It uses an `IntersectionObserver` at the bottom of the list to detect when more items should be loaded.

## Basic usage

```jsx
import { VirtualizedCollectionList, useCollection } from "@tomic/react";

const MyCollection = () => {
  const { collection } = useCollection({
    property: 'https://atomicdata.dev/properties/isA',
    value: 'https://atomicdata.dev/classes/Document',
  });

  return (
    <VirtualizedCollectionList
      collection={collection}
      Loader={<div>Loading collection...</div>}
    >
      {({ resource, index }) => (
        <div key={resource.subject}>
          {index}: {resource.title}
        </div>
      )}
    </VirtualizedCollectionList>
  );
};
```

## Props

| Prop | Type | Description |
| :--- | :--- | :--- |
| `collection` | `Collection` | The Atomic Data collection to render. Usually obtained via `useCollection`. |
| `children` | `(props: VirtualizedCollectionListItemProps) => ReactNode` | A render prop for each item in the collection. |
| `Loader` | `ReactNode` | (Optional) A component or element to show while the collection itself is being fetched. |

### Children Render Prop

The `children` prop receives an object with the following properties:

- `index`: The index of the item in the collection.
- `collection`: The collection object.
- `resource`: The loaded `Resource` object for this item.

## Performance note

The `VirtualizedCollectionList` component implements an infinite scroll pattern. This means that **once an item is loaded and rendered, it remains in the DOM**.

For most collections (up to a few hundred items), this is perfectly fine and provides a smooth user experience. However, if you are dealing with extremely large lists (thousands of items) and notice performance issues, you should consider using a windowing library like [react-window](https://github.com/bvaughn/react-window) or [react-virtuoso](https://github.com/petyosi/react-virtuoso). These libraries only keep the currently visible items in the DOM, which can significantly reduce the memory footprint and improve rendering performance for very large datasets.

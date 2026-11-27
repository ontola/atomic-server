# useValue

The `useValue` hook is used to read and write values from a resource.
It looks and functions a lot like React's useState hook.

```jsx
  import { useValue } from '@tomic/react';

  const MyComponent = ({ subject }) => {
    const resource = useResource(subject);
    const [value, setValue] = useValue(resource, 'https://example.com/property');

    return (
      <div>
        <input value={value} onChange={e => setValue(e.target.value)} />
      </div>
    );
  };
```

The `useValue` hook does not save the resource by default when the value is changed.
This can be configured by passing an options object as the third argument with `commit` set to true.

Awaiting the setter waits for local processing, not for a save. Validation
failures use `handleValidationError` or the Store's error reporting.
With `commit: true`, the hook schedules a debounced save. Observe progress with
`useSaveState(resource)` from `@tomic/react`, or with
`store.getSaveState(resource)` and `store.subscribeSaveState(resource, callback)`
outside React. These report scheduling, pending work and errors; they are not
receipts for an independent copy of the data.

When an action needs the save result, await `resource.save()` and inspect its
result. A child waiting for an unsaved parent returns `'queued'`: it is held in
memory until its parent is saved, with no completed local persistence or server
acceptance. This used to return `'offline'`. Callers that treat `'offline'` as an
incomplete remote save must also handle `'queued'`, including exhaustive
`SaveResult` switches. Saving the parent still drains the child batch in order.
`'noop'` means there was nothing to save; `'persisted'` means server acceptance
for a hosted resource, or local persistence for a local-only resource. Server
acceptance does not by itself promise a disk flush or another independent copy.

Awaiting the setter waits for local processing, not for its debounced save.
For version-specific completion evidence, await `resource.saveWithReceipt()`
and inspect its optional `local` and `server` fields. See the
[persistence guide](../local-first-guide/4-persist.md#read-version-specific-receipts)
for examples and limits. The `useSaveState(resource)` hook reports progress and
errors; it is not a receipt for a particular version.

In practice, you will use typed versions of `useValue` more often.
These offer better typescript typing and validation on writes.

The following value hooks are available:

- `useString` for string, slug, uri and markdown values.
- `useNumber` for float and integer values.
- `useBoolean` for boolean values.
- `useArray` for ResourceArray values.

## Reference

### Parameters

- **resource**: `Resource` - The resource object to read and write from.
- **property**: `string` - The subject of the property you want to read and write.
- **options**: `object` - (Optional) Options for how the value should be read and written.

**Options**:
| Name | Type | Description |
| --- | --- | --- |
| commit | `boolean` | If true, the resource will be saved when the value is changed. Default: `false` |
| validate | `boolean` | If true, the value will be validated against the properties datatype. Default: `true`|
| commitDebounce | `number` | The number of milliseconds to wait before saving the resource. Default: `100`|
| handleValidationError | `function` | A function that is called when the value is invalid. |

### Returns

Returns an array (tuple) with two items:

- **value**: type depends on the hook used - The value of the property.
- **setValue**: `async function` - A function to set the value of the property.

### Examples

Changing the name of some resource.

```jsx
  import { useString } from '@tomic/react';

  const MyComponent = ({ subject }) => {
    const resource = useResource(subject);
    const [value, setValue] = useString(resource, core.properties.name, {
      commit: true,
    });

    return (
      <div>
        <input value={value} onChange={e => setValue(e.target.value)} />
      </div>
    );
  };
```

Adding tags to a ResourceArray property.
Displays an error when the name is not a valid slug.

```jsx
const MyComponent = ({subject}) => {
  const store = useStore();
  const resource = useResource(subject);
  // We might encounter validation errors so we should show these to the user.
  const [error, setError] = useState<Error>();
  // Value of the input field. Used to set the name of the tag.
  const [inputValue, setInputValue] = useState('');

  // The ResourceArray value of the resource.
  const [tags, setItems] = useArray(resource, myOntology.properties.tags, {
    commit: true,
    handleValidationError: setError,
  });


  const addTag = async () => {
    // Create a new tag resource.
    const newTag = await store.newResource({
      isA: dataBrowser.classes.tag,
      parent: subject,
      propVals: {
        [core.properties.shortname]: inputValue,
      }
    });

    // Add the new tag to the array.
    await setItems([...tags, newTag]);
    // Reset the input field.
    setInputValue('');
  }

  return (
    <div>
      {tags.map((item, index) => (
        <Tag key={item.subject} subject={item.subject}/>
      ))}
      <input type="text" onChange={e => setInputValue(e.target.value)}>
      <button onClick={addTag}>Add</button>
      {error && (
        <p>{error.message}</p>
      )}
    </div>
  );
};
```

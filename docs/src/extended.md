{{#title Atomic Data Extended specification}}
# Atomic Data Extended

Atomic Data is a _modular_ specification, which means that you can choose to implement parts of it.
All parts of Extended are _optional_ to implement.
The _Core_ of the specification (described in the previous chapter) is required for all of the Extended spec to work, but not the other way around.

However, many of the parts of Extended do depend on _eachother_.

Together they are what turns a data model into a [local-first](local-first.md) system: identity that lives in a key, writes that carry their own proof, and devices that reconcile whenever they meet.

{{#include extended-table.md}}

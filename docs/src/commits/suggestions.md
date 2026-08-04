# Atomic Suggestions and Forks

Atomic Data supports proposing a change to an existing resource without editing
it in place. The shipped mechanism is a **Fork**.

> Historical note: an earlier draft of this page described HTTP POST "Suggestions"
> to an Owner Inbox. That design was never the product path and is superseded by
> Forks below. See also the CMS guide: [Drafts and forks](../atomicserver/cms.md).

## Design goals

- **Asynchronous collaboration**: Several people can prepare changes without
  blocking the live resource.
- **Safe staging**: The original stays readable and stable until a deliberate
  merge.
- **Ordinary resources**: A proposal is itself Atomic Data — with a subject,
  history, and rights — not a side-channel patch format.

## Fork

Forking:

1. Copies the resource (or creates a resource that carries the same content
   class).
2. Places it under the drive's private Forks folder (not publicly readable by
   default).
3. Sets `originalSubject` to the resource being changed.
4. Records merge baselines (`forkBase` / `forkVersion`) so property and Loro-body
   merges are well-defined.

The copy is a **Fork** (`isA` includes the `Fork` class). Because you (or your
staging folder) control it, you edit it with normal [Commits](intro.md). The
live resource is unchanged until merge.

### Merge

Merging applies the fork onto `originalSubject` and retires the fork. Conflict
handling uses the stored baseline plus Loro CRDT merge for collaborative
document bodies.

### Rights

A fork is authorized like any other resource under the hierarchy. Staging your
own edit requires write access to create the fork; accepting a merge requires
write access on the original. Cross-agent "suggest from outside" can use the
same `originalSubject` shape once the productized invite/authorization path for
that case is enabled — the data model does not need a second proposal type.

## Drafts (not forks)

**Draft** means unpublished *new* content: a resource that lives in a private
Drafts folder. Publishing is moving it to a public parent. Drafts do not use
`originalSubject`; they are not proposals against an existing subject. See
[Headless CMS, drafts, and forks](../atomicserver/cms.md).

## Related

- [Commits](intro.md)
- [Hierarchy](../hierarchy.md)
- [Ownership](ownership.md) (historical companion notes)

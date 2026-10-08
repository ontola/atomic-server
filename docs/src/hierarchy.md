{{#title Atomic Data Hierarchy, rights and authorization }}
# Hierarchy, rights and authorization

Hierarchies help make information easier to find and understand.
For example, most websites use breadcrumbs to show you where you are.
Your computer probably has a bunch of _drives_ and deeply nested _folders_ that contain _files_.
We generally use these hierarchical elements to keep data organized, and to keep a tighter grip on rights management.
For example, sharing a specific folder with a team, but a different folder could be private.

Although you are free to use Atomic Data with your own custom authorization system, we have a standardized model that is currently being used by Atomic-Server.

## Design goals

- **Fast**. Authorization can sometimes be costly, but in this model we'll be considering performance.
- **Simple**. Easy to understand, easy to implement.
- **Handles most basic use-cases**. Should deal with basic read / write access control, calculating the size of a folder, rendering things in a tree.

## Atomic Hierarchy Model

- Every Resource SHOULD have a [`parent`](https://atomicdata.dev/properties/parent). There are some exceptions to this, which are discussed below.
- Any Resource can be a `parent` of some other Resource, as long as both Resources exists on the same Atomic Server.
- Grants / rights given in a `parent` also apply to all children, and their children.
- There are few Classes that do not require `parent`s:

## Authorization

- Any Resource might have [`read`](https://atomicdata.dev/properties/read) and [`write`](https://atomicdata.dev/properties/write) Atoms. These both contain a list of Agents. These Agents will be granted the rights to edit (using Commits) or read / use the Resources.
- Instead of listing every Agent, a `read`, `write` or `append` list can also contain a [`Group`](#groups). Every member of that Group gets the right.
- Rights are _additive_, which means that the rights add up. If a Resource itself has no `write` Atom containing your Agent, but it's `parent` _does_ have one, you will still get the `write` right.
- Rights cannot be removed by children or parents - they can only be added.
- `Commits` can not be edited. They can be `read` if the Agent has rights to read the [`subject`](https://atomicdata.dev/properties/subject) of the `Commit`.

## Groups

A [`Group`](https://atomicdata.dev/classes/Group) is a resource with a `name` and a list of `members` (`https://atomicdata.dev/properties/group/members`). A member is an Agent or another Group.
Put the Group's subject anywhere an Agent can appear in `read`, `write` or `append`, and all of its members get that right, on the resource and on everything below it.

- Membership is resolved when rights are checked, so adding or removing a member (a normal Commit on the Group) changes access to every resource that grants the Group on the next request. This includes collections, search results and WebSocket subscriptions, because they all use the same rights check.
- Groups can contain Groups. Membership is the transitive closure, and cycles are harmless: a cycle grants nothing unless an Agent is reachable in it.
- Only the `members` of a Group that exists on the same server, and that is really an instance of `Group`, count. A deleted Group, or an entry that is not a Group, grants nothing.
- Who may change a Group's members is decided by the Group's own `write` rights, like any other Resource.
- Group membership is checked after the plain Agent entries, so lists that only name Agents are evaluated exactly as before.

## Top-level resources

Some resources are special, as they do not require a `parent`:

- [`Drive`](https://atomicdata.dev/classes/Drive)s are top-level items in the hierarchy: they do not have a `parent`.
- [`Agent`](https://atomicdata.dev/classes/Agent)s are top-level items because they are not `owned` by anything. They can always `read` and `write` themselves.
- [`Commit`](https://atomicdata.dev/classes/Commit)s are immutable, so they should never be edited by anyone. That's why they don't have a place in the hierarchy. Their `read` rights are determined by their subject.

## Authentication

Authentication is about proving _who you are_, which is often the first step for authorization. See [authentication](./authentication.md).

## Current limitations of the Authorization model

The specification is growing (and please contribute in the [docs repo](https://github.com/atomicdata-dev/atomic-data-docs/issues)), but the current specification lacks some features:

- Rights can only be added, but not removed in the hierarchy. This means that you cannot have a secret folder inside a public folder.
- Groups only model sets of Agents; there are no other runtime checks (attributes, roles, time-limited grants) for authorization. ([issue](https://github.com/atomicdata-dev/atomic-data-docs/issues/73))
- No way to limit delete access or invite rights separately from write rights ([issue](https://github.com/atomicdata-dev/atomic-data-docs/issues/82))
- No way to request a set of rights for a Resource

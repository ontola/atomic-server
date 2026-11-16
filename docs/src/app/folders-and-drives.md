# Folders and drives

Everything you make needs a place to live, and a way to decide who can touch it.

## Drives

A *drive* is the top of a tree of resources, and the unit you sync and share.
You get a home drive when you start.
The drive switcher at the top of the sidebar lists *Private drive*, *New Drive* (for a team or project), *View all drives* and *Storage and hosting*.
Drive settings let you manage who has access, and what is installed.

When you create a workspace through an Atomic account, Cloud Vault starts its first backup in the background.
You can keep working while the app shows that the first backup is pending. If it fails, use *Retry backup*.
*Storage and hosting* shows the last verified full sync for Cloud Server or a self-hosted Atomic Server, and the last successful backup for Cloud Vault.
Atomic uses the newest of these times to check how recently it verified your data on an external server or in Cloud Vault. It shows a warning after 24 hours and a stronger warning after seven days or when it can’t verify either a full sync or a backup.
For server sync, Atomic checks that the server has the drive’s local changes. A full sync with an external server clears the warning even with Cloud Vault turned off.
In Sync settings, a paired device shows *Last full sync* when it has confirmed that it holds this drive’s resources and uploaded files. The date belongs to this drive and this device.
Use *Back up now* in Sync settings to make a fresh Cloud Vault backup, including when an unchanged drive has an older backup.

![The drive switcher and the sidebar tree](../assets/app/drives.png)

## Folders

Press *+* and choose *Folder*.
Folders hold documents, tables, chat rooms, other folders and files.
You can show a folder as a *List View* or a *Grid View*.
Drag things in the sidebar to move them, or use the move option in a resource's menu.

## What is special about it

Rights flow down the tree.
If you can edit a folder, you can edit what is in it, unless something below says otherwise.
Read more in [drives and permissions](../hierarchy.md).
Because a drive is just a tree of resources, you can back it up, move it to another server, or fetch it through the [API](../atomicserver/API.md).

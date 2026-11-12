# Folders and drives

Everything you make needs a place to live, and a way to decide who can touch it.

## Drives

A *drive* is the top of a tree of resources, and the unit you sync and share.
You get a home drive when you start.
The drive switcher at the top of the sidebar lists *Private drive*, *New Drive* (for a team or project), *View all drives* and *Storage and hosting*.
Drive settings let you manage who has access, and what is installed.

![The drive switcher and the sidebar tree](../assets/app/drives.png)

## Folders

Press *+* and choose *Folder*.
Folders hold documents, tables, chat rooms, other folders and files.
You can show a folder as a *List View* or a *Grid View*.
Drag things in the sidebar to move them, or use the move option in a resource's menu.

## Cloud Vault backup

Cloud Vault backs up a drive to the cloud so you can restore it on a new device.
Your documents, tables and other resources are encrypted on your device first, so only you can read them.

Files (uploads, images, attachments) are included and are encrypted on your device the same way, so only you can read them.
A file that appears several times in one backup is stored once.
Files count toward the storage of the backup that holds them.
Two backups that happen to hold the same file store it separately, and nothing in the cloud links them.
When you use *Compress now*, files that no longer exist in your drive are removed from the cloud after a short window in which a deletion can still be undone.

If a file is not on the device that runs the backup, it cannot be backed up from there.
A restore, including a restore to an earlier snapshot, says how many files it could not bring back.
A backup file downloaded from Cloud Vault contains the encrypted history only, not the files.

## What is special about it

Rights flow down the tree.
If you can edit a folder, you can edit what is in it, unless something below says otherwise.
Read more in [drives and permissions](../hierarchy.md).
Because a drive is just a tree of resources, you can back it up, move it to another server, or fetch it through the [API](../atomicserver/API.md).

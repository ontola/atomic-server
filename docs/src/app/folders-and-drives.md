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

## Cloud Vault backup

Cloud Vault backs up a drive to the cloud so you can restore it on a new device.
Your documents, tables and other resources are encrypted on your device first, so only you can read them.

Files (uploads, images, attachments) are included and are encrypted on your device the same way, so only you can read them.
A file that appears several times in one backup is stored once.
Files count toward the storage of the backup that holds them.
Two backups that happen to hold the same file store it separately, and nothing in the cloud links them.
Files you delete from your drive stay in the Cloud Vault, and keep counting toward its storage, until a later version can safely reclaim them. *Compress now* and *Discard history* free old history, not files.

If a file is not on the device that runs the backup, it cannot be backed up from there.
A restore, including a restore to an earlier snapshot, says how many files it could not bring back.
A backup file downloaded from Cloud Vault contains the encrypted history only, not the files.

If a file is listed in a drive but its contents are missing on this device, Atomic automatically tries to recover them when you open or display the file.
It asks connected devices first, then searches the encrypted files already stored in the drive's Vault if you are signed into its account and can unlock it.
Several previews requesting the same file share the recovery attempt.
Recovered bytes are verified against each file's hash. The drive keeps its current edits and history.
Recovery can only succeed if another device or the Vault has the contents. Missing previews retry when connectivity or the account changes; repeated failures have a short cooldown.
The native app also refreshes an open preview when a peer delivers the missing contents later, even if the first recovery attempt has timed out.
To check the whole drive or retry a failed recovery yourself, open *Storage and hosting* and choose *Recover missing files* under Cloud Vault. The action reports any files it could not recover and lets you retry or cancel.
Searching Vault can require downloading several encrypted files because their stored identifiers are private to that vault.

## What is special about it

Rights flow down the tree.
If you can edit a folder, you can edit what is in it, unless something below says otherwise.
Read more in [drives and permissions](../hierarchy.md).
Because a drive is just a tree of resources, you can back it up, move it to another server, or fetch it through the [API](../atomicserver/API.md).

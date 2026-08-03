import { CollectionBuilder, core, dataBrowser, type Store } from '@tomic/react';
import { getOrCreateContactsFolder } from '../../helpers/standardLocations';

/**
 * Default Address Book inside the Drive's Contacts folder. Created on first
 * Contact create when the caller didn't pick an Address Book parent.
 */
export async function getOrCreateDefaultAddressBook(
  store: Store,
  driveSubject: string,
): Promise<string> {
  const contactsFolder = await getOrCreateContactsFolder(store, driveSubject);

  const existing = await new CollectionBuilder(store)
    .setProperty(core.properties.parent)
    .setValue(contactsFolder)
    .addFilter({
      property: core.properties.isA,
      value: dataBrowser.classes.addressBook,
    })
    .setPageSize(1)
    .buildAndFetch();

  if (existing.totalMembers > 0) {
    const subject = await existing.getMemberWithIndex(0);

    if (subject) {
      return subject;
    }
  }

  const book = await store.newResource({
    parent: contactsFolder,
    isA: dataBrowser.classes.addressBook,
    propVals: { [core.properties.name]: /* @wc-ignore */ 'Contacts' },
  });
  await book.save();
  store.notifyResourceManuallyCreated(book);

  return book.subject;
}

/** Parent to use when creating a Contact from an arbitrary location. */
export async function resolveContactParent(
  store: Store,
  preferredParent?: string,
): Promise<string> {
  if (preferredParent) {
    const parent = await store.getResource(preferredParent);

    if (!parent.error && parent.hasClasses(dataBrowser.classes.addressBook)) {
      return preferredParent;
    }
  }

  const drive = store.getDrive();

  if (!drive) {
    if (preferredParent) {
      return preferredParent;
    }

    throw new Error('No drive available to place Contact');
  }

  return getOrCreateDefaultAddressBook(store, drive);
}

/** Parent to use when creating an Address Book. */
export async function resolveAddressBookParent(
  store: Store,
  preferredParent?: string,
): Promise<string> {
  const drive = store.getDrive();

  if (!drive) {
    if (preferredParent) {
      return preferredParent;
    }

    throw new Error('No drive available to place Address Book');
  }

  if (preferredParent && preferredParent !== drive) {
    return preferredParent;
  }

  return getOrCreateContactsFolder(store, drive);
}

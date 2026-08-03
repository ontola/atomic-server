import { core, dataBrowser, type JSONValue, type Store } from '@tomic/react';
import { CollectionBuilder } from '@tomic/react';
import type { ParsedVCard } from './vcf';

export type ImportVCardResult = {
  created: number;
  updated: number;
};

async function findContactByUid(
  store: Store,
  addressBook: string,
  uid: string,
): Promise<string | undefined> {
  const collection = await new CollectionBuilder(store)
    .setProperty(core.properties.parent)
    .setValue(addressBook)
    .setFilters([
      {
        property: core.properties.isA,
        value: dataBrowser.classes.contact,
      },
      {
        property: dataBrowser.properties.vcardUid,
        value: uid,
      },
    ])
    .setPageSize(1)
    .buildAndFetch();

  if (collection.totalMembers === 0) {
    return undefined;
  }

  return collection.getMemberWithIndex(0);
}

function cardToPropVals(card: ParsedVCard): Record<string, JSONValue> {
  const props: Record<string, JSONValue> = {
    [core.properties.name]: card.name,
  };

  if (card.givenName) props[dataBrowser.properties.givenName] = card.givenName;
  if (card.familyName)
    props[dataBrowser.properties.familyName] = card.familyName;
  if (card.organization)
    props[dataBrowser.properties.organization] = card.organization;
  if (card.jobTitle) props[dataBrowser.properties.jobTitle] = card.jobTitle;
  if (card.email) props[dataBrowser.properties.email] = card.email;
  if (card.telephone) props[dataBrowser.properties.telephone] = card.telephone;
  if (card.emails.length > 0)
    props[dataBrowser.properties.emails] = card.emails;
  if (card.telephones.length > 0)
    props[dataBrowser.properties.telephones] = card.telephones;
  if (card.addresses.length > 0)
    props[dataBrowser.properties.addresses] = card.addresses;
  if (card.website) props[dataBrowser.properties.website] = card.website;
  if (card.notes) props[core.properties.description] = card.notes;
  if (card.uid) props[dataBrowser.properties.vcardUid] = card.uid;

  return props;
}

/** Create or update Contact resources under an Address Book from parsed vCards. */
export async function importVCards(
  store: Store,
  addressBook: string,
  cards: ParsedVCard[],
): Promise<ImportVCardResult> {
  let created = 0;
  let updated = 0;

  for (const card of cards) {
    const propVals = cardToPropVals(card);
    const existingSubject = card.uid
      ? await findContactByUid(store, addressBook, card.uid)
      : undefined;

    if (existingSubject) {
      const resource = await store.getResource(existingSubject);

      for (const [prop, value] of Object.entries(propVals)) {
        await resource.set(prop, value);
      }

      await resource.save();
      updated += 1;
      continue;
    }

    const resource = await store.newResource({
      parent: addressBook,
      isA: dataBrowser.classes.contact,
      propVals,
    });
    await resource.save();
    store.notifyResourceManuallyCreated(resource);
    created += 1;
  }

  return { created, updated };
}

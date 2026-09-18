import { dataBrowser, core, classes, ai, canvas } from '@tomic/react';
import { registerBasicInstanceHandler } from '../useNewResourceUI';
import { DEFAULT_AICHAT_NAME } from '../../../AI/aiContstants';
import { getOrCreateMeetingsFolder } from '../../../../helpers/standardLocations';
import {
  resolveAddressBookParent,
  resolveContactParent,
} from '../../../../views/Contacts/contactLocations';

/**
 * These handlers do not show any UI / inputs when creating new instances.
 * This is where they can have hardcoded default values or custom logic.
 */
export const registerBasicInstanceHandlers = () => {
  registerBasicInstanceHandler(
    dataBrowser.classes.folder,
    async (parent, createAndNavigate) => {
      await createAndNavigate(
        dataBrowser.classes.folder,
        {
          [core.properties.name]: 'Folder',
          [dataBrowser.properties.displayStyle]: classes.displayStyles.list,
        },
        {
          parent,
        },
      );
    },
  );

  registerBasicInstanceHandler(
    dataBrowser.classes.chatroom,
    async (parent, createAndNavigate) => {
      await createAndNavigate(
        dataBrowser.classes.chatroom,
        {
          [core.properties.name]: 'ChatRoom',
        },
        {
          parent,
        },
      );
    },
  );

  registerBasicInstanceHandler(
    dataBrowser.classes.document,
    async (parent, createAndNavigate) => {
      createAndNavigate(
        dataBrowser.classes.document,
        {
          [core.properties.name]: 'Document',
        },
        {
          parent,
        },
      );
    },
  );

  registerBasicInstanceHandler(
    dataBrowser.classes.documentV2,
    async (parent, createAndNavigate) => {
      createAndNavigate(
        dataBrowser.classes.documentV2,
        {
          [core.properties.name]: 'Document',
        },
        {
          parent,
        },
      );
    },
  );

  registerBasicInstanceHandler(
    dataBrowser.classes.meeting,
    async (parent, createAndNavigate, { store }) => {
      const drive = store.getDrive();
      const meetingsFolder = drive
        ? await getOrCreateMeetingsFolder(store, drive)
        : parent;

      await createAndNavigate(
        dataBrowser.classes.meeting,
        { [core.properties.name]: 'Meeting' },
        { parent: meetingsFolder },
      );
    },
  );

  registerBasicInstanceHandler(
    dataBrowser.classes.addressBook,
    async (parent, createAndNavigate, { store }) => {
      const bookParent = await resolveAddressBookParent(store, parent);

      await createAndNavigate(
        dataBrowser.classes.addressBook,
        { [core.properties.name]: 'Address Book' },
        { parent: bookParent },
      );
    },
  );

  registerBasicInstanceHandler(
    dataBrowser.classes.contact,
    async (parent, createAndNavigate, { store }) => {
      const contactParent = await resolveContactParent(store, parent);

      await createAndNavigate(
        dataBrowser.classes.contact,
        { [core.properties.name]: 'Contact' },
        { parent: contactParent },
      );
    },
  );

  registerBasicInstanceHandler(
    canvas.classes.canvas,
    async (parent, createAndNavigate) => {
      await createAndNavigate(
        canvas.classes.canvas,
        {
          [core.properties.name]: 'Canvas',
        },
        {
          parent,
        },
      );
    },
  );

  registerBasicInstanceHandler(
    ai.classes.aiChat,
    async (parent, createAndNavigate) => {
      await createAndNavigate(
        ai.classes.aiChat,
        {
          [core.properties.name]: DEFAULT_AICHAT_NAME,
        },
        {
          parent,
        },
      );
    },
  );
};

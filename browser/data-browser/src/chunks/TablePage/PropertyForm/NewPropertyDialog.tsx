import {
  Core,
  Datatype,
  Resource,
  Store,
  core,
  dataBrowser,
  server,
  useArray,
  useStore,
} from '@tomic/react';
import { useCallback, useEffect, type JSX } from 'react';
import { randomString } from '@helpers/randomString';
import { stringToSlug } from '@helpers/stringToSlug';
import { PropertyFormCategory } from './categories';
import { sortSubjectList } from '@views/OntologyPage/sortSubjectList';

interface NewPropertyDialogProps {
  showDialog: boolean;
  tableClassResource: Resource<Core.Class>;
  bindShow: React.Dispatch<boolean>;
  selectedCategory?: string;
}

const createSubjectWithBase = (base: string) => {
  const sepperator = base.endsWith('/') ? '' : '/';

  return `${base}${sepperator}property-${randomString(8)}`;
};

const populatePropertyWithDefaults = async (
  property: Resource,
  tableClass: Resource<Core.Class>,
  name: string,
) => {
  await property.set(core.properties.isA, [core.classes.property]);
  await property.set(core.properties.parent, tableClass.props.parent);
  await property.set(core.properties.shortname, stringToSlug(name), false);
  await property.set(core.properties.name, name, false);
  await property.set(core.properties.description, '');
  await property.set(core.properties.datatype, Datatype.STRING);
};

const applyCategoryDefaults = async (
  category: PropertyFormCategory | undefined,
  resource: Resource,
) => {
  switch (category) {
    case 'number':
      await resource.set(core.properties.datatype, Datatype.INTEGER);
      break;
    case 'date':
      await resource.set(core.properties.datatype, Datatype.DATE);
      break;
    case 'checkbox':
      await resource.set(core.properties.datatype, Datatype.BOOLEAN);
      break;
    case 'file':
      await resource.set(core.properties.datatype, Datatype.ATOMIC_URL);
      await resource.set(core.properties.classtype, server.classes.file);
      break;
    case 'json':
      await resource.set(core.properties.datatype, Datatype.JSON);
      break;
    case 'select':
      await resource.set(core.properties.datatype, Datatype.RESOURCEARRAY);
      await resource.set(core.properties.classtype, dataBrowser.classes.tag);
      await resource.addClasses(dataBrowser.classes.selectProperty);
      break;
    case 'relation':
      await resource.set(core.properties.datatype, Datatype.ATOMIC_URL);
      break;
    case 'text':
    default:
      // STRING is already set in populatePropertyWithDefaults
      break;
  }
};

const getChildren = (store: Store, resource: Resource) =>
  store.clientSideQuery(
    res => res.get(core.properties.parent) === resource?.subject,
  );

const saveChildren = async (store: Store, resource: Resource) => {
  const children = getChildren(store, resource);
  await Promise.all(children.map(child => child.save()));
};

export function NewPropertyDialog({
  showDialog,
  selectedCategory,
  tableClassResource,
  bindShow,
}: NewPropertyDialogProps): JSX.Element {
  const store = useStore();
  const [_properties, _setProperties, pushProp] = useArray(
    tableClassResource,
    core.properties.recommends,
    {
      commit: true,
    },
  );

  const savePropertyToTable = useCallback(
    async (prop: Resource) => {
      const tableClassParent = await store.getResource(
        tableClassResource.props.parent,
      );

      if (tableClassParent.hasClasses(core.classes.ontology)) {
        await prop.set(core.properties.parent, tableClassParent.subject);

        const ontologyProps =
          tableClassParent.get(core.properties.properties) ?? [];

        await tableClassParent.set(
          core.properties.properties,
          await sortSubjectList(store, [...ontologyProps, prop.subject]),
        );

        await tableClassParent.save();
      }

      await prop.save();
      await saveChildren(store, prop);
      pushProp([prop.subject]);
    },
    [store, tableClassResource, pushProp],
  );

  useEffect(() => {
    if (!showDialog) return;

    const create = async () => {
      const subject = createSubjectWithBase(tableClassResource.subject);
      const propertyResource = store.getResourceLoading(subject, {
        newResource: true,
      });

      const name = selectedCategory ?? 'column';
      await populatePropertyWithDefaults(
        propertyResource,
        tableClassResource,
        name,
      );
      await applyCategoryDefaults(
        selectedCategory as PropertyFormCategory,
        propertyResource,
      );
      await savePropertyToTable(propertyResource);
      bindShow(false);
    };

    create().catch(console.error);
  }, [showDialog]);

  return <></>;
}

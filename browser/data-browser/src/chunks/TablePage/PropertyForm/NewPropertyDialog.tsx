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
import { stringToSlug } from '@helpers/stringToSlug';
import { PropertyFormCategory } from './categories';
import { sortSubjectList } from '@views/OntologyPage/sortSubjectList';

interface NewPropertyDialogProps {
  showDialog: boolean;
  tableClassResource: Resource<Core.Class>;
  bindShow: React.Dispatch<boolean>;
  selectedCategory?: string;
}

/** Returns the isA classes and propVals for a given category, for inclusion in the genesis commit. */
const getCategoryGenesisPropVals = (
  category: PropertyFormCategory | undefined,
): { isA: string | string[]; propVals: Record<string, unknown> } => {
  switch (category) {
    case 'number':
      return { isA: core.classes.property, propVals: { [core.properties.datatype]: Datatype.INTEGER } };
    case 'date':
      return { isA: core.classes.property, propVals: { [core.properties.datatype]: Datatype.DATE } };
    case 'checkbox':
      return { isA: core.classes.property, propVals: { [core.properties.datatype]: Datatype.BOOLEAN } };
    case 'file':
      return { isA: core.classes.property, propVals: { [core.properties.datatype]: Datatype.ATOMIC_URL, [core.properties.classtype]: server.classes.file } };
    case 'json':
      return { isA: core.classes.property, propVals: { [core.properties.datatype]: Datatype.JSON } };
    case 'select':
      return {
        isA: [core.classes.property, dataBrowser.classes.selectProperty],
        propVals: {
          [core.properties.datatype]: Datatype.RESOURCEARRAY,
          [core.properties.classtype]: dataBrowser.classes.tag,
          [core.properties.allowsOnly]: [],
        },
      };
    case 'relation':
      return { isA: core.classes.property, propVals: { [core.properties.datatype]: Datatype.ATOMIC_URL } };
    case 'text':
    default:
      return { isA: core.classes.property, propVals: { [core.properties.datatype]: Datatype.STRING } };
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
      // Determine the correct parent before signing the genesis commit, since
      // the parent is baked into the commit and controls authorization.
      const tableClassParent = await store.getResource(
        tableClassResource.props.parent,
      );
      const parentSubject = tableClassParent.hasClasses(core.classes.ontology)
        ? tableClassParent.subject
        : tableClassResource.subject;

      const name = selectedCategory ?? 'column';
      const { isA, propVals } = getCategoryGenesisPropVals(
        selectedCategory as PropertyFormCategory,
      );

      const propertyResource = await store.newResource({
        parent: parentSubject,
        isA,
        propVals: {
          [core.properties.shortname]: stringToSlug(name),
          [core.properties.name]: name,
          [core.properties.description]: '',
          ...propVals,
        },
      });
      await savePropertyToTable(propertyResource);
      bindShow(false);
    };

    create().catch(console.error);
  }, [showDialog]);

  return <></>;
}

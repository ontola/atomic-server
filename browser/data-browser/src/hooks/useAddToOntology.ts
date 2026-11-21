import {
  Resource,
  useResource,
  useStore,
  Server,
  unknownSubject,
  core,
  Core,
} from '@tomic/react';
import { useSettings } from '../helpers/AppSettings';
import { useCallback } from 'react';
import toast from 'react-hot-toast';
import { isContentAddressed } from '@tomic/resource-ui/helpers/propertyIdentity';
import { sortSubjectList } from '@tomic/resource-ui/views/OntologyPage/sortSubjectList';

export function useAddToOntology(ontologySubject?: string) {
  const store = useStore();
  const { drive: driveSubject } = useSettings();
  const drive = useResource<Server.Drive>(driveSubject);

  const targetSubject = useResource<Core.Ontology>(
    ontologySubject ?? drive.props.defaultOntology ?? unknownSubject,
  ).subject;

  return useCallback(
    async (resource: Resource) => {
      const hasResolvedOntologySubject =
        targetSubject !== unknownSubject &&
        !targetSubject.startsWith('internal:') &&
        !targetSubject.includes('unknown-subject');

      // The parent of a content-addressed property is part of its ID, so it
      // is never re-parented: it can only be listed in the ontology it
      // already belongs to.
      const fixedParent = isContentAddressed(resource.subject);
      const currentParent = resource.get(core.properties.parent);

      if (fixedParent && currentParent !== targetSubject) {
        toast.error("A property can't be moved to another ontology.");

        return;
      }

      if (!hasResolvedOntologySubject) {
        if (fixedParent) {
          return;
        }

        await resource.set(core.properties.parent, driveSubject);
        await resource.save();

        return;
      }

      // A rendered resource can still be a query projection. An edit needs
      // the stored Loro history behind that projection before reading the list.
      const ontology = await store.getResource<Core.Ontology>(targetSubject);
      if (ontology.error) throw ontology.error;

      if (!fixedParent) {
        await resource.set(core.properties.parent, ontology.subject);
        await resource.save();
      }

      if (resource.hasClasses(core.classes.class)) {
        await ontology.set(
          core.properties.classes,
          await sortSubjectList(store, [
            ...(ontology.props.classes ?? []),
            resource.subject,
          ]),
        );
      } else if (resource.hasClasses(core.classes.property)) {
        await ontology.set(
          core.properties.properties,
          await sortSubjectList(store, [
            ...(ontology.props.properties ?? []),
            resource.subject,
          ]),
        );
      } else {
        ontology.push(core.properties.instances, [resource.subject], true);
      }

      await ontology.save();
    },
    [store, driveSubject, targetSubject],
  );
}

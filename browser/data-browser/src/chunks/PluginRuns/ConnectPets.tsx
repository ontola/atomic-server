import { useState } from 'react';
import {
  core,
  dataBrowser,
  ensureSchema,
  executeServerPlugin,
  useStore,
  type Resource,
} from '@tomic/react';
import { Button } from '@components/Button';
import { Column } from '@components/Row';
import { ErrMessage } from '@components/forms/InputStyles';
import { AtomicLink } from '@components/AtomicLink';
import { petsSchema } from '../../../../../integrations/pets/schema';
import type { Config } from '../../../../../integrations/pets/plugin';
import { fetchIntegrationSource } from '@helpers/integrationSource';
import { pluginClassesFor } from './runScript';
import { ensureInstallationResource } from './installationResources';
import { RunPluginDialog } from './RunPluginDialog';

/**
 * A trivial demo connection: five static pets, no account or API key. Exists
 * to exercise the touch points a real API plugin needs (ontology, install,
 * sandboxed run, review) with nothing else in the way.
 */
export function ConnectPets({ drive }: { drive: string }) {
  const store = useStore();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [instance, setInstance] = useState<{
    resource: Resource;
    config: Config;
  }>();
  const [verdict, setVerdict] = useState<string>();
  const [imported, setImported] = useState(false);

  const install = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    setImported(false);

    try {
      // The bundle and the drive's plugin ontology have nothing to do with each
      // other, so fetching one while the other resolves costs nothing and saves
      // a round trip in front of a spinner.
      const [source, pluginTerms] = await Promise.all([
        fetchIntegrationSource('pets'),
        pluginClassesFor(store, drive),
      ]);
      // Installation resources and the Pets ontology are independent too: the
      // plugin resource lives in the drive, the terms in its ontology. Only the
      // table below needs both. Two `ensureSchema` calls must not overlap — they
      // write the same ontology list — which is why this one waits for
      // `pluginClassesFor` above but not for the installation resource.
      const [resource, terms] = await Promise.all([
        ensureInstallationResource(store, drive, {
          parent: drive,
          localId: 'atomic:pets:installation',
          isA: [pluginTerms.classes['plugin-script']],
          propVals: {
            [core.properties.name]: 'Pets',
            [dataBrowser.properties.emoji]: '🐾',
            [pluginTerms.properties['plugin-source']]: source,
            [pluginTerms.properties['plugin-schemas']]: {},
            [pluginTerms.properties.trigger]: 'manual',
          },
        }),
        ensureSchema(store, drive, petsSchema()),
      ]);
      const subject = resource.subject;
      const table = await ensureInstallationResource(store, drive, {
        parent: subject,
        localId: 'atomic:pets:table',
        isA: [dataBrowser.classes.table],
        propVals: {
          [core.properties.name]: 'Pets',
          [core.properties.classtype]: terms.classes.pet,
        },
      });
      const view = await ensureInstallationResource(store, drive, {
        parent: table.subject,
        localId: 'atomic:pets:default-view',
        isA: [dataBrowser.classes.view],
        propVals: {
          [core.properties.name]: 'Pets',
          [dataBrowser.properties.viewKind]: 'table',
          [dataBrowser.properties.viewColumns]: [
            core.properties.name,
            ...['pet-species', 'pet-breed', 'pet-age', 'pet-mood'].map(
              key => terms.properties[key],
            ),
          ],
        },
      });
      await table.set(dataBrowser.properties.tableViews, [view.subject]);
      await table.set(dataBrowser.properties.tableDefaultView, view.subject);
      await table.save();
      const config = {
        table: table.subject,
        rowClass: terms.classes.pet,
        properties: terms.properties,
      };
      await resource.set(pluginTerms.properties['plugin-schemas'], {
        pets: config,
      });
      await resource.save();
      setInstance({ resource, config });
      const result = await executeServerPlugin(store, {
        drive,
        plugin: resource.subject,
        source,
        input: {
          config,
          trigger: {
            kind: 'manual',
            at: Date.now(),
            subject: resource.subject,
          },
        },
      });
      if (result.error || !result.verdict)
        throw new Error(result.error ?? 'The importer returned no preview.');
      setVerdict(result.verdict);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Column gap='0.75rem'>
      <p>
        Installs five trivial demo pets into a Pets table. No external account,
        API key or network call is used.
      </p>
      <Button disabled={busy} onClick={install}>
        {busy
          ? 'Setting up…'
          : instance
            ? 'Reinstall demo pets'
            : 'Install demo pets'}
      </Button>
      {error && <ErrMessage role='alert'>{error}</ErrMessage>}
      {imported && instance && (
        <AtomicLink subject={instance.config.table}>Open Pets</AtomicLink>
      )}
      {verdict && instance && (
        <RunPluginDialog
          resource={instance.resource}
          drive={drive}
          show
          verdict={verdict}
          triggerKind='manual'
          onShowChange={open => {
            if (!open) setVerdict(undefined);
          }}
          onReviewed={() => {
            setImported(true);
            setVerdict(undefined);
          }}
        />
      )}
    </Column>
  );
}

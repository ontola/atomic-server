import {
  createEffect,
  createSignal,
  ErrorBoundary,
  For,
  Match,
  Switch,
  type JSX,
  type ParentProps,
} from 'solid-js';
import { useAtomicContext } from './AtomicContext';
import styles from './main.module.css';
import { core, dataBrowser, type Resource } from '@tomic/plugin';

const FAVORITE_FOLDER =
  'https://atomicdata.dev/01k10mtpp8fkkmsd6tkm9qrqyw/defaultontology/property/favorite-folder';
const CHARACTERISTICS =
  'https://atomicdata.dev/01k10mtpp8fkkmsd6tkm9qrqyw/defaultontology/property/characteristics';

export const App = () => {
  const { client, resource } = useAtomicContext();

  const description = () =>
    resource().props[core.properties.description] as string;
  const [descriptionEdit, setDescriptionEdit] = createSignal(description());

  const favoriteFolder = useResource(
    () => resource().props[FAVORITE_FOLDER] as string,
  );

  const characteristics = () =>
    (resource().props[CHARACTERISTICS] || []) as string[];

  const pickResource = async () => {
    try {
      const folder = await client.pickResource({
        isA: dataBrowser.classes.folder,
        title: 'Select a folder',
        message: "Pick the bird's favorite folder",
      });

      if (!folder) return;

      client.commit({
        subject: resource().subject,
        set: {
          [FAVORITE_FOLDER]: folder.subject,
        },
      });
    } catch (error) {
      console.error(error);
    }
  };

  const saveDescription = () => {
    client.commit({
      subject: resource().subject,
      set: { [core.properties.description]: descriptionEdit() },
    });
  };

  createEffect(() => {
    if (descriptionEdit() === undefined && !resource().loading) {
      setDescriptionEdit(description());
    }
  });

  return (
    <ErrorBoundary fallback={error => <div>Error: {error.message}</div>}>
      <Loader resource={resource()}>
        <div class={styles.container}>
          <h1>{resource().title}</h1>
          <p>This is a custom view for the Bird class.</p>
          <textarea
            placeholder="Enter a description..."
            value={descriptionEdit() ?? ''}
            onInput={e => setDescriptionEdit(e.target.value)}
          />
          <button onClick={saveDescription} class="atomic-button">
            Save
          </button>
          <h2>Characteristics</h2>
          <For each={characteristics()}>
            {characteristic => <Characteristic subject={characteristic} />}
          </For>
          <div>{favoriteFolder().title}</div>
          <button onClick={pickResource} class="atomic-button">
            Select favorite folder
          </button>
        </div>
      </Loader>
    </ErrorBoundary>
  );
};

const Characteristic = (props: { subject: string }) => {
  const resource = useResource(() => props.subject);

  return (
    <Loader resource={resource()}>
      <div class={styles.tag}>{resource().title}</div>
    </Loader>
  );
};

const useResource = (subject: () => string | undefined) => {
  const { client } = useAtomicContext();
  const [resource, setResource] = createSignal<Resource>({
    subject: subject() ?? 'unknownSubject',
    title: '',
    loading: true,
    props: {},
  });

  createEffect(() => {
    const sub = subject();
    if (sub === undefined) return;

    client.getResource(sub).then(setResource);
    return client.subscribe(sub, setResource);
  });

  return resource;
};

const Loader = (
  props: ParentProps<{ resource: Resource; fallback?: JSX.Element }>,
) => {
  return (
    <Switch>
      <Match when={props.resource.loading}>
        {props.fallback ?? <div>Loading...</div>}
      </Match>
      <Match when={!props.resource.loading}>{props.children}</Match>
    </Switch>
  );
};

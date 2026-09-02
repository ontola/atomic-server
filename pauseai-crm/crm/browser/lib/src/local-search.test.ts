import { describe, it } from 'vitest';
import { LocalSearch } from './local-search.js';
import { core } from './ontologies/core.js';
import { Resource } from './resource.js';

async function resource(subject: string, parent: string, name: string) {
  const item = new Resource(subject);
  await item.set(core.properties.parent, parent, false);
  await item.set(core.properties.name, name, false);
  item.loading = false;

  return item;
}

describe('LocalSearch', () => {
  it('filters matches to descendants of a parent scope', async ({ expect }) => {
    const search = new LocalSearch();
    const drive = 'did:ad:drive';
    const saladFolder = 'did:ad:salad-folder';
    const cakeFolder = 'did:ad:cake-folder';
    const nestedFolder = 'did:ad:nested-folder';
    const salad = 'did:ad:avocado-salad';
    const cake = 'did:ad:avocado-cake';

    for (const item of [
      await resource(saladFolder, drive, 'Salad folder'),
      await resource(cakeFolder, drive, 'Cake folder'),
      await resource(nestedFolder, cakeFolder, 'Nested folder'),
      await resource(salad, saladFolder, 'Avocado Salad'),
      await resource(cake, nestedFolder, 'Avocado Cake'),
    ]) {
      search.addResource(item, drive);
    }

    expect(search.search('Avocado', drive).subjects).toEqual([salad, cake]);
    expect(search.search('Avocado', drive, 30, cakeFolder).subjects).toEqual([
      cake,
    ]);
  });
});

import { core } from "./ontologies/core.js";
import { dataBrowser } from "./ontologies/dataBrowser.js";
import { server } from "./ontologies/server.js";

const aliases: Record<string, string> = {
  file: server.classes.file,
  folder: dataBrowser.classes.folder,
  document: dataBrowser.classes.documentV2,
  documentv2: dataBrowser.classes.documentV2,
  meeting: dataBrowser.classes.meeting,
  class: core.classes.class,
  property: core.classes.property,
  table: dataBrowser.classes.table,
};

/**
 * Case, spaces, dashes and underscores do not matter: models write the class
 * as `document-v2`, `documentV2`, `Document V2` or `DocumentV2`.
 */
const normalize = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");

export const standardClassAlias = (name: string): string | undefined => {
  const key = normalize(name);

  return Object.hasOwn(aliases, key) ? aliases[key] : undefined;
};

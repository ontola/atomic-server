export const usage = `
ad-generate <command>

Commands:
  ontologies  Generates typescript files for ontologies specified in the config file.
  schema      Registers or publishes a code-first schema module.
  init        Creates a template config file.

Schema command:
  ad-generate schema ./schema.js [--export schemaName] [--local] [--add-to-config] [--generate] [--lock]

  --lock  Write a committed *.schema.lock.json (the self-verifying, shareable frozen artifact).
`;

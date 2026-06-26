// [2026-06-02T12:12:15]
export interface FrozenStructure {
  /** The root resource's frozen id. */
  root: FrozenId;
  /** Original subject -> frozen id, for every resource included. */
  bySubject: Record<string, FrozenId>;
  /** Frozen id -> identity JSON-AD body (what a consumer re-hashes and materializes). */
  frozen: Record<string, FrozenJsonValue>;
}

// [2026-06-02T12:12:15]
export interface FreezeStructureOptions {
  /**
   * Follow value references to other already-loaded resources, freezing the
   * whole structure (e.g. an Ontology + its Classes + Properties). Defaults to
   * true; set false to freeze only the root resource.
   */
  closure?: boolean;
  /** Also publish each frozen body to `/frozen` on the server. Defaults to false. */
  save?: boolean;
}

// [2026-06-02T12:12:15]
export interface RegisterSchemaOptions {
  /** Save generated resources through the normal Commit/outbox path. */
  save?: boolean;
}

// [2026-06-02T10:40:57]
export interface RegisteredSchema {
  ontology: Resource<Core.Ontology>;
  classes: Record<string, Resource<Core.Class>>;
  properties: Record<string, Resource<Core.Property>>;
  model: ConvertedSchemaPackage;
}
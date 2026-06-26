  public async registerSchema(
    schema: AtomicSchemaPackage | DefinedSchema,
    opts: RegisterSchemaOptions = {},
  ): Promise<RegisteredSchema> {
    const model = schemaToOntologyModel(schema);

    await this.validateSchemaImports(model.ontology.jsonSchema);

    const ontology = await this.newResource<Core.Ontology>({
      isA: core.classes.ontology,
      validatePropVals: false,
      propVals: {
        [core.properties.shortname]: stringToSlug(model.ontology.shortname),
        [core.properties.description]: model.ontology.description,
        [core.properties.classes]: [],
        [core.properties.properties]: [],
        [core.properties.instances]: [],
      },
    });

    const properties: Record<string, Resource<Core.Property>> = {};

    for (const property of model.properties) {
      this.assertCompatibleExistingSchemaProperty(property);

      const resource = await this.newResource<Core.Property>({
        subject: property.subject,
        parent: ontology.subject,
        isA: core.classes.property,
        validatePropVals: false,
        propVals: {
          [core.properties.shortname]: property.shortname,
          [core.properties.description]: property.description,
          [core.properties.datatype]: property.datatype,
          ...(property.classType
            ? { [core.properties.classtype]: property.classType }
            : {}),
          ...(property.allowsOnly
            ? { [core.properties.allowsOnly]: property.allowsOnly as string[] }
            : {}),
          ...(property.isDynamic !== undefined
            ? { [core.properties.isDynamic]: property.isDynamic }
            : {}),
          ...(property.isLocked !== undefined
            ? { [core.properties.isLocked]: property.isLocked }
            : {}),
        },
      });

      properties[property.key] = resource;
    }

    const classes: Record<string, Resource<Core.Class>> = {};

    for (const klass of model.classes) {
      const requires = await Promise.all(
        klass.requires.map(key =>
          this.resolveRegisteredSchemaPropertyKey(
            key,
            model.ontology.jsonSchema,
            properties,
          ),
        ),
      );
      const recommends = await Promise.all(
        klass.recommends.map(key =>
          this.resolveRegisteredSchemaPropertyKey(
            key,
            model.ontology.jsonSchema,
            properties,
          ),
        ),
      );
      const resource = await this.newResource<Core.Class>({
        subject: klass.subject,
        parent: ontology.subject,
        isA: core.classes.class,
        validatePropVals: false,
        propVals: {
          [core.properties.shortname]: klass.shortname,
          [core.properties.description]: klass.description,
          [core.properties.requires]: requires,
          [core.properties.recommends]: recommends,
        },
      });

      classes[klass.key] = resource;
    }

    await ontology.set(
      core.properties.classes,
      Object.values(classes).map(resource => resource.subject),
      false,
    );
    await ontology.set(
      core.properties.properties,
      Object.values(properties).map(resource => resource.subject),
      false,
    );
    await ontology.set(
      server.properties.jsonSchema,
      model.ontology.jsonSchema as unknown as JSONValue,
      false,
    );
    await ontology.set(SCHEMA_HASH_PROPERTY, model.ontology.schemaHash, false);

    if (model.ontology.version) {
      await ontology.set(
        server.properties.version,
        model.ontology.version,
        false,
      );
    }

    this.schemaHashIndex.set(model.ontology.schemaHash, ontology.subject);

    if (opts.save) {
      await ontology.save();

      for (const property of Object.values(properties)) {
        await property.save();
      }

      for (const klass of Object.values(classes)) {
        await klass.save();
      }
    }

    return {
      ontology,
      classes,
      properties,
      model,
    };
  }

  public getRegisteredSchemaSubject(schemaHash: string): string | undefined {
    return this.schemaHashIndex.get(schemaHash);
  }

/*__GAP_1834__*/
/*__GAP_1835__*/
/*__GAP_1836__*/
/*__GAP_1837__*/
/*__GAP_1838__*/
/*__GAP_1839__*/
/*__GAP_1840__*/
/*__GAP_1841__*/
/*__GAP_1842__*/
  public async registerFrozenSchema(
    schema: AtomicSchemaPackage | DefinedSchema,
    opts: RegisterSchemaOptions = {},
  ): Promise<FrozenSchema> {
    const frozen = freezeSchema(schema);

    for (const { frozenId, content } of frozen.resources) {
      const [resource] = new JSONADParser().parse(content, frozenId);
      resource.loading = false;
      this.addResource(resource, { skipCommitCompare: true });
    }

    if (opts.save) {
      await Promise.all(
        frozen.resources.map(({ frozenId, content }) =>
          this.publishFrozenResource(frozenId, content),
        ),
      );
    }

    return frozen;
  }

  /**
   * Creates the mutable, signed "latest version" pointer for a frozen schema: a
   * normal Ontology resource (genesis DID) on the author's drive whose
   * `classes`/`properties` point at the immutable frozen ids. Its stable subject
   * is the durable name ("the current TodoApp"), and its signed commit history is
   * the version log — re-running this when the schema changes records a new
   * version while old frozen ids stay permanently resolvable. With
   * `{ save: true }` it is signed and committed.
   */
  public async createSchemaPointer(
    frozen: FrozenSchema,
    opts: { parent?: string; save?: boolean } = {},
  ): Promise<Resource<Core.Ontology>> {
    const version = frozen.presentation.ontology.version;
    const ontology = await this.newResource<Core.Ontology>({
      parent: opts.parent,
      isA: core.classes.ontology,
      validatePropVals: false,
      propVals: {
        [core.properties.shortname]: stringToSlug(
          frozen.model.ontology.shortname,
        ),
        [core.properties.description]: frozen.presentation.ontology.description,
        [core.properties.classes]: Object.values(frozen.classes) as string[],
        [core.properties.properties]: Object.values(
          frozen.properties,
        ) as string[],
        [core.properties.instances]: [],
        ...(version ? { [server.properties.version]: version } : {}),
      },
    });

    if (opts.save) {
      await ontology.save();
    }

    return ontology;
  }

  /**
   * Freezes a resource — and, by default, the structure it references — into
   * immutable, content-addressed `did:ad:frozen` JSON-AD. Generic: works on any
   * resource (Ontology, Document, Folder, …), not just schemas. References
   * between included resources are rewritten to frozen ids; references outside
   * the structure (core schema, drives, agents) stay as their normal subjects.
   * Hierarchy/server metadata (`parent`, `lastCommit`, `localId`) is stripped.
   * With `{ save: true }` each frozen body is published to `/frozen`.
   */
  public async freezeStructure(
    subject: string,
    opts: FreezeStructureOptions = {},
  ): Promise<FrozenStructure> {
    const { closure = true, save = false } = opts;
    const root = await this.getResource(subject);

    if (root.error) {
      throw new Error(`Cannot freeze ${subject}: ${root.error}`);
    }

    const bodies = new Map<string, FrozenJsonValue>();
    const queue: string[] = [subject];

    while (queue.length > 0) {
      const current = queue.shift()!;

      if (bodies.has(current)) {
        continue;
      }

      const resource =
        current === subject ? root : this.resources.get(current);

      if (!resource || !resource.isReady()) {
        continue;
      }

      const body = this.frozenBodyOf(resource);
      bodies.set(current, body);

      if (closure) {
        for (const ref of this.structureReferences(body)) {
          if (!bodies.has(ref) && this.isFreezableResource(ref)) {
            queue.push(ref);
          }
        }
      }
    }

    const freezable: FreezableResource[] = [...bodies].map(
      ([localId, content]) => ({ localId, content }),
    );
    const { resources, byLocalId } = freezeResources(freezable);

    const rootId = byLocalId.get(subject);

    if (!rootId) {
      throw new Error(`Freezing produced no id for ${subject}`);
    }

    if (save) {
      await Promise.all(
        resources.map(resource =>
          this.publishFrozenResource(resource.frozenId, resource.content),
        ),
      );
    }

    return {
      root: rootId,
      bySubject: Object.fromEntries(byLocalId),
      frozen: Object.fromEntries(
        resources.map(resource => [resource.frozenId, resource.content]),
      ),
    };
  }

  /** A resource's propvals as a frozen body — strips subject and mutable metadata. */
  private frozenBodyOf(resource: Resource): FrozenJsonValue {
    const strip = new Set<string>([
      core.properties.parent,
      'https://atomicdata.dev/properties/lastCommit',
      core.properties.localId,
    ]);
    const body: Record<string, FrozenJsonValue> = {};

    for (const [key, value] of resource.getEntries()) {
      if (strip.has(key) || value instanceof Uint8Array) {
        continue;
      }

      body[key] = value as FrozenJsonValue;
    }

    return body;
  }

  /** Subjects referenced by `body` that are already loaded resources. */
  private structureReferences(body: FrozenJsonValue): string[] {
    const out: string[] = [];

    const walk = (value: FrozenJsonValue): void => {
      if (typeof value === 'string') {
        if (this.resources.has(value)) {
          out.push(value);
        }
      } else if (Array.isArray(value)) {
        value.forEach(walk);
      } else if (value !== null && typeof value === 'object') {
        Object.values(value).forEach(walk);
      }
    };

    walk(body);

    return out;
  }

  /** Whether a referenced subject should be pulled into a frozen structure. */
  private isFreezableResource(subject: string): boolean {
    if (
      subject.startsWith('https://atomicdata.dev/') ||
      subject.startsWith('did:ad:agent:') ||
      subject.startsWith('did:ad:commit:') ||
      subject.startsWith('did:ad:frozen:') ||
      subject.startsWith('did:ad:blob:')
    ) {
      return false;
    }

    const resource = this.resources.get(subject);

    return (
      !!resource &&
      resource.isReady() &&
      !resource.hasClasses(server.classes.drive)
    );
  }

  /**
   * Registers an app-bundled `*.schema.lock.json` into the store: verifies every
   * frozen object by re-hash, then materializes each as a read-only Resource so
   * the schema resolves offline with no server. This is "available without a
   * host" — the lockfile travels with the code, and a frozen id is reproducible
   * from it. Returns the lock so callers can read its id maps. Cycle "unit"
   * objects are skipped (not yet individually materializable).
   */
  public loadSchemaLock(lock: SchemaLock): SchemaLock {
    const verification = verifySchemaLock(lock);

    if (!verification.ok) {
      throw new Error(
        `Refusing to load an invalid schema lock: ${verification.errors.join('; ')}`,
      );
    }

    for (const [frozenId, content] of Object.entries(lock.frozen)) {
      if (
        content &&
        typeof content === 'object' &&
        UNIT_MEMBERS_KEY in content
      ) {
        continue;
      }

      const [resource] = new JSONADParser().parse(content, frozenId);
      resource.loading = false;
      this.addResource(resource, { skipCommitCompare: true });
    }

    return lock;
  }

  private async publishFrozenResource(
    frozenId: FrozenId,
    content: unknown,
  ): Promise<void> {
    const hash = frozenId.replace('did:ad:frozen:', '');
    const base = this.getServerUrl().replace(/\/$/, '');
    const response = await fetch(`${base}/frozen/${hash}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/ad+json' },
      body: jcsCanonicalize(content as Parameters<typeof jcsCanonicalize>[0]),
    });

    if (!response.ok) {
      throw new Error(
        `Failed to publish frozen resource ${frozenId} (HTTP ${response.status})`,
      );
    }
  }

  private assertCompatibleExistingSchemaProperty(
    property: ConvertedSchemaPackage['properties'][number],
  ): void {
    if (!property.subject) {
      return;
    }

    const existing = this.resources.get(property.subject);

    if (!existing?.isReady() || !existing.hasClasses(core.classes.property)) {
      return;
    }

    const checks: Array<
      [string, JSONValue | undefined, JSONValue | undefined]
    > = [
      [
        core.properties.datatype,
        existing.get(core.properties.datatype),
        property.datatype,
      ],
      [
        core.properties.classtype,
        existing.get(core.properties.classtype),
        property.classType,
      ],
      [
        core.properties.allowsOnly,
        existing.get(core.properties.allowsOnly),
        property.allowsOnly as JSONValue | undefined,
      ],
    ];

    for (const [field, actual, expected] of checks) {
      if (JSON.stringify(actual ?? null) !== JSON.stringify(expected ?? null)) {
/*__GAP_2132__*/
/*__GAP_2133__*/
/*__GAP_2134__*/
/*__GAP_2135__*/
/*__GAP_2136__*/
/*__GAP_2137__*/
/*__GAP_2138__*/
/*__GAP_2139__*/
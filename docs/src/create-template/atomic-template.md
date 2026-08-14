# @tomic/template

```sh
npm create @tomic/template my-project -- --template <TEMPLATE> --server-url <SERVER_URL> --drive <DRIVE_SUBJECT>
pnpm create @tomic/template my-project --template <TEMPLATE> --server-url <SERVER_URL> --drive <DRIVE_SUBJECT>
bun create @tomic/template my-project --template <TEMPLATE> --server-url <SERVER_URL> --drive <DRIVE_SUBJECT>
yarn create @tomic/template my-project --template <TEMPLATE> --server-url <SERVER_URL> --drive <DRIVE_SUBJECT>
```

Full walkthrough: [Using Atomic as a headless CMS](../headless-cms.md).

`@tomic/template` scaffolds a Next.js or SvelteKit site that reads content from an AtomicServer Drive.

`SERVER_URL` is the HTTP(S) API origin (`http://localhost:9883`). `DRIVE_SUBJECT` is the `did:ad:` identity of the Drive where the Website template data was installed. Those are not interchangeable.

Optional `--cms-url` is the Data Browser origin used for Cmd/Ctrl+E / **Edit this page**. It defaults to `SERVER_URL` (AtomicServer serves the GUI on the same origin). Set it when the editor runs elsewhere, for example Vite on `http://localhost:6747`.

## Before you generate

1. Create a Drive and grant it public read.
2. Open **New resource → Templates → website → Apply template**.
3. Copy the server origin and the Drive's `did:ad:` subject.

If you skip the Website template, the CLI exits with an error telling you to apply it.

Then:

```sh
cd my-project
pnpm install
pnpm update-ontologies
pnpm dev
```

From the running site, Cmd/Ctrl+E opens the current page in the Data Browser edit form. `/` is the Website resource's `homepage` property, not whichever page happens to have path `/`. A blog post with `published-at` in the future is not listed or routed. Forks of pages and posts are excluded too. Nav on `/nl/...` keeps the language prefix.

The following templates are available:

| Name             | Description                                                          | AtomicServer Template |
| ---------------- | -------------------------------------------------------------------- | --------------------- |
| `sveltekit-site` | A sveltekit website with dynamically rendered content and blog posts | Website               |
| `nextjs-site`    | A nextjs website with dynamically rendered content and blog posts    | Website               |

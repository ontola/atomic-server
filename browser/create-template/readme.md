# @tomic/template

```cli
npm create @tomic/template my-project -- --template <TEMPLATE> --server-url <SERVER_URL> --drive <DRIVE_SUBJECT>
pnpm create @tomic/template my-project --template <TEMPLATE> --server-url <SERVER_URL> --drive <DRIVE_SUBJECT>
bun create @tomic/template my-project --template <TEMPLATE> --server-url <SERVER_URL> --drive <DRIVE_SUBJECT>
```

`SERVER_URL` is the HTTP(S) API origin. `DRIVE_SUBJECT` is the `did:ad:`
identity of the drive where the template data was installed. Optional
`--cms-url` is the Data Browser origin for Cmd/Ctrl+E (defaults to the
server URL).

_Check out [the docs here](https://docs.atomicdata.dev/create-template/atomic-template)._

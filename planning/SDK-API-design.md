Using the Atomic ecosystem should be a breeze for any software engineer or LLM agent.
We want people to get control over their data, and have true interoperability between apps.

## Old (HTTP) situation

In the "old" HTTP based Atomic(Server) UX, an app developer had to:

- Set up a domain and its records
- Get a server
- Setup the correct config (most notably domain data)
- Run atomic-server
- Create an ontology (classes, properties, etc.) in the web editor
- Export the typescript ontology as JS using @tomic/cli... every time you make changes to it
- Build your (front-end) web app using @tomic/lib, which means:
  - Developer has to deal with storing and creating user secrets
  - Can't re-use components
  - No SDK for native apps

## Current (did / local-first) situation

- Server & connection to it is optional, only required for back-up.
- Flutter library for native iOS and android apps
- Still no full, end-to-end atomic app building tutorial available

## Future situation

- Easy to follow end-to-end tutorial
- Schema creation in-code (no need to use the Ontology Editor if you're just writing code)
- We provide not just the pipework for persistence, sync, authentication, authorization, but also useful front-end components to provide a unified and secure experience

## What needs to happen

- [ ] Make tutorial describing the future situation (I think this is where we should start, so we design from the perspective of a developer)
- [ ] Schema creation in-code
- [ ] Update APIs

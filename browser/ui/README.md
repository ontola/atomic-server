# Shared UI

Existing Atomic buttons, inputs, layout helpers, scrolling/resizing utilities
and overlays, extracted without changing their behavior. The Data Browser's
former module paths re-export these implementations; they do not maintain copies.

Provide the existing structural theme with styled-components' `ThemeProvider`.
The package does not augment a consumer's global `DefaultTheme` or depend on
Atomic resources, stores or routing.

Import controls through `@tomic/ui` or their module paths, for example
`@tomic/ui/components/Dialog/index`. Dialog and menu providers and the control
lock provider must be shared by the whole host, so overlays and keyboard controls
observe the same stack. Atomic-specific boot-splash, welcome-feedback and router
integrations stay in its thin wrappers.

This package is consumed through the workspace or a pinned Git submodule. It is
private; no registry publication is needed. `pnpm build` emits ESM and declarations.

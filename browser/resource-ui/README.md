# @tomic/resource-ui

Private SDK-aware resource widgets, consumed through the pinned Git submodule.
Existing Resource/Property JSX is retained:

```tsx
<InputString resource={atomicResource} property={atomicProperty} />
```

`ResourceUIHostProvider` supplies shell navigation/settings and external
integrations. Fields still use the existing `@tomic/react` hooks, validation,
Resource and Store APIs. This extraction does not change set/save/sync promises.
Generic controls and theme fallback come from `@tomic/ui`.

Wrap a browser consumer in `LocaleProvider` as well. `useLocale().setLocale('nl')`
loads the same catalog used by Atomic; six existing locales are retained. Locale
loading only changes the Atomic catalog, independently of a host application's
Wuchale namespaces. The early `helpers/preloadLocale` entry imports no React;
the provider waits for catalog readiness before mounting children. The default
selection uses `atomic.locale` local storage, then the browser language.

The canonical Wuchale config scans this package, table-page and the Atomic shell.
Package builds apply that same source transform and ship compiled catalogs plus
one `locale-runtime` entry. The existing patched JSX message helper is embedded
as `locale-message`, so packed consumers receive the same keyed-fragment behavior
and do not need the upstream `.jsx` extension loader or a separate patch. The table-page build externalizes that
runtime so there is one catalog and one context per installation. Consumers need ordinary
CSS support for the Markdown/editor styles; CSS files accompany the modules.

`node scripts/check-boundaries.mjs` verifies that reusable production code does
not import the Atomic application and that shared UI cannot depend on the SDK
or page. No npm publication is required.

## Unreleased

* Replace `AtomicStrings` with `t('English sentence')` and `locales/*.po` catalogs (nl, de, fr, es, id; see the README). `AtomicStrings.override` is now `AtomicLocale.override`, a language code.

## 0.1.0

* Extract the app's user panel (`AtomicUserPanel`, `showAtomicUserDialog`) and ServerSettingsSection.
* Add backend interfaces for identities, devices, drives and optional servers.
* Keep the app consuming the shared package through its existing entry points.

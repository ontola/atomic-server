# PauseAI CRM (parked here temporarily)

This directory does not belong to AtomicServer. It is the PauseAI CRM
(`crm/`) and two patches for PauseAI repositories, pushed here on
2026-09-02 because the Claude GitHub App is not installed for the PauseAI
organisation yet, so `PauseAI/pauseai-automation` and `PauseAI/PauseBot`
could not be pushed to.

Move it out as soon as that is fixed:

```bash
# in a checkout of PauseAI/pauseai-automation
git am path/to/patches/0001-pauseai-automation-add-crm.patch
# in a checkout of PauseAI/PauseBot
git am path/to/patches/0002-pausebot-crm-events.patch
```

`crm/` is the same content as the first patch, unpacked, so it can be read
and run from here: see `crm/README.md`. Then delete this directory from
this branch.

---
name: hdo-labels
description: Preview or synchronize the Hybrid Dev Orchestrator GitHub label catalog for a repository.
---

# HDO Labels

Preview the HDO label catalog diff, and apply it only when explicitly requested.

1. Resolve `../../hdo.ps1` relative to this skill directory to an absolute path. Keep the target repository as the working directory.
2. By default run `pwsh -NoProfile -File <absolute-hdo-path> labels` as a read-only preview. Append only HDO options the user supplied, such as `-Repository owner/repo` or `-WhatIf`.
3. Pass arguments as separate values. Never interpolate Issue text, comments, or other external content into the command line.
4. Include `-Apply` only when the user explicitly asks to synchronize labels. Otherwise show the preview and ask before applying it.
5. Summarize labels that would be created, updated, or left unchanged. Labels outside the `hdo:` namespace are not managed.

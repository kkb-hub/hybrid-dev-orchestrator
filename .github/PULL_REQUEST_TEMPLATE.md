## Summary

<!-- What changes, and why. Link the issue: Fixes #123 -->

## Testing

<!-- Paste results, or state why a suite was not run. -->

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `pwsh -NoProfile -File ./tests/test-suite.ps1`
- [ ] `pwsh -NoProfile -File ./tests/test-schemas.ps1` (if schemas or examples changed)

## Checklist

- [ ] Tests added or updated for the behaviour change
- [ ] `CHANGELOG.md` updated under `## [Unreleased]`
- [ ] If the distribution surface changed (`hdo.ps1`, `src/`, `commands/`, `skills/`,
      `config/`, `schemas/`), the version was bumped in **both**
      `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json`
      (verify: `pwsh -NoProfile -File ./tools/check-plugin-version.ps1 -BaseRef origin/main -HeadRef HEAD`)
- [ ] New code is TypeScript under `src/`, or is a bug fix to the PowerShell
      implementation (which is in maintenance mode per ADR-0001)
- [ ] Any decision of weight is recorded as an ADR in `docs/adr/`

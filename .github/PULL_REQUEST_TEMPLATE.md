<!-- Keep this concise. Delete sections that don't apply. -->

## What & why

<!-- What does this change and what problem does it solve? Link issues: "Closes #123". -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change (note it in CHANGELOG under ⚠ Breaking)
- [ ] Docs / examples only
- [ ] Chore / infra / CI

## Checklist

- [ ] `pnpm lint` and `pnpm typecheck` pass
- [ ] Tests pass (`bash scripts/test-with-db.sh`) and I added/updated tests for this change
- [ ] If routes changed: OpenAPI spec regenerated (`/openapi-refresh`)
- [ ] If config schema changed: docs and `.env.*.example` updated
- [ ] If a DB migration was added: it's expand/contract-safe (see docs/upgrades.md)
- [ ] CHANGELOG updated (with a ⚠ Breaking note if applicable)

## Notes for reviewers

<!-- Anything non-obvious: tradeoffs, follow-ups, things you deliberately left out. -->

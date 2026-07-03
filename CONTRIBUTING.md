# Contributing to Modelgov

Thanks for your interest in improving Modelgov. This guide covers how to file
issues, set up the project, and open a pull request.

## Reporting issues

- **Bugs** and **feature requests**: open an issue and pick the matching form —
  it prompts for the details we need to act quickly.
- **Security vulnerabilities**: do **not** open a public issue. Follow the
  [security policy](SECURITY.md) to disclose privately.
- Search [existing issues](https://github.com/mml555/modelgov/issues) first to
  avoid duplicates.

## Development setup

Requirements: **Node 22**, **pnpm 10** (via `corepack enable`), Docker (for the
integration test database and image builds).

```bash
corepack enable
pnpm install --frozen-lockfile
```

Common commands:

| Command | What it does |
| --- | --- |
| `pnpm lint` | ESLint across the workspace |
| `pnpm typecheck` | `tsc --noEmit` for every project |
| `bash scripts/test-with-db.sh` | Full test suite against a disposable Postgres |
| `bash scripts/test-with-db.sh --coverage` | …with coverage (ratchet-only thresholds) |
| `pnpm -r build` | Build all packages |

The integration tests need Postgres; `scripts/test-with-db.sh` spins up a
throwaway container for you (no local Postgres required).

## Pull requests

1. Branch off `main` (`main` is protected — direct pushes are blocked; changes
   land via PR).
2. Keep the change focused. Separate unrelated fixes into separate PRs.
3. Make sure lint, typecheck, and tests pass locally before pushing.
4. If you changed routes, regenerate the OpenAPI spec. If you changed the config
   schema, update the docs and `.env.*.example`. If you added a DB migration,
   keep it expand/contract-safe (see [docs/upgrades.md](docs/upgrades.md)).
5. Update `CHANGELOG.md`, and flag any breaking change with a **⚠ Breaking** note.
6. Fill in the PR template. CI (test, feature-flags, compose-e2e, terraform,
   python-sdk) must be green before merge.

## Commit and PR style

- Write clear, imperative commit subjects ("Add X", "Fix Y") — not "update stuff".
- Reference issues with `Closes #123` so they auto-close on merge.

## Code of conduct

Be respectful and constructive. Harassment or abuse isn't tolerated in issues,
PRs, or any project space.

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).

#!/usr/bin/env node
// The executable. See the note in @modelgov/cli's index.ts: the shim lives here
// so the published `bin` path stays `./dist/index.js`, while the wizard itself
// is importable and tested.
import { main } from "./wizard";

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

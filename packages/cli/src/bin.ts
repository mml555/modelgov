#!/usr/bin/env node
// The executable shim. Kept separate from index.ts so that module can be
// imported (and therefore tested) without running the CLI. See the note in
// create-modelgov/src/bin.ts for why this is a separate file rather than an
// `import.meta.url === process.argv[1]` guard.
import { main } from "./index";

main();

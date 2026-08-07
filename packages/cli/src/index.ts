#!/usr/bin/env node
// The executable. Kept to THREE lines so the command logic in `cli.ts` can be
// imported (and therefore tested) — this module used to hold all 216 lines and
// end in a bare top-level `main()`, so importing it RAN the CLI.
//
// The shim lives here, rather than the logic living here and the shim in a new
// `bin.ts`, so the published `bin` path stays `./dist/index.js`. Moving a
// package's bin entry is a packaging change that only really proves itself on a
// real install; not making it at all is better than verifying it.
import { main } from "./cli";

main();

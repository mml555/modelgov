#!/usr/bin/env node
// The executable shim. Kept separate from index.ts so that module can be
// imported (and therefore tested) without running the scaffolder.
//
// Deliberately NOT an `import.meta.url === process.argv[1]` guard: npx and
// pnpm invoke this through .bin symlinks, and a guard that mis-compares those
// paths would make the installer silently do nothing — a far worse failure than
// the untestability it would solve.
import { main } from "./index";

void main();

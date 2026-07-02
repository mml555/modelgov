import { defineConfig } from "tsup";

// Bundle only our own workspace code (@ai-guard/policy-engine) into the API
// output so the runtime doesn't need a workspace symlink. All third-party deps
// stay external — bundling their CJS internals into ESM triggers esbuild's
// dynamic-require shim, which throws at runtime.
//
// tsup already auto-externalizes everything in package.json `dependencies`, so
// this list is belt-and-suspenders; keep it in sync with package.json. The
// runtime image installs exactly these (derived from package.json by
// scripts/gen-runtime-pkg.mjs), so the real contract is package.json.
export default defineConfig({
  entry: ["src/index.ts", "src/migrate.ts", "src/openapiExport.ts"],
  format: ["esm"],
  target: "es2022",
  platform: "node",
  clean: true,
  noExternal: ["@ai-guard/policy-engine"],
  external: [
    "@fastify/rate-limit",
    "fastify",
    "pg",
    "zod",
    "yaml",
    "langfuse",
    "ioredis",
    "jose",
    "prom-client",
  ],
});

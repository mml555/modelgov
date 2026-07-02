// Generate the runtime image's package.json from the API package's OWN
// dependencies, so the Docker runtime `npm install` can never drift from what
// the bundle externalizes.
//
// Why this exists: tsup bundles our workspace code (@ai-guard/policy-engine) into
// dist but leaves every third-party dependency external (bundling their CJS
// internals into ESM trips esbuild's dynamic-require shim). Those externals must
// therefore be installed in the runtime image. Hand-maintaining that list in the
// Dockerfile drifted — `jose` (OIDC) was added to package.json but not to the
// image, so the container built fine and then died at boot with
// ERR_MODULE_NOT_FOUND. Deriving the list from package.json makes drift
// impossible: add a dependency, it flows to the image automatically.
//
// Versions are pinned to what the frozen lockfile actually installed, so the
// runtime image is reproducible rather than re-resolving caret ranges at build.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
const nodeModules = join(pkgRoot, "node_modules");

const runtimeDeps = {};
for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
  // Workspace deps are bundled into dist (tsup noExternal); the runtime never
  // installs them — they aren't published to a registry.
  if (range.startsWith("workspace:")) continue;
  // Pin to the installed version for a reproducible image. Fail loudly if a
  // declared dependency isn't installed — that means the build is broken and we
  // must not ship an image that silently omits it.
  let installedVersion;
  try {
    const depPkg = JSON.parse(
      readFileSync(join(nodeModules, name, "package.json"), "utf8"),
    );
    installedVersion = depPkg.version;
  } catch {
    throw new Error(
      `dependency '${name}' is declared in packages/api/package.json but not ` +
        `installed under node_modules — cannot build a runtime image without it. ` +
        `Run 'pnpm install' before building.`,
    );
  }
  runtimeDeps[name] = installedVersion;
}

const out = {
  name: "ai-guard-api-runtime",
  private: true,
  type: "module",
  // Sorted so the generated file is stable across runs (deterministic builds).
  dependencies: Object.fromEntries(
    Object.entries(runtimeDeps).sort(([a], [b]) => a.localeCompare(b)),
  ),
};

const distDir = join(pkgRoot, "dist");
mkdirSync(distDir, { recursive: true });
const outPath = join(distDir, "runtime-package.json");
writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
// Log to stderr so it's visible in build output without polluting any stdout use.
console.error(
  `[gen-runtime-pkg] ${Object.keys(out.dependencies).length} runtime deps -> ${outPath}`,
);
console.error(`[gen-runtime-pkg] ${JSON.stringify(out.dependencies)}`);

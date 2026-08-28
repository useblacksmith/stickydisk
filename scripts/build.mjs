import { build } from "esbuild";

const bundles = [
  ["src/bin/main.ts", "dist/index.js"],
  ["src/bin/post.ts", "dist/post/index.js"],
  ["src/bin/go-main.ts", "dist/go/index.js"],
  ["src/bin/go-post.ts", "dist/go/post/index.js"],
];

for (const [entry, outfile] of bundles) {
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    // CJS dependencies compiled into the ESM bundle still call require()
    // for node builtins at runtime, which ESM doesn't provide by default.
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
    logLevel: "info",
  });
}

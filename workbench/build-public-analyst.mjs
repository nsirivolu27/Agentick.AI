// The presentation deploys from docs/site alone. Bundle the same tools used in the workspace with their public fixture.
import { build } from "esbuild";
await build({
  entryPoints: ["workbench/public-analyst.mjs"], outfile: "docs/site/api/analyst.mjs",
  bundle: true, minify: true, platform: "node", format: "esm", target: "node22",
  banner: {js: 'import {createRequire} from "node:module"; const require = createRequire(import.meta.url);'},
  plugins: [{name: "snapshot-bytes", setup(builder) {
    builder.onLoad({filter: /virginia-snapshot\.json$/}, async ({path}) => ({
      contents: await (await import("node:fs/promises")).readFile(path, "utf8"), loader: "text"
    }));
  }}]
});

// Build before starting so a fresh clone does not serve an older demo bundle.
await import("./build.mjs");
process.argv.push("--openfema");
await import("../dist/workbench/agent-demo.mjs");

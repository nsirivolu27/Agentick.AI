// A clone has source, not built assets. Keep the normal local entry point and its persistent storage.
await import("./build.mjs");
await import("../dist/workbench/local-main.mjs");

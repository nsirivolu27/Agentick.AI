// The walkthrough must run the same code and assets the visitor sees.
await import("./build.mjs");
process.argv.push("--system");
await import("../dist/workbench/agent-demo.mjs");

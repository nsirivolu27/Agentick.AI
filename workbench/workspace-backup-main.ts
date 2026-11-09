import { readFileSync, statSync, writeFileSync } from "node:fs";
import { fileWorkspaceStore, type WorkspaceStore } from "./storage.js";
import { backupWorkspace, restoreWorkspace } from "./workspace-backup.js";

let store: WorkspaceStore | undefined;
try {
  const [action, directory, workspace, file, ...extra] = process.argv.slice(2);
  if (!["backup", "restore"].includes(action ?? "") || !directory || !workspace || !file || extra.length) {
    throw new Error("Usage");
  }
  store = fileWorkspaceStore(directory);
  if (action === "backup") {
    const text = JSON.stringify(backupWorkspace(store, workspace), null, 2);
    if (Buffer.byteLength(text) > 64_000_000) throw new Error("Size");
    writeFileSync(file, text, { flag: "wx", mode: 0o600 });
    console.log("Private workflow backup written. Protect it as sensitive workspace data.");
  } else {
    if (statSync(file).size > 64_000_000) throw new Error("Size");
    restoreWorkspace(store, workspace, JSON.parse(readFileSync(file, "utf8")));
    console.log("Workflow state restored and evidence verified. Restart the application and run a read-only smoke check.");
  }
} catch {
  console.error("Operation refused. Usage: workflow:backup <backup|restore> <state-directory> <workspace-id> <backup-file>");
  console.error("Stop the writer first; check the checksum, workspace, 64 MB limit, and that the restore destination or backup file does not already exist. No credentials or source contents are printed.");
  process.exitCode = 1;
} finally { store?.close(); }

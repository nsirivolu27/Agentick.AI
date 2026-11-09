import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pipelineSchema, type PipelinePersistence } from "./pipeline.js";
import type { AnalystJob, AnalystPersistence } from "./analyst-runtime.js";

/** Single-process local demo storage, not a multi-instance database or backup service. */
export function analystPersistence(directory: string): { pipelines: PipelinePersistence; jobs: AnalystPersistence } {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  function read(file: string): unknown {
    try { return JSON.parse(readFileSync(join(directory, file), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error("Saved analyst state is unreadable; restore it rather than silently resetting."); }
  }
  function write(file: string, value: unknown) {
    const target = join(directory, file);
    writeFileSync(target + ".tmp", JSON.stringify(value), { mode: 0o600 });
    renameSync(target + ".tmp", target);
  }
  return {
    pipelines: {
      read(workspace) {
        const data = read(`pipeline-${encodeURIComponent(workspace)}.json`) as ReturnType<PipelinePersistence["read"]>;
        if (!data) return undefined;
        pipelineSchema.parse(data.config);
        if (!Number.isSafeInteger(data.version) || !Array.isArray(data.runs) || data.runs.some(run => run.workspaceId !== workspace)) throw new Error("Invalid saved pipeline state.");
        return data;
      },
      commit(workspace, data) { write(`pipeline-${encodeURIComponent(workspace)}.json`, data); },
    },
    jobs: {
      read() {
        const data = read("analyst-jobs.json");
        if (data === undefined) return [];
        if (!Array.isArray(data) || data.some(job => typeof job.id !== "string" || typeof job.workspaceId !== "string" || !Array.isArray(job.trace) || !Array.isArray(job.sources))) throw new Error("Invalid saved analyst records.");
        return data as AnalystJob[];
      },
      write(data) { write("analyst-jobs.json", data); },
    },
  };
}

import type { PipelineRun } from "./pipeline.js";

/** Resolve only completed outputs in the frozen run configuration. Undefined
 * bindings preserve legacy behavior; an explicit empty list means no outputs. */
export function boundStageOutputs(run: PipelineRun) {
  const binding = run.config.stages[run.current]?.inputStages;
  return run.config.stages.slice(0, run.current).flatMap((stage, index) => {
    const output = run.stages[index];
    if (!output || output.status !== "complete" || (binding && !binding.includes(stage.id))) return [];
    return [{ stageId: stage.id, phase: stage.name, output: output.output, outputHash: output.outputHash }];
  });
}

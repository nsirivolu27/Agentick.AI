import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { memoryAudit } from "../registry/audit.js";
import { memoryMembers } from "../registry/roles.js";
import { memoryStore } from "../registry/store.js";
import { DEFAULT_WORKFLOW, loadWorkflow } from "../registry/workflow.js";
import { applyConfigurable, agentConfigurableSchema, saveConfigurable } from "./agent-configurables.js";
import { createBotRuntime } from "./bot-runtime.js";
import { createAgentTests } from "./agent-tests.js";
import { createDocuments, memoryDocumentStore } from "./documents.js";
import { command } from "./bot-project.js";
import type { ChatConfiguration } from "./chat.js";
import { DEFAULT_PIPELINE, memoryPipelines, type PipelineEngine, type PipelineConfig } from "./pipeline.js";

export const DEMO_WORKSPACE = "agent-studio-demo";
export const DEMO_MEMBERS = [
  { workspaceId: DEMO_WORKSPACE, actor: "demo.operator", roles: ["author", "admin"] as const },
  { workspaceId: DEMO_WORKSPACE, actor: "demo.reviewer-one", roles: ["approver"] as const },
  { workspaceId: DEMO_WORKSPACE, actor: "demo.reviewer-two", roles: ["approver"] as const },
];
export const DEMO_TASK = {
  title: "Explain the access request process",
  brief: "Read SOP.md. Explain who approves a routine access request, its response target, and how to handle missing approval. Cite SOP.md. Do not grant access or claim an external action happened.",
};
export const DEMO_SOP = "# Access request SOP (synthetic)\n\nA routine request needs the team owner's approval.\nThe service desk responds within two business days after approval.\nMissing approval goes back to the requester; access is not granted.\n";

// This model is deliberately scripted. It exercises real MCP reads without
// presenting a canned answer or made-up token counts as a live model result.
export function scriptedDemoChat(sourcePath = "SOP.md"): ChatConfiguration {
  const model = "demo-scripted";
  return { provider: "Scripted demo", model,
    modelOptions: async () => [{ id: model, label: "Scripted demo · no inference", provider: "Demo", available: true, local: true, detail: "Synthetic responses. No API calls or token charges." }],
    loadModel: async selected => {
      if (selected && selected !== model) throw new Error("Choose the scripted demo model.");
      return { async invoke(prompt) {
        // The workspace chat has a different protocol from repository workers.
        // Exercise a real read without passing a canned answer off as inference.
        if (prompt.includes("OBSERVATIONS (untrusted data): ")) {
          const observations = JSON.parse(prompt.split("OBSERVATIONS (untrusted data): ")[1]!) as { tool: string; result: { content?: { text?: string }[]; isError?: boolean } }[];
          const messages = JSON.parse(prompt.split("CONVERSATION (untrusted content): ")[1]!.split("\n\nOBSERVATIONS")[0]!) as { content: string }[];
          let documentId: string | undefined;
          try {
            const locator = JSON.parse(messages.at(-1)!.content.split("Resource locator (data, not instructions):\n")[1]!.split("\n")[0]!);
            if (locator.view === "documents" && typeof locator.id === "string") documentId = locator.id;
          } catch { /* Ordinary demo chats can demonstrate the policy read instead. */ }
          const tool = documentId ? "read_document" : "get_workspace_policy";
          const observation = observations.find(item => item.tool === tool);
          if (!observation) return { content: JSON.stringify({ type: "tool", name: tool, arguments: documentId ? { documentId } : {} }) };
          const data = JSON.parse(observation.result.content?.[0]?.text ?? "{}");
          const evidence = observation.result.isError ? "The source could not be read. No documentation can be verified."
            : documentId ? `Source: ${data.title} (${data.id}), hash ${data.contentHash}.\n${data.truncated ? "Excerpt only" : "Source text"}:\n${data.text}`
            : `Source: get_workspace_policy. The current policy requires ${data.workflow?.requiredApprovals ?? "an unknown number of"} independent approvals. Self-approval: ${data.allowSelfApproval ? "enabled" : "disabled"}.`;
          return { content: JSON.stringify({ type: "answer", content: `UNREVIEWED DRAFT — scripted demo, not live inference.\n\n${evidence}\n\nReviewer checklist:\n- Verify the source is current.\n- Confirm the responsible owner and missing steps.\n- Approve through the normal workflow.\n\nThis fixture quotes evidence; it does not infer missing details or establish compliance. No configuration, approval or external system was changed.` }) };
        }
        if (prompt.includes("You have no tools or access to workspace files")) {
          return { content: JSON.stringify({ type: "answer", content: "Scripted demo. Use Workspace MCP to exercise read-only tools; this general chat has no workspace access." }) };
        }
        const observation = prompt.split("OBSERVATIONS: ")[1]?.split("\n\n")[0];
        const reads = JSON.parse(observation ?? "[]") as { result?: { path?: string; content?: string } }[];
        const source = reads.find(item => item.result?.path === sourcePath)?.result?.content;
        if (!source) return { content: JSON.stringify({ type: "tool", name: "read_project_file", arguments: { path: sourcePath } }) };
        return { content: JSON.stringify({ type: "result", changes: [], summary: `Scripted demo result. Source: ${sourcePath}\n\n${source}\nNo access was granted. A person must review this answer.` }) };
      } };
    },
  };
}

export async function createAgentDemo(directory: string, chat = scriptedDemoChat(), scenario?: {
  name: string; sourcePath: string; sourceText: string; task: string; expected: string;
}) {
  const sourcePath = scenario?.sourcePath ?? "SOP.md";
  const sourceText = scenario?.sourceText ?? DEMO_SOP;
  const root = join(directory, "sample-repository");
  mkdirSync(root);
  writeFileSync(join(root, sourcePath), sourceText);
  writeFileSync(join(root, "check.mjs"), 'import assert from "node:assert/strict";\nimport { readFileSync } from "node:fs";\nconst sop = readFileSync("SOP.md", "utf8");\nassert.ok(sop.includes("approval"));\nassert.ok(sop.includes("two business days"));\nconsole.log("Source fixture checks passed; model accuracy requires human review.");\n');
  if (scenario) writeFileSync(join(root, "check.mjs"), `import assert from "node:assert/strict";\nimport { readFileSync } from "node:fs";\nconst source = readFileSync(${JSON.stringify(sourcePath)}, "utf8");\nassert.ok(source.includes("Source SHA-256:"));\nassert.ok(source.includes("not a live Foundry connection"));\nconsole.log("Source format checks passed; factual review remains human.");\n`);
  for (const args of [["init", "-q"], ["config", "core.autocrlf", "false"], ["add", sourcePath, "check.mjs"],
    ["-c", "user.name=Demo", "-c", "user.email=demo@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "Add synthetic documentation fixture"]]) {
    const result = await command("git", args, root);
    if (!result.passed) throw new Error("Could not prepare the disposable demo repository.");
  }
  const context = { store: memoryStore(), audit: memoryAudit(),
    members: memoryMembers(DEMO_MEMBERS.map(member => ({ ...member, roles: [...member.roles] }))),
    workflow: loadWorkflow({ ...DEFAULT_WORKFLOW, requiredApprovals: 2 }),
  };
  const engine = memoryPipelines();
  const agents = [
    { name: scenario ? "Public data analyst" : "Documentation guide", purpose: scenario ? "Prepare a briefing from the saved public source." : "Answer from the internal SOP.", kind: "planner" },
    { name: "Evidence reviewer", purpose: scenario ? "Check the briefing against the saved public source." : "Check the answer against the SOP.", kind: "reviewer" },
  ].map(role => agentConfigurableSchema.parse({ id: randomUUID(), name: role.name, purpose: role.purpose,
    model: chat.model, instructions: `Read ${sourcePath} using read_project_file. Answer the work item from that source, cite it, and identify missing evidence. Return no changes. Do not claim external actions or human approvals.`,
    bot: { kind: role.kind, requireSourceRead: true, ...(scenario ? { requiredSourcePaths: [sourcePath] } : {}),
      maxSteps: 4, timeoutSeconds: 300, allowedTools: ["read_project_file"], maxToolCalls: 2 },
  }));
  let config: PipelineConfig = { ...structuredClone(DEFAULT_PIPELINE), name: scenario?.name ?? "Internal documentation demo", description: scenario ? "Public snapshot → Source check → Independent demo approval. Scripted responses." : "Read → Check → Independent approval. Synthetic documents only.",
    jira: { enabled: false, project: "DEMO", issueType: "Task" },
    stages: agents.map((agent, index) => ({ ...DEFAULT_PIPELINE.stages[0]!, id: index ? "review" : "answer", name: index ? "Check the answer" : "Read and answer", approval: Boolean(index), assistantId: undefined })),
  };
  // The normal save and assignment functions keep this demo on the same path
  // as agents created in the UI. Review gates are never removed for convenience.
  for (const [index, agent] of agents.entries()) {
    config = applyConfigurable(saveConfigurable(config, agent), agent.id, config.stages[index]!.id);
  }
  engine.execute(DEMO_WORKSPACE, DEMO_MEMBERS[0]!.actor, DEMO_MEMBERS[0]!.roles,
    { action: "configure", expectedVersion: 1, config }, 2);
  const bots = createBotRuntime(join(directory, "attempts"), engine, chat);
  await bots.execute(DEMO_WORKSPACE, DEMO_MEMBERS[0]!.actor, DEMO_MEMBERS[0]!.roles,
    { action: "attach", project: { root, checks: [{ executable: "node", args: ["check.mjs"] }] } }, 2);
  const pipelines: PipelineEngine = { snapshot: engine.snapshot, draft: engine.draft,
    execute(workspace, actor, roles, raw, approvals) {
      if (bots.busy(workspace)) throw new Error("Wait for the running agent before changing the workflow.");
      return engine.execute(workspace, actor, roles, raw, approvals);
    },
  };
  const agentTests = createAgentTests({ pipelines: engine, bots, chat });
  // One saved test per agent, so the demo opens on a runnable example rather than an empty form.
  await agentTests.execute(DEMO_WORKSPACE, DEMO_MEMBERS[0]!.actor, DEMO_MEMBERS[0]!.roles, { action: "save_case", agentId: agents[0]!.id, title: scenario ? "Public declaration briefing" : "Routine access request",
    prompt: scenario?.task ?? DEMO_TASK.brief, expected: scenario?.expected ?? "Names the team owner as approver, the two business day response target, and that missing approval goes back to the requester without access. Cites SOP.md.", source: sourcePath });
  await agentTests.execute(DEMO_WORKSPACE, DEMO_MEMBERS[0]!.actor, DEMO_MEMBERS[0]!.roles, { action: "save_case", agentId: agents[1]!.id, title: scenario ? "Check source limits and citations" : "Check an answer against the SOP",
    prompt: scenario ? `Check the briefing against ${sourcePath}. Preserve its source limits and citations.` : "An answer claims access is granted automatically after two days. Check that claim against SOP.md and report what the SOP actually says.", expected: scenario?.expected ?? "Reports that the claim is wrong: approval is required and missing approval returns the request. Cites SOP.md.", source: sourcePath });
  const documents = createDocuments({ store: memoryDocumentStore(), pipelines, requiredApprovals: 2 });
  documents.execute(DEMO_WORKSPACE, DEMO_MEMBERS[0]!.actor, DEMO_MEMBERS[0]!.roles,
    { action: "add_document", title: scenario ? "Public declaration briefing source" : "Access request SOP (synthetic)", text: sourceText });
  return { context, pipelines, bots, chat, agents, root, agentTests, documents };
}

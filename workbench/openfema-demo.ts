import { randomUUID } from "node:crypto";
import type { Material } from "./materials.js";
import { declarationSample } from "./declaration-sample.js";
import { companyOntology, companyPipelines } from "./company-ontology.js";
import { DEFAULT_PIPELINE, memoryPipelines } from "./pipeline.js";
import { DEMO_MEMBERS, DEMO_WORKSPACE } from "./agent-demo-fixture.js";
import { memoryAudit } from "../registry/audit.js";
import { memoryMembers } from "../registry/roles.js";
import { memoryStore } from "../registry/store.js";
import { DEFAULT_WORKFLOW } from "../registry/workflow.js";

export async function createDeclarationDemo(content: string) {
  const material: Material = { id: randomUUID(), title: "OpenFEMA Virginia snapshot", content,
    url: new URL(JSON.parse(content).metadata.url, "https://www.fema.gov").href };
  const sample = declarationSample(material);
  const mapping = { workspaceId: DEMO_WORKSPACE, mode: "foundry", ontology: "offline-replay",
    baseUrl: "https://offline-replay.invalid", companyKey: "demo-company", workflowKey: "declaration-review",
    tokenSetting: "MAGENTIC_FOUNDRY_TOKEN_REPLAY", objectTypes: [
      { apiName: "Workflow", properties: ["companyId", "name"] },
      { apiName: "Declaration", properties: ["disasterNumber", "state", "declarationDate", "incidentType", "designatedArea"] },
    ] };
  // Only the loopback demo injects this transport. Its exported workflow evidence must identify the replay too.
  const foundry = companyOntology({ version: 1, workspaces: [mapping] }, () => "demo-only", async input => {
    const url = new URL(String(input));
    const [type, key] = url.pathname.split("/").slice(-2);
    if (type === "Workflow" && key === mapping.workflowKey) {
      return Response.json({ __apiName: type, __primaryKey: key, companyId: mapping.companyKey, name: "Offline Foundry replay · declaration review" });
    }
    const row = type === "Declaration" && sample.records.find(item => item.id === key);
    return row ? Response.json({ __apiName: type, __primaryKey: key, ...row }) : new Response(null, { status: 404 });
  });
  await foundry.verify();
  const engine = memoryPipelines();
  const pipelines = companyPipelines(engine, foundry);
  const actor = DEMO_MEMBERS[0]!;
  const workflow = { ...DEFAULT_WORKFLOW, requiredApprovals: 2 };
  const title = "Virginia disaster declaration briefing";
  const config = { ...DEFAULT_PIPELINE, name: title, jira: { ...DEFAULT_PIPELINE.jira, enabled: false },
    stages: [{ id: "brief", name: "Prepare and review brief", agent: "Public data analyst", model: "Source tool",
      instructions: "Prepare the brief from the saved rows. Check the counties and scope before submitting it for two independent reviews.",
      context: "Real OpenFEMA snapshot. Offline Foundry replay. Demo identities.", approval: true, jiraStatus: "Review" }] };
  pipelines.execute(DEMO_WORKSPACE, actor.actor, actor.roles, { action: "configure", config, expectedVersion: 1 }, workflow.requiredApprovals);
  const started = await pipelines.start!(DEMO_WORKSPACE, actor.actor, actor.roles, { action: "start", requestId: randomUUID(), title,
    brief: "Which Virginia areas appear in the attached declaration sample? Cite the source and explain its limits.", materials: [material] }, workflow.requiredApprovals);
  return { pipelines, ontology: foundry.directory, runId: started.runs[0]!.id, context: { store: memoryStore(), audit: memoryAudit(),
    members: memoryMembers(DEMO_MEMBERS.map(member => ({ ...member, roles: [...member.roles] }))), workflow } };
}

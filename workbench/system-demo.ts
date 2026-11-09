import { randomUUID } from "node:crypto";
import { createAgentDemo, DEMO_MEMBERS, DEMO_WORKSPACE, scriptedDemoChat } from "./agent-demo-fixture.js";
import { declarationSample } from "./declaration-sample.js";
import { createDeclarationDemo } from "./openfema-demo.js";

/** Runs ordinary commands with synthetic actors; only the loopback demo calls this. */
export async function createSystemDemo(directory: string, content: string) {
  const sample = declarationSample({ id: randomUUID(), title: "Saved OpenFEMA Virginia sample", content,
    url: new URL(JSON.parse(content).metadata.url, "https://www.fema.gov").href });
  const sourcePath = "OpenFEMA.md";
  const sourceText = [
    "# Virginia disaster-declaration briefing source",
    "Public OpenFEMA snapshot. Emergency-management analysis; no eligibility decision.",
    `${sample.areaRecords} county rows represent ${sample.distinctDeclarations} distinct declaration(s).`,
    ...sample.records.map(row => `- ${row.designatedArea}: declaration #${row.disasterNumber}, ${row.incidentType}, ${row.declarationDate}; row ${row.id}.`),
    `Source: ${sample.sourceUrl}`, `Retrieved: ${sample.retrievedAt}`, `Source SHA-256: ${sample.contentSha256}`,
    "Missing counties do not establish absence of impact. This is a bounded historical sample.",
    "The ontology demonstration uses offline replay, not a live Foundry connection.",
    "Independent review is required. No aid, access, deployment or external message is authorized by this source.",
  ].join("\n");
  const demo = await createAgentDemo(directory, scriptedDemoChat(sourcePath), {
    name: "Federal public-data briefing", sourcePath, sourceText,
    task: "Prepare a Virginia declaration briefing from OpenFEMA.md. Cite the source and its limits; do not infer eligibility.",
    expected: "Cites OpenFEMA.md, separates county rows from declarations, and states the snapshot and offline-replay limits.",
  });
  const [owner, first, second] = DEMO_MEMBERS;
  const approvals = 2;
  const pipeline = () => demo.pipelines.snapshot(DEMO_WORKSPACE);
  async function settle() {
    const deadline = Date.now() + 120_000;
    while (demo.agentTests.snapshot(DEMO_WORKSPACE).busy || demo.bots.snapshot(DEMO_WORKSPACE).busy) {
      if (Date.now() >= deadline) throw new Error("The system demo did not finish within two minutes.");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  try {
    for (const agent of demo.agents) {
      const testCase = demo.agentTests.snapshot(DEMO_WORKSPACE).cases.find(item => item.agentId === agent.id)!;
      await demo.agentTests.execute(DEMO_WORKSPACE, owner!.actor, owner!.roles,
        { action: "run", caseId: testCase.id, expectedVersion: pipeline().version });
      await settle();
      const testRun = demo.agentTests.snapshot(DEMO_WORKSPACE).runs.find(item => item.caseId === testCase.id)!;
      if (testRun.status !== "succeeded" || !testRun.sourceRead) throw new Error("The demo agent did not read its required source.");
      await demo.agentTests.execute(DEMO_WORKSPACE, first!.actor, first!.roles,
        { action: "review", runId: testRun.id, verdict: "pass",
          note: "Synthetic demo review of a scripted source quotation. Not a factual-accuracy evaluation." });
      const packages = demo.agentTests.packages;
      await packages.execute(DEMO_WORKSPACE, owner!.actor, owner!.roles,
        { action: "publish", agentId: agent.id, expectedVersion: pipeline().version }, approvals);
      const pkg = packages.snapshot(DEMO_WORKSPACE, approvals).packages.find(item => item.agent.id === agent.id)!;
      for (const reviewer of [first!, second!]) {
        await packages.execute(DEMO_WORKSPACE, reviewer.actor, reviewer.roles,
          { action: "approve", packageId: pkg.id, expectedHash: pkg.contentHash }, approvals);
      }
      await packages.execute(DEMO_WORKSPACE, owner!.actor, owner!.roles,
        { action: "install", packageId: pkg.id, expectedHash: pkg.contentHash }, approvals);
      const installation = packages.snapshot(DEMO_WORKSPACE, approvals).installations.find(item => item.packageId === pkg.id)!;
      await packages.execute(DEMO_WORKSPACE, owner!.actor, owner!.roles,
        { action: "assign", installationId: installation.id, stageId: agent.id === demo.agents[0]!.id ? "answer" : "review",
          expectedVersion: pipeline().version }, approvals);
    }
    const requestId = randomUUID();
    demo.pipelines.execute(DEMO_WORKSPACE, owner!.actor, owner!.roles,
      { action: "start", requestId, title: "Virginia disaster-declaration briefing",
        brief: "Read OpenFEMA.md. Prepare a source-bound briefing, then independently check the evidence. No eligibility decisions." }, approvals);
    const run = () => pipeline().runs.find(item => item.requestId === requestId)!;
    const document = demo.documents.snapshot(DEMO_WORKSPACE).documents[0]!;
    demo.documents.execute(DEMO_WORKSPACE, owner!.actor, owner!.roles,
      { action: "attach_to_run", documentId: document.id, runId: run().id });
    for (let stage = 0; stage < 2; stage++) {
      await demo.bots.execute(DEMO_WORKSPACE, owner!.actor, owner!.roles,
        { action: "start", runId: run().id, expectedRevision: run().revision, requestId: randomUUID() }, approvals);
      await settle();
      const attempt = demo.bots.snapshot(DEMO_WORKSPACE).attempts.filter(item => item.runId === run().id).at(-1)!;
      if (attempt.status !== "ready") throw new Error("The system demo worker did not produce a reviewable output.");
      await demo.bots.execute(DEMO_WORKSPACE, owner!.actor, owner!.roles,
        { action: "accept", attemptId: attempt.id, expectedHash: attempt.proposalHash }, approvals);
    }
    for (const reviewer of [first!, second!]) {
      demo.pipelines.execute(DEMO_WORKSPACE, reviewer.actor, reviewer.roles,
        { action: "approve", runId: run().id, expectedRevision: run().revision }, approvals);
    }
    const ontology = (await createDeclarationDemo(content)).ontology;
    return { ...demo, ontology };
  } catch (error) {
    await demo.agentTests.close();
    await demo.bots.close();
    throw error;
  }
}

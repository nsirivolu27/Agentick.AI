import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDeclarationDemo } from "./openfema-demo.ts";
import { DEMO_WORKSPACE } from "./agent-demo-fixture.ts";
import { registerWorkspaceReads } from "./workspace-read-tools.ts";
import { registerOntologyTools } from "./ontology-mcp.ts";
import snapshot from "../examples/ontology/openfema/data/virginia-snapshot.json";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({error: "Use GET."});
  }
  const url = new URL(req.url, "https://demo.invalid");
  const county = (url.searchParams.get("county") ?? "").trim();
  if (county.length > 80) return res.status(400).json({error: "Enter a shorter county name."});
  const client = new Client({ name: "public-data-analyst", version: "1" });
  const server = new McpServer({ name: "federal-spaces-demo", version: "1" });
  const trace = [];
  async function read(name, args) {
    const entry = { tool: name, arguments: args };
    trace.push(entry);
    const result = await client.callTool({ name, arguments: args });
    if (result.isError || result.content[0]?.type !== "text") throw new Error("Tool read failed");
    return JSON.parse(result.content[0].text);
  }
  try {
    const demo = await createDeclarationDemo(snapshot);
    const ontology = demo.ontology(DEMO_WORKSPACE);
    registerWorkspaceReads(server, DEMO_WORKSPACE, demo.pipelines, undefined, ontology);
    registerOntologyTools(server, ontology);
    const [caller, receiver] = InMemoryTransport.createLinkedPair();
    await server.connect(receiver);
    await client.connect(caller);
    const run = await read("get_pipeline_run", {runId: demo.runId});
    trace.at(-1).result = {title: run.title, references: run.materials.map(m => m.title)};
    const sample = await read("summarize_declaration_sample", {runId: run.id, materialId: run.materials[0].id});
    trace.at(-1).result = {areaRecords: sample.areaRecords, distinctDeclarations: sample.distinctDeclarations, verifiedRows: sample.foundrySources.length};
    let brief = sample.areaRecords + " area records cover " + sample.distinctDeclarations + (sample.distinctDeclarations === 1 ? " declaration. The sample lists " : " declarations. The sample lists ") + sample.records.map(r => r.designatedArea).join(", ") + ".";
    if (county) {
      const normalize = value => value.replace(/\s*(?:\(county\)| county)$/i, "").trim().toLowerCase();
      const row = sample.records.find(r => normalize(r.designatedArea) === normalize(county));
      if (row) {
        const object = await read("get_ontology_object", {objectType: "Declaration", primaryKey: row.id});
        trace.at(-1).result = {id: object.primaryKey, ...object.properties};
        brief = object.properties.designatedArea + " appears under declaration " + object.properties.disasterNumber + " for " + object.properties.incidentType + ". Source row: " + object.primaryKey + ".";
      } else {
        brief = "No matching row for “" + county + "” in this snapshot. Check the full dataset before drawing conclusions about that county.";
      }
    }
    return res.status(200).json({brief, trace, source: sample.sourceUrl, hash: sample.contentSha256, limit: sample.limit});
  } catch {
    return res.status(503).json({error: "The analyst could not verify the source. Try again.", trace});
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

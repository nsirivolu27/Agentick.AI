import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { OntologyReader } from "./ontology.js";
import { isDeclarationMaterial, materialSchema, type Material } from "./materials.js";
import { PipelineError } from "./pipeline.js";
import { OntologyError } from "./ontology.js";

const datasetPath = "/api/open/v2/DisasterDeclarationsSummaries";
const sampleSchema = z.object({
  metadata: z.object({
    version: z.literal("v2"),
    entityname: z.literal("DisasterDeclarationsSummaries"),
    rundate: z.string().datetime(),
    url: z.string().startsWith(datasetPath),
  }),
  DisasterDeclarationsSummaries: z.array(z.object({
    id: z.string().trim().min(1).max(120),
    disasterNumber: z.number().int().positive().safe(),
    state: z.string().regex(/^[A-Z]{2}$/),
    declarationDate: z.string().datetime(),
    incidentType: z.string().trim().min(1).max(120),
    designatedArea: z.string().trim().min(1).max(200),
  })).max(10),
});

export function declarationSample(material: Material) {
  let payload: unknown;
  try { payload = JSON.parse(material.content); }
  catch { throw new PipelineError(400, "Attach the JSON response from the OpenFEMA declarations API."); }
  const parsed = sampleSchema.safeParse(payload);
  if (!parsed.success) throw new PipelineError(400, "Invalid OpenFEMA field: " + parsed.error.issues[0]!.path.join("."));
  const { metadata, DisasterDeclarationsSummaries: records } = parsed.data;
  const url = new URL(metadata.url, "https://www.fema.gov");
  if (url.pathname !== datasetPath || url.hash || !material.url || new URL(material.url).href !== url.href) {
    throw new PipelineError(400, "The attached source URL must match the OpenFEMA declaration query in metadata.url.");
  }
  if (new Set(records.map(row => row.id)).size !== records.length) throw new PipelineError(400, "Duplicate OpenFEMA record id.");
  // The same declaration can cover several areas. Neither count describes the entire dataset.
  return {
    materialId: material.id, source: material.title, sourceUrl: url.href, retrievedAt: metadata.rundate,
    contentSha256: createHash("sha256").update(material.content).digest("hex"),
    areaRecords: records.length, distinctDeclarations: new Set(records.map(row => row.disasterNumber)).size, records,
    limit: "Counts describe only the attached snapshot. Individual assistance eligibility is outside its scope.",
  };
}

export function declarationBrief(sample: ReturnType<typeof declarationSample>): string {
  const rows = sample.records.map(row =>
    `#${row.disasterNumber} | ${row.state} | ${row.incidentType} | ${row.declarationDate.slice(0, 10)} | ${row.designatedArea}`);
  return [
    `OpenFEMA snapshot: ${sample.areaRecords} area records, ${sample.distinctDeclarations} distinct declaration${sample.distinctDeclarations === 1 ? "" : "s"}.`,
    ...rows,
    `Source: ${sample.source} (${sample.sourceUrl})`,
    `Source run time (UTC): ${sample.retrievedAt}`,
    `Snapshot SHA-256: ${sample.contentSha256}`,
    sample.limit,
    "Next check: review the full declaration and current designations before using this brief for a decision.",
  ].join("\n");
}

export async function verifiedDeclarationSample(material: Material, reader: OntologyReader, signal?: AbortSignal) {
  if (reader.catalog().mode !== "foundry") throw new Error("A configured Foundry Declaration mapping is required.");
  const sample = declarationSample(material);
  if (!sample.records.length) throw new Error("Attach at least one declaration record to verify against Foundry.");
  const sources = await Promise.all(sample.records.map(async row => {
    signal?.throwIfAborted();
    const object = await reader.get({ objectType: "Declaration", primaryKey: row.id }, signal);
    signal?.throwIfAborted();
    const fields = object.properties;
    if (object.source.mode !== "foundry" || object.primaryKey !== row.id || fields.disasterNumber !== row.disasterNumber
      || fields.state !== row.state || fields.incidentType !== row.incidentType || fields.designatedArea !== row.designatedArea
      || typeof fields.declarationDate !== "string" || Date.parse(fields.declarationDate) !== Date.parse(row.declarationDate)) {
      throw new OntologyError("The OpenFEMA record does not match the workspace's Foundry Declaration: " + row.id);
    }
    return { primaryKey: object.primaryKey, ...object.source };
  }));
  return { ...sample, foundrySources: sources };
}
export async function declarationEvidence(materials: Material[], reader?: OntologyReader): Promise<Material | undefined> {
  const samples = materials.filter(isDeclarationMaterial);
  if (!samples.length) return undefined;
  if (samples.length !== 1) throw new OntologyError("Attach one bounded OpenFEMA declaration sample per run.");
  if (!reader || reader.catalog().mode !== "foundry") throw new OntologyError("Connect the workspace's live Palantir Foundry Ontology before starting an OpenFEMA run.");
  const verified = await verifiedDeclarationSample(samples[0]!, reader);
  return materialSchema.parse({ id: randomUUID(), title: "Foundry: verified declaration sample",
    url: verified.sourceUrl, content: JSON.stringify(verified) });
}

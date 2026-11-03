import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { FEDERAL_SERVICE_STARTER } from "../workbench/materials.js";
import { declarationEvidence, declarationSample } from "../workbench/declaration-sample.js";

const path = "/api/open/v2/DisasterDeclarationsSummaries?$top=5";
const metadata = { version: "v2", entityname: "DisasterDeclarationsSummaries", url: path, rundate: "2026-01-02T12:00:00Z", count: 0 };
const row = { id: "first", disasterNumber: 123, state: "VA", declarationDate: "2026-01-01T00:00:00Z", incidentType: "Test incident", designatedArea: "Area A" };
function material(rows: unknown[]) {
  return { id: randomUUID(), title: "Synthetic declarations", url: "https://www.fema.gov" + path,
    content: JSON.stringify({ metadata, DisasterDeclarationsSummaries: rows }) };
}

test("declaration evidence counts distinct declarations and preserves the selected area rows", () => {
  const data = material([row, { ...row, id: "second", designatedArea: "Area B" }]);
  const brief = declarationSample(data);
  assert.equal(brief.areaRecords, 2);
  assert.equal(brief.distinctDeclarations, 1);
  assert.deepEqual(brief.records.map(item => item.designatedArea), ["Area A", "Area B"]);
  assert.equal(brief.retrievedAt, metadata.rundate);
  assert.match(brief.contentSha256, /^[a-f0-9]{64}$/);
  assert.notEqual(brief.contentSha256, declarationSample(material([row])).contentSha256);
  assert.equal(declarationSample(material([])).distinctDeclarations, 0);
});

test("the federal starter requires Foundry even before the catalogue link is replaced with data", async () => {
  await assert.rejects(declarationEvidence([{ id: randomUUID(), title: "Public dataset", content: "", url: FEDERAL_SERVICE_STARTER.source }]), /live Palantir Foundry/);
});

test("declaration evidence rejects malformed rows, duplicate ids and a mismatched source", () => {
  assert.throws(() => declarationSample(material([row, row])), /Duplicate/);
  assert.throws(() => declarationSample(material([{ ...row, disasterNumber: null }])), /disasterNumber/);
  assert.throws(() => declarationSample({ ...material([row]), url: "https://example.org" + path }), /source URL/);
  assert.throws(() => declarationSample({ ...material([row]), content: "" }), /JSON response/);
});

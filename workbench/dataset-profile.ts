import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { projectPath } from "./bot-project.js";
import { PipelineError } from "./pipeline.js";

/**
 * A deterministic profile of a tabular dataset in the attached repository.
 * It is computed by this code, never by a model, so an agent can reason about
 * row counts, column types and ranges without reading megabytes of rows and
 * without running any code. The profile names the file hash it was built from.
 */

export const DATASET_PROFILE_MAX_BYTES = 4_000_000;
const MAX_COLUMNS = 60;
const MAX_EXAMPLES = 3;

export interface ColumnProfile {
  name: string;
  /** number: every present value parses as a number; text: otherwise; empty: no values at all. */
  type: "number" | "text" | "empty";
  present: number;
  missing: number;
  distinct: number;
  min?: number;
  max?: number;
  mean?: number;
  examples: string[];
}
export interface DatasetProfile {
  profileOf: string;
  format: "csv" | "tsv" | "json" | "jsonl";
  fileSha256: string;
  bytes: number;
  rows: number;
  columns: ColumnProfile[];
  warnings: string[];
}

function formatOf(path: string): DatasetProfile["format"] {
  const extension = path.toLowerCase().split(".").pop();
  if (extension === "csv") return "csv";
  if (extension === "tsv") return "tsv";
  if (extension === "json") return "json";
  if (extension === "jsonl" || extension === "ndjson") return "jsonl";
  throw new PipelineError(400, "Datasets must be .csv, .tsv, .json or .jsonl files.");
}

/** RFC 4180 style parsing: quoted fields may hold the delimiter, newlines and doubled quotes. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === "\"") {
        if (text[index + 1] === "\"") { field += "\""; index++; } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === "\"") quoted = true;
    else if (char === delimiter) { row.push(field); field = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += char;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(item => item.length > 1 || (item[0] ?? "").trim() !== "");
}

function records(text: string, format: DatasetProfile["format"], warnings: string[]): { columns: string[]; rows: Record<string, unknown>[] } {
  if (format === "csv" || format === "tsv") {
    const table = parseDelimited(text, format === "csv" ? "," : "\t");
    const header = table[0] ?? [];
    if (!header.length) throw new PipelineError(400, "The dataset has no header row.");
    const columns = header.map((name, index) => name.trim() || `column_${index + 1}`);
    let ragged = 0;
    const rows = table.slice(1).map(cells => {
      if (cells.length !== columns.length) ragged++;
      return Object.fromEntries(columns.map((name, index) => [name, cells[index] ?? ""]));
    });
    if (ragged) warnings.push(`${ragged} rows do not have ${columns.length} cells; missing cells count as missing values.`);
    return { columns, rows };
  }
  let parsed: unknown;
  if (format === "jsonl") {
    parsed = text.split(/\r?\n/).filter(line => line.trim()).map((line, index) => {
      try { return JSON.parse(line) as unknown; } catch { throw new PipelineError(400, `Line ${index + 1} is not valid JSON.`); }
    });
  } else {
    try { parsed = JSON.parse(text); } catch { throw new PipelineError(400, "The file is not valid JSON."); }
    // OpenFEMA style files wrap the rows in one named array; use it when there is exactly one.
    if (parsed && !Array.isArray(parsed) && typeof parsed === "object") {
      const arrays = Object.entries(parsed as Record<string, unknown>).filter(([, value]) => Array.isArray(value));
      if (arrays.length === 1) { warnings.push(`Rows were read from the "${arrays[0]![0]}" array.`); parsed = arrays[0]![1]; }
    }
  }
  if (!Array.isArray(parsed)) throw new PipelineError(400, "A JSON dataset must be an array of objects or an object holding one array.");
  const rows = parsed.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item));
  if (rows.length !== parsed.length) warnings.push(`${parsed.length - rows.length} entries are not objects and were skipped.`);
  const columns: string[] = [];
  for (const row of rows) for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  return { columns, rows };
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function profileDataset(text: string, profileOf: string, format: DatasetProfile["format"]): DatasetProfile {
  const warnings: string[] = [];
  const { columns, rows } = records(text, format, warnings);
  if (columns.length > MAX_COLUMNS) warnings.push(`Only the first ${MAX_COLUMNS} of ${columns.length} columns are profiled.`);
  const profiles = columns.slice(0, MAX_COLUMNS).map((name): ColumnProfile => {
    const values = rows.map(row => cell(row[name]).trim());
    const present = values.filter(value => value !== "");
    const numbers = present.map(Number);
    const numeric = present.length > 0 && numbers.every(number => Number.isFinite(number));
    const distinct = new Set(present).size;
    const examples = [...new Set(present)].slice(0, MAX_EXAMPLES).map(value => value.slice(0, 60));
    const column: ColumnProfile = { name, type: present.length ? (numeric ? "number" : "text") : "empty", present: present.length, missing: values.length - present.length, distinct, examples };
    if (numeric) {
      column.min = Math.min(...numbers); column.max = Math.max(...numbers);
      column.mean = Number((numbers.reduce((sum, number) => sum + number, 0) / numbers.length).toFixed(4));
    }
    return column;
  });
  return { profileOf, format, fileSha256: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text), rows: rows.length, columns: profiles, warnings };
}

/** Profile a dataset inside the checkout. The same path rules apply as for reading a file; the size limit is larger. */
export function profileProjectFile(root: string, name: string): DatasetProfile | null {
  const format = formatOf(name);
  const path = projectPath(root, name);
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.size > DATASET_PROFILE_MAX_BYTES) throw new PipelineError(400, `Choose a dataset smaller than ${DATASET_PROFILE_MAX_BYTES / 1_000_000} MB.`);
    const text = readFileSync(path, "utf8");
    if (text.includes("\0") || text.includes("�")) throw new PipelineError(400, "Binary or non-UTF-8 files are unavailable.");
    return profileDataset(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, name, format);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

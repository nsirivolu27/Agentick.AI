import type { BotAttempt } from "./bot-schema.js";
import { escape, more } from "./ui.js";

export function recordedHandoff(output: string, attempt?: Pick<BotAttempt, "id" | "proposalHash" | "checkout" | "checks">): string {
  const full = `<pre class="pre">${escape(output)}</pre>`;
  if (!attempt) return full;
  const trace = `\n\nBot attempt: ${attempt.id}\nProposal: ${attempt.proposalHash}\nCheckout: ${attempt.checkout}\nChecks: ${attempt.checks.length ? attempt.checks.map(check => check.passed ? "passed" : "failed").join(", ") : "not run"}`;
  // Only collapse the exact runtime footer. Similar prose in an answer must remain visible.
  if (!output.endsWith(trace)) return full;
  return `<div class="handoff-answer">${escape(output.slice(0, -trace.length))}</div>${more("Execution record · included in approval", `<pre class="pre">${escape(trace.trimStart())}</pre>`)}`;
}

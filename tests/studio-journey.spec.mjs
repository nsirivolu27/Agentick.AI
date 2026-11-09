import { test, expect } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const axe = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const artifact = process.env.MAGENTIC_UI_ARTIFACTS ?? fileURLToPath(new URL("../test-results/studio-screenshots/", import.meta.url));
mkdirSync(artifact, { recursive: true });

async function accessibility(page) {
  await page.evaluate(axe);
  return page.evaluate(() => window.axe.run(document, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
  }));
}

async function setIdentity(page, identity) {
  const account = page.locator(".console-account");
  if (!(await account.locator(".account-popover").isVisible())) await account.locator("summary").click();
  await page.locator("#identity").selectOption(identity);
}

test("saved template through independently approved workflow handoff", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));

  await page.goto("/#/agent-studio");
  await expect(page.getByRole("heading", { name: "Agent Studio", exact: true })).toBeVisible();
  await expect(page.locator(".sidebar")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await page.getByRole("link", { name: /Internal documentation assistant/ }).click();
  await expect(page.locator("#agent-studio-editor")).toBeVisible();
  await expect(page.locator('#agent-studio-editor select[name="model"]')).toHaveValue("demo-scripted");
  await expect(page.locator('#agent-studio-editor input[name="tools"][value="read_project_file"]')).toBeChecked();
  await expect(page.locator('#agent-studio-editor input[name="requireSourceRead"]')).toBeChecked();
  await page.getByRole("textbox", { name: "Required source paths", exact: true }).fill("SOP.md");
  await page.locator('#agent-studio-editor input[name="name"]').fill("SOP access guide");
  await page.screenshot({ path: `${artifact}/studio-desktop-setup.png`, fullPage: true });

  // Simulate a real network failure, not a successful fake API response. The
  // entered draft must remain editable so the retry can reach the real demo API.
  await page.route("**/api/pipeline", route =>
    route.request().method() === "POST" ? route.abort("failed") : route.continue());
  await page.getByRole("button", { name: "Save agent", exact: true }).click();
  await expect(page.locator("#notice")).not.toBeEmpty();
  await expect(page.locator('#agent-studio-editor input[name="name"]')).toHaveValue("SOP access guide");
  await page.unroute("**/api/pipeline");
  await page.getByRole("button", { name: "Save agent", exact: true }).click();

  await expect(page).toHaveURL(/#\/agent-studio\/[^/]+\/test$/);
  const agentId = new URL(page.url()).hash.match(/^#\/agent-studio\/([^/]+)/)?.[1];
  expect(agentId).toBeTruthy();
  await expect(page.locator(".agent-test-cases li:first-child strong")).toHaveText("Routine access request");
  await expect(page.locator(".agent-test-cases li:first-child form button")).toHaveClass(/primary/);
  await page.getByRole("button", { name: "Run test", exact: true }).click();
  const result = page.getByRole("article", { name: "Test result" });
  await expect(result).toContainText("Execution finished", { timeout: 30_000 });
  await expect(result).toContainText("Read SOP.md");
  await expect(result).toContainText("two business days");
  await expect(result.getByRole("heading", { name: "Quality review", exact: true })).toBeVisible();
  await expect(page.locator("#agent-test-review")).toBeVisible();
  await expect(page.locator("#agent-test-review")).toContainText("separate from the execution finishing");
  await page.screenshot({ path: `${artifact}/studio-desktop-test-answer.png`, fullPage: true });

  await page.locator('#agent-test-review input[value="pass"]').check();
  await page.locator('#agent-test-review textarea[name="note"]').fill("The answer cites the source and reflects the stated approval and response process.");
  await page.getByRole("button", { name: "Record review", exact: true }).click();
  await expect(page.locator("#agent-test-review")).toHaveCount(0);
  await expect(result).toContainText("pass by demo.operator");

  await page.getByRole("link", { name: "Assignment", exact: true }).click();
  await expect(page.locator("#agent-studio-assign")).toBeVisible();
  await page.locator("#agent-studio-assign select[name=stage]").selectOption("answer");
  await page.getByRole("button", { name: "Assign saved agent", exact: true }).click();
  await expect(page.locator("#notice")).toContainText("Assigned for future runs");
  await expect(page.locator('.agent-studio-review[aria-label="Run readiness"]')).toBeVisible();
  await page.screenshot({ path: `${artifact}/studio-desktop-assignment.png`, fullPage: true });

  await page.locator("#agent-studio-start input[name=title]").fill("Studio browser journey");
  await page.locator("#agent-studio-start textarea[name=brief]").fill("Read SOP.md. Explain the access approval, response target and missing-approval handling. Cite the source.");
  await page.getByRole("button", { name: "Start workflow", exact: true }).click();
  await expect(page.locator(".work-title h2")).toHaveText("Studio browser journey");
  await expect(page.getByRole("button", { name: "Run this agent", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Run this agent", exact: true }).click();
  const workProgress = page.locator("#work-progress");
  await expect(workProgress).toContainText("Read SOP.md", { timeout: 30_000 });
  await expect(workProgress).toContainText("two business days");
  await expect(workProgress).toContainText("Original agent output");
  await page.getByRole("button", { name: "Accept and continue", exact: true }).click();
  await expect(page.locator(".work-phases")).toContainText("Check the answer");
  await expect(page.getByRole("button", { name: "Run this agent", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Run this agent", exact: true }).click();
  await expect(workProgress).toContainText("Read SOP.md", { timeout: 30_000 });
  await expect(workProgress).toContainText("two business days");
  await page.getByRole("button", { name: "Submit for independent review", exact: true }).click();
  await expect(workProgress).toContainText("0 of 2 approvals");
  await expect(workProgress.getByRole("button", { name: "Approve this handoff", exact: true })).toHaveCount(0);

  const pending = await page.request.get("/api/workspace", { headers: { authorization: "Bearer demo.operator" } });
  expect(pending.ok()).toBe(true);
  const pendingSnapshot = await pending.json();
  const run = pendingSnapshot.pipelines.runs.find(item => item.title === "Studio browser journey");
  expect(run).toBeTruthy();
  const selfApproval = await page.request.post("/api/pipeline", {
    headers: { authorization: "Bearer demo.operator" },
    data: { action: "approve", runId: run.id, expectedRevision: run.revision },
  });
  expect(selfApproval.status()).toBe(403);

  await setIdentity(page, "demo.reviewer-one");
  await expect(workProgress.getByRole("button", { name: "Approve this handoff", exact: true })).toBeVisible();
  await workProgress.getByRole("button", { name: "Approve this handoff", exact: true }).click();
  await expect(workProgress).toContainText("1 of 2 approvals");
  await expect(workProgress.getByRole("button", { name: "Approve this handoff", exact: true })).toHaveCount(0);
  const firstReview = await page.request.get("/api/workspace", { headers: { authorization: "Bearer demo.reviewer-one" } });
  const firstSnapshot = await firstReview.json();
  const oneApprovalRun = firstSnapshot.pipelines.runs.find(item => item.id === run.id);
  expect(oneApprovalRun.stages[1].approvals).toEqual(["demo.reviewer-one"]);
  const repeatApproval = await page.request.post("/api/pipeline", {
    headers: { authorization: "Bearer demo.reviewer-one" },
    data: { action: "approve", runId: run.id, expectedRevision: oneApprovalRun.revision },
  });
  expect(repeatApproval.status()).toBe(409);

  await setIdentity(page, "demo.reviewer-two");
  await workProgress.locator("summary").filter({ hasText: "Request changes" }).click();
  await workProgress.getByRole("textbox", { name: "Change request", exact: true }).fill("State that the source does not establish a deadline for missing team-owner approval.");
  await workProgress.getByRole("button", { name: "Return to author", exact: true }).click();
  await expect(workProgress).not.toContainText("1 of 2 approvals");
  await setIdentity(page, "demo.operator");
  await workProgress.getByRole("textbox", { name: "Revised handoff", exact: true }).fill("Reviewed SOP: a routine request needs the team owner's approval. The two-business-day response window does not establish a deadline for obtaining missing team-owner approval.");
  await workProgress.getByRole("button", { name: "Resubmit for review", exact: true }).click();
  await expect(workProgress).toContainText("0 of 2 approvals");
  await setIdentity(page, "demo.reviewer-one");
  await workProgress.getByRole("button", { name: "Approve this handoff", exact: true }).click();
  await expect(workProgress).toContainText("1 of 2 approvals");
  await setIdentity(page, "demo.reviewer-two");
  await workProgress.getByRole("button", { name: "Approve this handoff", exact: true }).click();
  await expect(workProgress).toContainText("Approved");
  const complete = await page.request.get("/api/workspace", { headers: { authorization: "Bearer demo.reviewer-two" } });
  expect(complete.ok()).toBe(true);
  const completeSnapshot = await complete.json();
  const completedRun = completeSnapshot.pipelines.runs.find(item => item.id === run.id);
  expect(completedRun.status).toBe("complete");
  expect(completedRun.stages[1].approvals).toEqual(["demo.reviewer-one", "demo.reviewer-two"]);
  expect(completedRun.stages[1].revisions).toHaveLength(3);
  expect(completedRun.stages[1].approvalRecords.every(record => record.version === 3)).toBe(true);
  const auditResponse = await page.request.get(`/api/audit-package?run=${run.id}`, { headers: { authorization: "Bearer demo.reviewer-two" } });
  expect(auditResponse.ok()).toBe(true);
  const audit = await auditResponse.json();
  expect(audit.toolActivity.some(activity => activity.events.some(event => event.message.includes("SOP.md")))).toBe(true);
  expect(Object.values(audit.sourceHistory).flat().some(source => source.kind === "project-file" && source.path === "SOP.md" && source.content.includes("team owner's approval"))).toBe(true);
  expect(pageErrors).toEqual([]);
});

test("test portal compares frozen inputs and refuses a passing review for failed assertions", async ({ page }) => {
  await page.goto("/#/agent-studio");
  await page.locator(".agent-studio-card h2 a").first().click();
  await page.locator(".agent-studio-nav").getByRole("link", { name: "Test", exact: true }).click();
  const run = async () => {
    await page.getByRole("button", { name: "Run test", exact: true }).first().click();
    await expect(page.locator(".agent-test-result .agent-test-status")).toContainText("Execution finished", { timeout: 30000 });
  };
  await run(); await run();
  await expect(page.getByText(/Same saved inputs, suite and frozen source hashes/)).toBeVisible();
  await expect(page.locator(".agent-test-result")).toContainText("source_read: SOP.md");
  await page.locator("summary").filter({ hasText: "Frozen source evidence" }).click();
  await expect(page.locator(".agent-test-result")).toContainText('"sha256"');
  await page.getByRole("button", { name: "Edit", exact: true }).first().click();
  await page.locator("summary").filter({ hasText: "Automatic assertions" }).click();
  await page.getByRole("textbox", { name: "Assertions JSON", exact: true }).fill('[{"kind":"contains","value":"NO_SUCH_PHRASE_IN_THE_SOURCE"}]');
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.locator(".agent-test-result")).toContainText("Out of date.");
  await run();
  await expect(page.locator(".agent-test-result")).toContainText("Failed");
  await page.getByRole("radio", { name: "Pass", exact: true }).check();
  await page.getByRole("button", { name: "Record review", exact: true }).click();
  await expect(page.locator("#notice")).toContainText("Failed execution or assertions");
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${artifact}/test-portal-failed-assertion-390.png`, fullPage: true });
  expect((await accessibility(page)).violations).toEqual([]);
});

test("canvas input bindings and output contracts survive save and reload", async ({ page }) => {
  await page.goto("/#/canvas");
  await page.locator(".canvas-node-select").nth(1).click();
  const form = page.locator("#canvas-stage-form");
  await form.getByRole("combobox", { name: "Output inputs", exact: true }).selectOption("none");
  await form.getByRole("textbox", { name: "Output contract", exact: true }).fill("Cite selected evidence and list missing facts.");
  await page.getByRole("button", { name: "Save workflow", exact: true }).click();
  await expect(page.locator("#notice")).toContainText("Workflow saved");
  await page.reload();
  await page.locator(".canvas-node-select").nth(1).click();
  await expect(form.getByRole("combobox", { name: "Output inputs", exact: true })).toHaveValue("none");
  await expect(form.getByRole("textbox", { name: "Output contract", exact: true })).toHaveValue("Cite selected evidence and list missing facts.");
  await form.locator('input[name="inputStages"]').first().check();
  await expect(form.getByRole("combobox", { name: "Output inputs", exact: true })).toHaveValue("selected");
  await page.getByRole("button", { name: "Save workflow", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save workflow", exact: true })).toBeDisabled();
  await page.reload();
  await page.locator(".canvas-node-select").nth(1).click();
  await expect(form.locator('input[name="inputStages"]').first()).toBeChecked();
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
      `canvas overflows at ${width}px`).toBe(true);
  }
  await page.screenshot({ path: `${artifact}/workflow-bindings-390.png`, fullPage: true });
  expect((await accessibility(page)).violations).toEqual([]);
});

test("services, preferences, keyboard access, and responsive pages", async ({ page }) => {
  await page.goto("/#/agent-studio");
  await page.getByRole("button", { name: "Open services", exact: true }).click();
  const services = page.getByRole("dialog", { name: "Services", exact: true });
  await expect(services).toBeVisible();
  await expect(page.locator("#service-search")).toBeFocused();
  await page.getByRole("searchbox", { name: "Find a service" }).fill("agents");
  await expect(page.locator('a.nav[data-route="agent-studio"]')).toBeVisible();
  await expect(page.locator('a.nav[data-route="workflows"]')).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.locator("#nav-toggle")).toBeFocused();
  await expect(page.locator("main")).not.toHaveAttribute("inert", "");
  await expect(page.locator(".sidebar")).toHaveCount(0);

  await page.locator(".console-account > summary").click();
  await page.locator("#theme-select").selectOption("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.reload();
  await expect(page.locator("#theme-select")).toHaveValue("light");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  for (const width of [1440, 1024, 768, 390, 360]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await expect(page.locator("#title")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
      `document overflows at ${width}px`).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${artifact}/studio-mobile-390.png`, fullPage: true });
  const audit = await accessibility(page);
  expect(audit.violations).toEqual([]);
  await page.goto("/#/agent-studio/new?preset=public-analyst");
  await expect(page.getByRole("textbox", { name: "Required source paths", exact: true }))
    .toHaveValue("examples/ontology/openfema/data/virginia-snapshot.json");
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
      `analyst setup overflows at ${width}px`).toBe(true);
  }
  await page.screenshot({ path: `${artifact}/studio-public-analyst-390.png`, fullPage: true });
  expect((await accessibility(page)).violations).toEqual([]);
});

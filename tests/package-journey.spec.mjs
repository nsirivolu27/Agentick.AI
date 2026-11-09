import { test, expect } from "@playwright/test";
import { readFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
const axe = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
const operator = "demo.operator";
async function call(page, path, actor = operator, data) {
  const result = await page.request[data ? "post" : "get"](path, {
    headers: { authorization: "Bearer " + actor }, ...(data ? { data } : {}),
  });
  expect(result.ok(), await result.text()).toBe(true);
  return result.json();
}
async function identity(page, actor) {
  if (!(await page.locator(".account-popover").isVisible())) await page.locator(".console-account > summary").click();
  await page.locator("#identity").selectOption(actor);
  await expect(page.locator("#operator-context")).toContainText(actor);
  if (await page.locator(".account-popover").isVisible()) await page.locator(".console-account > summary").click();
}
test("tested package is independently reviewed, installed, assigned and retired through the UI", async ({ page }) => {
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  const initial = await call(page, "/api/workspace");
  const tests = await call(page, "/api/agent-tests");
  const saved = tests.cases[0];
  await call(page, "/api/agent-tests", operator, { action: "run", caseId: saved.id, expectedVersion: initial.pipelines.version });
  await expect.poll(async () => (await call(page, "/api/agent-tests")).runs.at(-1)?.status).toBe("succeeded");
  const run = (await call(page, "/api/agent-tests")).runs.at(-1);
  await call(page, "/api/agent-tests", "demo.reviewer-one", { action: "review", runId: run.id, verdict: "pass", note: "Synthetic source checked for this UI test." });
  await page.goto("/#/marketplace?collection=packages");
  await page.locator('[name="agentId"]').selectOption(saved.agentId);
  await page.getByRole("button", { name: "Request package review", exact: true }).click();
  const card = page.locator(".agent-packages article").first();
  await expect(card).toContainText("0/2 approvals");
  await expect(card.getByRole("button", { name: "Install version", exact: true })).toBeDisabled();
  await identity(page, "demo.reviewer-one");
  await card.getByRole("button", { name: "Approve version", exact: true }).click();
  await expect(card).toContainText("1/2 approvals");
  await identity(page, "demo.reviewer-two");
  await card.getByRole("button", { name: "Approve version", exact: true }).click();
  await expect(card).toContainText("Ready to install");
  await identity(page, operator);
  await card.getByRole("button", { name: "Install version", exact: true }).click();
  await expect(card.getByRole("button", { name: "Installed", exact: true })).toBeDisabled();
  const download = page.waitForEvent("download");
  await card.getByRole("link", { name: "Export private package evidence" }).click();
  expect((await download).suggestedFilename()).toMatch(/^agent-package-.*\.json$/);
  await card.locator('[name="stageId"]').selectOption("answer");
  await card.getByRole("button", { name: "Assign installed version", exact: true }).click();
  await expect(page.locator("#notice")).toContainText("Package updated");
  await card.locator("summary").filter({ hasText: "Definition and evaluation" }).click();
  mkdirSync(".testbuild/package-screenshots", { recursive: true });
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.evaluate(axe);
    expect((await page.evaluate(() => window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] },
    }))).violations).toEqual([]);
    await page.screenshot({ path: ".testbuild/package-screenshots/package-" + width + ".png", fullPage: true });
  }
  await card.getByRole("button", { name: "Retire version", exact: true }).click();
  await expect(card).toContainText("Retired");
  await expect(card.getByRole("button", { name: "Assign installed version", exact: true })).toBeDisabled();
  expect(errors).toEqual([]);
});

test("source-bound quality form reports insufficient citations without claiming accuracy", async ({ page }) => {
  const state = await call(page, "/api/workspace");
  const tests = await call(page, "/api/agent-tests");
  const saved = tests.cases[1];
  await call(page, "/api/agent-tests", operator, { action: "save_case", id: saved.id, agentId: saved.agentId,
    title: saved.title, prompt: saved.prompt, source: saved.source,
    qualityPolicy: { minSupportedRate: 1, minCitationRate: 1, expectedTools: ["read_project_file"] } });
  await call(page, "/api/agent-tests", operator, { action: "run", caseId: saved.id, expectedVersion: state.pipelines.version });
  await expect.poll(async () => (await call(page, "/api/agent-tests")).runs.at(-1)?.status).toBe("succeeded");
  await page.goto("/#/agent-studio/" + saved.agentId + "/test");
  await identity(page, "demo.reviewer-one");
  const form = page.locator("#agent-test-review");
  await expect(form.locator("[data-quality-review]")).toBeVisible();
  await form.getByRole("radio", { name: "Pass", exact: true }).check();
  await form.locator('[name="qualityComplete"]').check();
  await form.getByRole("button", { name: "Record review", exact: true }).click();
  await expect(page.locator("#notice")).toContainText("quality thresholds");
  await form.getByRole("radio", { name: "Fail", exact: true }).check();
  await form.getByRole("button", { name: "Record review", exact: true }).click();
  const reviewed = (await call(page, "/api/agent-tests")).runs.at(-1);
  const unitCount = reviewed.summary.split(/\r?\n/).filter(line => line.trim()).length;
  await expect(page.locator(".agent-test-result")).toContainText("0/" + unitCount + " valid source citations");
  await expect(page.locator(".agent-test-result")).toContainText("fail by demo.reviewer-one");
});

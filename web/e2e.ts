import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { chromium, firefox } from "playwright-core";

const root = resolve(import.meta.dirname, "..");
const actual = join(root, "docs/design/actual");
const tooling = join(root, ".tooling");
await mkdir(actual, { recursive: true });
await mkdir(tooling, { recursive: true });
await mkdir(join(root, "web/public"), { recursive: true });
const profile = await mkdtemp(join(root, ".p-"));
await mkdir(join(profile, "t"));
await mkdir(join(profile, "c"));
await mkdir(join(profile, "r"));
await mkdir(join(profile, "config"));
const browserPath = (await import("node:fs")).existsSync("/usr/bin/brave")
  ? "/usr/bin/brave"
  : "/usr/bin/firefox";
const engine = browserPath.endsWith("brave") ? chromium : firefox;
const port = await new Promise<number>((done, fail) => {
  const server = createServer();
  server.once("error", fail);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const chosen = typeof address === "object" && address ? address.port : 0;
    server.close(() => done(chosen));
  });
});
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["src/server.ts"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    PATH: process.env.PATH ?? "",
    HOME: profile,
    TMPDIR: join(profile, "t"),
    XDG_CACHE_HOME: join(profile, "c"),
    XDG_CONFIG_HOME: join(profile, "config"),
    XDG_RUNTIME_DIR: join(profile, "r"),
    DATABASE_PATH: ":memory:",
    PAYPAL_MODE: "fake",
    PORT: String(port),
    NODE_ENV: "test",
  },
});
let serverError = "";
server.stderr?.on("data", (chunk) => {
  serverError += String(chunk);
});
let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) break;
    } catch { /* Starting. */ }
    if (attempt === 99) throw new Error(`API did not start: ${serverError}`);
    await new Promise((done) => setTimeout(done, 100));
  }
  process.env.HOME = profile;
  process.env.TMPDIR = join(profile, "t");
  process.env.XDG_CACHE_HOME = join(profile, "c");
  process.env.XDG_CONFIG_HOME = join(profile, "config");
  process.env.XDG_RUNTIME_DIR = join(profile, "r");
  context = await engine.launchPersistentContext(profile, {
    executablePath: browserPath,
    headless: true,
    viewport: { width: 1440, height: 900 },
    args: browserPath.endsWith("brave")
      ? ["--no-sandbox", "--disable-dev-shm-usage", "--disable-crash-reporter", "--disable-breakpad"]
      : [],
    env: { ...process.env },
  });
  const page = context.pages()[0] ?? await context.newPage();
  page.on("pageerror", (error) => process.stderr.write(`Browser error: ${error.message}\n`));
  let shotCount = 0;
  const shot = async (name: string) => {
    await page.mouse.move(0, 0);
    await page.screenshot({ path: join(actual, name), fullPage: false, animations: "disabled" });
    shotCount++;
  };
  const open = async (path: string, signal: string) => {
    await page.goto(`${base}${path}`);
    try {
      await page.getByText(signal, { exact: false }).first().waitFor({ timeout: 8000 });
    } catch (error) {
      process.stderr.write(
        `Missing ${signal} at ${path}. Body: ${(await page.locator("body").innerText()).slice(0, 800)}\n`,
      );
      throw error;
    }
  };
  await open("/", "Start the demo");
  assert.equal(await page.getByRole("heading", { name: "Recall response for PayPal merchants" }).count(), 1);
  assert.equal(await page.getByText("Sandbox: no real money moves", { exact: false }).count(), 1);
  await shot("00-start.png");
  await page.getByRole("button", { name: "Start the demo" }).click();
  await page.waitForURL("**/recalls");
  await page.getByRole("heading", { name: "Recalls" }).waitFor();
  await page.getByText("Baby sleep pillow").waitFor();
  await page.locator(".nav-count").getByText("2").waitFor();
  await page.getByRole("button", { name: "Hazard" }).waitFor();
  await page.getByText("OECD portal").waitFor();
  await shot("01-recalls.png");
  await page.screenshot({ path: join(root, "web/public/recalls-preview.png"), clip: { x: 0, y: 0, width: 1440, height: 640 }, animations: "disabled" });
  await copyFile(join(root, "web/public/recalls-preview.png"), join(root, "web/dist/recalls-preview.png"));
  await open("/", "Start the demo");
  await page.locator(".cover-preview img").evaluate(async (image) => {
    const element = image as HTMLImageElement;
    await element.decode();
  });
  await shot("00-start.png");
  await open("/recalls", "Recalls");
  const search = page.getByRole("textbox", { name: "Search product, model, or source" });
  await search.fill("Lumen");
  assert.equal(await page.locator(".recalls-table tbody tr").count(), 1);
  await search.fill("");
  await page.getByRole("tab", { name: "My products" }).click();
  assert.equal(await page.locator(".recalls-table tbody tr").count(), 1);
  await page.getByRole("tab", { name: "All", exact: true }).click();
  await page.setViewportSize({ width: 768, height: 900 });
  await shot("recalls-768.png");
  await page.setViewportSize({ width: 1440, height: 900 });
  const firstCheckoutCheck = page.waitForResponse((response) =>
    response.url().endsWith("/v1/checkout/check")
  );
  await open("/store", "PayPal checkout is off");
  assert.equal((await firstCheckoutCheck).request().method(), "POST");
  await shot("store-before-block.png");
  await open("/recalls", "Recalls");
  await page.locator(".clickable-row").focus();
  await page.keyboard.press("Enter");
  await page.waitForURL("**/recalls/demo-lumen-mini-heater");
  await page.getByText("Official notice").waitFor();
  await page.getByRole("button", { name: "Read notice" }).click();
  await page.getByText("Confidence", { exact: false }).waitFor();
  await page.getByText("Confidence 0.96").waitFor({ timeout: 3000 });
  await page.getByRole("button", { name: "Stop sale" }).click();
  await page.getByText("Sale stopped").waitFor();
  await shot("02-recall-file.png");
  await page.getByRole("button", { name: "Review settlement plan" }).click();
  await page.waitForURL("**/plans/*");
  const planId = page.url().split("/").at(-1)!;
  await page.getByRole("heading", { name: "Approve plan" }).waitFor();
  // the plan is an AG Grid now: rows are .ag-row in DOM order (ensureDomOrder), cells by col-id
  const planRows = page.locator(".plan-table-grid .ag-row:not(.ag-row-pinned)");
  await planRows.first().locator('[col-id="orderId"]').getByText("#1042").waitFor();
  await planRows.first().getByText("12 d").waitFor();
  assert.deepEqual(await planRows.locator('[col-id="orderId"]').allTextContents(), [
    "#1042",
    "#1071",
    "#1019",
    "#0994",
    "#0871",
    "#0866",
    "#1103",
    "#1051",
    "#1060",
    "#1088",
    "#1077",
    "#1038",
  ]);
  assert.equal(
    await planRows.filter({ hasText: "#1103" }).locator('[col-id="amount"]').innerText(),
    "¥12,800 JPY",
  );
  assert.equal(
    await planRows.filter({ hasText: "#1088" }).locator('[col-id="amount"]').innerText(),
    "£99.00 GBP",
  );
  assert.equal(
    await planRows.filter({ hasText: "#1077" }).locator('[col-id="amount"]').innerText(),
    "$129.00 USD",
  );
  assert.match(await planRows.filter({ hasText: "#1042" }).innerText(), /12 d/);
  assert.match(await planRows.filter({ hasText: "#0994" }).innerText(), /178 d[\s\S]*2 days left in window/);
  assert.deepEqual(
    await page.locator(".budget-table tbody tr").evaluateAll((rows) =>
      rows.map((row) => ({
        currency: row.querySelector("td:first-child")?.textContent,
        moves: row.querySelector("td:nth-child(2)")?.textContent,
        budget: (row.querySelector("input") as HTMLInputElement).value,
      }))
    ),
    [
      { currency: "USD", moves: "$258.00 USD", budget: "300.00" },
      { currency: "CAD", moves: "C$358.00 CAD", budget: "400.00" },
      { currency: "GBP", moves: "£99.00 GBP", budget: "150.00" },
      { currency: "AUD", moves: "A$189.00 AUD", budget: "200.00" },
      { currency: "EUR", moves: "€0.00 EUR", budget: "250.00" },
    ],
  );
  assert.equal(await page.locator(".plan-table-grid .ag-row:not(.ag-row-pinned)").getByText("Simulated").count(), 0);
  await shot("03-settlement-plan.png");
  await page.getByRole("button", { name: "Approve plan and budget" }).click();
  await page.getByText("Approved", { exact: true }).waitFor();
  await open(`/plans/${planId}/window`, "Refund window");
  await page.getByText("Send #0994 first").waitFor();
  await page.getByText("Today, Nov 3").waitFor();
  await shot("04-refund-window.png");
  await page.getByRole("button", { name: "Move to front" }).click();
  await page.getByText("#0994 will run first.").waitFor();
  await open(`/plans/${planId}/run`, "Settlement run");
  await page.getByRole("button", { name: "Execute approved plan" }).click();
  await page.getByText("fake-refund-", { exact: false }).first().waitFor();
  assert.deepEqual(await page.locator(".run-table tbody tr td:first-child").allTextContents(), [
    "#0994",
    "#1042",
    "#1019",
    "#1071",
    "#1103",
    "#0871",
    "#0866",
  ]);
  assert.match(
    await page.locator(".run-table tbody tr").filter({ hasText: "#1103" }).innerText(),
    /¥12,800 JPY/,
  );
  assert.equal(await page.locator(".run-table tbody").getByText("Simulated").count(), 0);
  await shot("05-settlement-run.png");
  const runResponse = await context.request.get(`${base}/v1/plans/${planId}/run`);
  const run = (await runResponse.json()).data as { status: string }[];
  assert.equal(run.filter((row) => row.status === "SUCCEEDED").length, 7);
  await page.getByRole("button", { name: "Review invoices" }).click();
  await page.getByRole("combobox", { name: "Currency" }).selectOption("USD");
  await page.getByRole("button", { name: "Approve invoice" }).click();
  await page.getByText("USD invoice approved. Send it when ready.").waitFor();
  await page.getByRole("button", { name: "Send approved invoice" }).click();
  await page.getByText(/Invoice .* sent for USD\./).waitFor();
  await open("/review", "Is this the recalled product?");
  await page.getByText("Oct 17, 2026").waitFor();
  await page.locator(".compare-table").getByText("Lumen Mini Space Heater").waitFor();
  await shot("06-review-queue.png");
  await open(`/plans/${planId}/notices`, "Article 36 check");
  await page.getByText("Produktsicherheitsrückruf", { exact: false }).waitFor();
  await page.getByText("1 problem").waitFor({ timeout: 3000 });
  await shot("07-notice-check.png");
  await page.getByRole("button", { name: "Remove the sentence" }).click();
  await page.getByText("All checks pass").waitFor();
  await page.getByRole("button", { name: "Send to 2 buyers" }).click();
  await page.getByText("Notice sent to 2 buyers.").waitFor();
  await open("/audit", "Audit log");
  await shot("audit.png");
  await open("/sources", "Sources");
  await shot("sources.png");
  await open("/plans", "Settlement plan for");
  await shot("plans-index.png");
  await page.setViewportSize({ width: 390, height: 844 });
  const blockedCheckoutCheck = page.waitForResponse((response) =>
    response.url().endsWith("/v1/checkout/check")
  );
  await open("/store", "This product cannot be sold");
  assert.equal((await blockedCheckoutCheck).request().method(), "POST");
  await shot("11-checkout-blocked.png");
  assert.equal(await page.getByRole("button", { name: "Pay with PayPal" }).isDisabled(), true);
  const linkResponse = await context.request.post(`${base}/v1/remedy-links`, {
    data: { planId, orderId: "1051" },
  });
  assert.equal(linkResponse.status(), 201);
  const token = (await linkResponse.json()).data.token as string;
  await context.clearCookies();
  await open(`/remedy/${token}`, "Product safety recall");
  await page.getByText("Stop using this heater now.").waitFor();
  await page.getByText("Sep 24, 2026", { exact: false }).waitFor();
  await shot("08-buyer-notice.png");
  await page.getByRole("button", { name: "Choose your remedy" }).click();
  await page.getByRole("heading", { name: "Choose your remedy" }).waitFor();
  await shot("09-choose-remedy.png");
  await page.getByRole("button", { name: "Confirm refund" }).click();
  await page.getByRole("heading", { name: "Refund on its way" }).waitFor();
  await shot("10-remedy-confirmed.png");
  assert.match(await page.locator("body").innerText(), /PayPal reference\s+fake-refund-/);
  process.stdout.write(
    `E2E passed: 7 settled actions, buyer refund without merchant cookie, ${shotCount} screenshots in ${actual}\n`,
  );
} finally {
  await context?.close();
  server.kill("SIGTERM");
  await new Promise<void>((done) => {
    if (server.exitCode !== null || server.killed) setTimeout(done, 100);
    else server.once("exit", () => done());
  });
  await rm(profile, { recursive: true, force: true });
}

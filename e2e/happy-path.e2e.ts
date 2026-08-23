import { expect, type Page, test } from "@playwright/test";

// T4.3 — terminal acceptance (SDD §7.2 / mission terminal signal):
// two clients submit simultaneously -> both poll to completed -> 2D renders
// -> toggle to 3D renders; a duplicate submission resolves via the
// dedup/cache path. Requires the compose stack up (`docker compose up
// --build`) with model credentials in .env.

const SNIPPET = `
function loadConfig(path) { return readFile(path); }
function main() {
  const config = loadConfig("cfg.json");
  if (!config.enabled) { return; }
  console.log(config.name);
}
main();
`;

const SUBMIT_BUTTON = "button:has-text('Visualize')";

async function submit(page: Page, code: string): Promise<void> {
  await page.goto("/");
  await page.getByRole("textbox").fill(code);
  await page.locator(SUBMIT_BUTTON).click();
}

/** Polls until either renderer is visible or the job visibly failed. */
async function waitForRenderedGraph(page: Page): Promise<void> {
  // NOTE: test.skip() must be reached from the test body itself — inside
  // expect().toPass() it would be swallowed as a retryable error.
  const deadline = Date.now() + 180_000;
  for (;;) {
    if (await page.getByRole("alert").first().isVisible().catch(() => false)) {
      const alerts = (
        await page.getByRole("alert").allTextContents().catch(() => [])
      ).join(" ");
      if (/api key|provider|unauthorized|401|unavailable/i.test(alerts)) {
        test.skip(true, `stack has no working model credentials: ${alerts.trim()}`);
      }
    }
    if (
      await page
        .locator(".react-flow__node")
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      return;
    }
    if (Date.now() > deadline) {
      await expect(page.locator(".react-flow__node").first()).toBeVisible();
    }
    await page.waitForTimeout(2_000);
  }
}

test.describe("underhood happy path", () => {
  test("two clients submit simultaneously and render in 2D and 3D", async ({ browser }) => {
    const clientA = await browser.newContext();
    const clientB = await browser.newContext();
    const pageA = await clientA.newPage();
    const pageB = await clientB.newPage();

    // Two independent clients submit at the same time.
    await Promise.all([
      submit(pageA, SNIPPET),
      submit(pageB, `${SNIPPET}\n`),
    ]);

    // Both poll through queued/running to completed with rendered graphs.
    await Promise.all([
      waitForRenderedGraph(pageA),
      waitForRenderedGraph(pageB),
    ]);
    await expect(pageA.getByText(/Detected patterns?/i)).toBeVisible();
    // Node count comes from a live LLM and is non-deterministic; the gate is
    // "the graph renders", so assert structural sanity, not an exact count
    // (entry + terminal at minimum, with at least one connecting edge).
    const nodeCount = await pageA.locator(".react-flow__node").count();
    expect(nodeCount).toBeGreaterThanOrEqual(2);
    expect(await pageA.locator(".react-flow__edge").count()).toBeGreaterThanOrEqual(1);

    // The only user-facing mode switch: 2D -> 3D.
    await pageA.getByRole("radio", { name: "3D" }).click();
    await expect(
      pageA.locator("canvas").first()
    ).toBeVisible({ timeout: 30_000 });

    // Hover surfaces the plain-language toast (SDD §0).
    await pageA.getByRole("radio", { name: "2D" }).click();
    await expect(pageA.locator(".react-flow__node").first()).toBeVisible();
    await pageA.locator(".react-flow__node").first().hover();
    await expect(pageA.getByText(/plain|program|starts/i).first()).toBeVisible();

    await clientA.close();
    await clientB.close();
  });

  test("duplicate submission resolves via dedup/cache path", async ({ request }) => {
    const submitJob = async (): Promise<string> => {
      const response = await request.post("/analyses", {
        data: { rawCode: SNIPPET },
      });
      // Unconfigured stack (no model credentials): API stays unavailable.
      test.skip(
        response.status() === 503,
        "analysis API unavailable — stack has no model credentials"
      );
      expect(response.status()).toBe(202);
      const body = (await response.json()) as { jobId?: string };
      expect(body.jobId).toBeTruthy();
      return body.jobId!;
    };

    const firstJob = await submitJob();
    const secondJob = await submitJob();

    const waitForCompletion = async (jobId: string) => {
      await expect
        .poll(async () => {
          const status = await request.get(`/analyses/${jobId}`);
          const body = (await status.json()) as {
            status?: string;
            topology?: unknown;
            error?: string;
          };
          if (body.status === "failed") {
            test.skip(
              Boolean(body.error && /api key|provider|unauthorized|401/i.test(body.error)),
              `stack has no working model credentials: ${body.error}`
            );
          }
          return body.status;
        }, { timeout: 180_000, intervals: [1_000, 3_000] })
        .toBe("completed");
      const status = await request.get(`/analyses/${jobId}`);
      return ((await status.json()) as { topology?: unknown }).topology ?? null;
    };

    const [topologyA, topologyB] = await Promise.all([
      waitForCompletion(firstJob),
      waitForCompletion(secondJob),
    ]);
    // Identical snippet: dedup/cache must serve the same stored topology.
    expect(topologyB).toEqual(topologyA);
  });
});

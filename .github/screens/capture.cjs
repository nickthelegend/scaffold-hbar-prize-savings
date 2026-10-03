/**
 * Captures the README / demo screenshots from the running app (see .github/workflows/screens.yaml).
 *
 * Expects the app on BASE_URL, built with NEXT_PUBLIC_HEDERA_NETWORK=local, and a pool seeded by
 * `yarn foundry:seed-demo --keep-alive`. The burner wallet (offered on the local chain) is loaded with the first
 * seeded saver's throwaway key, so every shot shows a connected saver with a real position. Waits for real on-chain
 * and mirror-node data before every shot.
 *
 * Env: BASE_URL, OUT_DIR (default ./screens), STATE_FILE (the seed's deployments/demo-298.json), MIN_DRAWS.
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const OUT_DIR = path.resolve(process.env.OUT_DIR ?? "screens");
const STATE_FILE = process.env.STATE_FILE;
const MIN_DRAWS = Number(process.env.MIN_DRAWS ?? 2);
/** A hero shot needs this many seconds left on the countdown, so it never shows "Ended". */
const MIN_SECONDS_LEFT = Number(process.env.MIN_SECONDS_LEFT ?? 25);
const VIEWPORT = { width: 1920, height: 1080 };

fs.mkdirSync(OUT_DIR, { recursive: true });
const log = message => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);

const card = (page, heading) => page.locator(".card").filter({ has: page.getByRole("heading", { name: heading }) });
const savePanel = page => page.locator(".card").filter({ has: page.getByRole("tablist") });

async function shot(target, name, options = {}) {
  await target.screenshot({ path: path.join(OUT_DIR, `${name}.png`), animations: "disabled", ...options });
  log(`saved ${name}.png`);
}

/** Hero prize > 0, at least 3 savers, the draw scheduled on-chain, and a countdown with time left. */
async function waitForHero(page) {
  await page.waitForFunction(
    minSeconds => {
      const h1 = document.querySelector("h1[aria-live]");
      const prize = Number((h1?.textContent ?? "").replace(/[^0-9.]/g, ""));
      if (!(prize > 0)) return false;
      const labels = [...document.querySelectorAll("section span")];
      const valueOf = label => labels.find(s => s.textContent?.trim() === label)?.nextElementSibling?.textContent ?? "";
      if (!(Number(valueOf("Savers")) >= 3)) return false;
      if (!/HBAR/.test(valueOf("Total saved"))) return false;
      const countdown = valueOf("Round ends in").match(/^(?:(\d+):)?(\d+):(\d+)$/);
      if (!countdown) return false;
      const secondsLeft = Number(countdown[1] ?? 0) * 3600 + Number(countdown[2]) * 60 + Number(countdown[3]);
      if (secondsLeft < minSeconds) return false;
      return document.body.textContent.includes("Draw scheduled on-chain as 0.0.");
    },
    MIN_SECONDS_LEFT,
    { timeout: 10 * 60_000, polling: 1_000 },
  );
}

/** Past draws table has rows, the chart is drawn, and every winner's address has finished resolving. */
async function waitForDraws(page) {
  const draws = card(page, "Past draws");
  await draws
    .locator("tbody tr")
    .nth(MIN_DRAWS - 1)
    .waitFor({ timeout: 5 * 60_000 });
  await draws.locator('[aria-label="Prize per round"] [title^="Round"]').first().waitFor();
  await page.waitForFunction(() => !document.body.textContent.includes("Resolving Hedera Account ID"), null, {
    timeout: 60_000,
  });
}

/** Contract id, staking node and the reserve are loaded. */
async function waitForStaking(page) {
  const staking = card(page, "Where the prize comes from");
  await staking.getByRole("link", { name: /^0\.0\.\d+$/ }).waitFor({ timeout: 120_000 });
  await staking.getByText(/^Node \d+$/).waitFor({ timeout: 120_000 });
  await page.waitForFunction(
    () => ![...document.querySelectorAll(".card li span:last-child")].some(s => s.textContent?.trim() === "…"),
    null,
    { timeout: 120_000 },
  );
}

/** The connected saver's deposit and odds are loaded, and the deposit form is ready (association checked). */
async function waitForPosition(page) {
  await page.waitForFunction(
    () => {
      const values = [...document.querySelectorAll(".card dd")].map(d => d.textContent?.trim() ?? "");
      return (
        values.length === 4 && values.every(v => v && v !== "…") && /^[1-9]/.test(values[0]) && /%/.test(values[1])
      );
    },
    null,
    { timeout: 120_000 },
  );
  await savePanel(page).getByRole("button", { name: "Deposit" }).waitFor({ timeout: 60_000 });
}

/** Scrolls so `locator` starts `offset` px below the top of the viewport (the header is static on desktop). */
async function scrollTo(page, locator, offset = 24) {
  await locator.evaluate(
    (el, top) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - top),
    offset,
  );
  await page.waitForTimeout(300);
}

async function captureHome(page, suffix) {
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  log(`home${suffix}: waiting for live pool data`);
  await waitForPosition(page);
  await waitForDraws(page);
  await waitForStaking(page);
  await waitForHero(page);

  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, `home-hero${suffix}`);
  await shot(page, `home-full${suffix}`, { fullPage: true });
  await scrollTo(page, card(page, "Past draws"));
  await shot(page, `home-draws${suffix}`);
  await page.evaluate(() => window.scrollTo(0, 0));

  await waitForHero(page);
  await shot(page.locator("section.hedera-gradient"), `card-hero${suffix}`);
  await shot(savePanel(page), `card-save${suffix}`);
  await shot(card(page, "Your savings"), `card-position${suffix}`);
  await shot(card(page, "Past draws"), `card-draws${suffix}`);
  await shot(card(page, "Where the prize comes from"), `card-staking${suffix}`);
}

async function captureHowItWorks(page, suffix) {
  await page.goto(`${BASE_URL}/how-it-works`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "A round, step by step" }).waitFor();
  await shot(page, `how-it-works-top${suffix}`);
  await scrollTo(page, page.getByRole("heading", { name: "Hedera services used" }));
  await shot(page, `how-it-works-services${suffix}`);
  await scrollTo(page, page.getByRole("heading", { name: "Trust model and limits" }));
  await shot(page, `how-it-works-trust${suffix}`);
}

/** On failure, keeps what the page looked like so the run's artifact shows why. */
async function debugShot(page, name, error) {
  log(`${name} failed: ${error.message}`);
  await page.screenshot({ path: path.join(OUT_DIR, `debug-${name}.png`), fullPage: true }).catch(() => {});
}

(async () => {
  const { savers } = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  const saver = savers[0];
  log(`connecting the burner wallet as ${saver.name} (${saver.accountId}, ${saver.address})`);

  const browser = await chromium.launch();
  let failed = false;
  try {
    for (const [colorScheme, suffix] of [
      ["light", ""],
      ["dark", "-dark"],
    ]) {
      const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, colorScheme });
      // burner-connector reads its key from here; the app reconnects the burner wallet on load.
      await context.addInitScript(pk => window.localStorage.setItem("burnerWallet.pk", pk), saver.privateKey);
      const page = await context.newPage();
      page.on("pageerror", error => log(`page error: ${error.message}`));
      try {
        await captureHome(page, suffix);
        await captureHowItWorks(page, suffix);
      } catch (error) {
        failed = true;
        await debugShot(page, `pool${suffix}`, error);
        break;
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  if (failed) process.exit(1);
})().catch(error => {
  console.error(error);
  process.exit(1);
});

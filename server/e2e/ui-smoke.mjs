/**
 * Browser-level smoke test of the core workflow through the real UI:
 *   employee requests a cab → coordinator assigns → employee reveals PIN →
 *   driver acknowledges, drives, arrives, enters PIN, completes.
 *
 * Requirements: a running app with seed data (npm run seed:memdb && npm start, or
 * the dev server), and a local Chrome/Edge.
 *   BASE_URL     default http://localhost:4000
 *   CHROME_PATH  default: Chrome / Edge standard install locations
 *   SCREENSHOTS  directory for screenshots (default ./e2e-screens)
 *
 * Note: each run makes 2 PIN attempts as the selected driver. Running it more than
 * ~7 times within 10 minutes trips the per-driver PIN rate limit (HTTP 429) by design.
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE_URL ?? 'http://localhost:4000';
const SHOTS = path.resolve(process.env.SCREENSHOTS ?? 'e2e-screens');
const PASSWORD = 'Password123!';
const candidates = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const executablePath = candidates.find((p) => fs.existsSync(p));
if (!executablePath) throw new Error('No Chrome/Edge found; set CHROME_PATH');
fs.mkdirSync(SHOTS, { recursive: true });

const problems = [];
let step = 0;

async function shot(page, name) {
  step++;
  await page.screenshot({ path: path.join(SHOTS, `${String(step).padStart(2, '0')}-${name}.png`), fullPage: true });
}

function watch(page, who) {
  page.on('pageerror', (e) => problems.push(`[${who}] page error: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && problems.push(`[${who}] console: ${m.text()}`));
  page.on('response', (r) => r.status() >= 500 && problems.push(`[${who}] HTTP ${r.status()} ${r.url()}`));
}

/** Set a React-controlled input by its visible <label> text. */
async function fill(page, label, value) {
  await page.waitForFunction((l) => [...document.querySelectorAll('label')].some((x) => x.textContent.trim().replace(/\*$/, '').trim() === l), {}, label);
  await page.evaluate(
    (l, v) => {
      const lab = [...document.querySelectorAll('label')].find((x) => x.textContent.trim().replace(/\*$/, '').trim() === l);
      const el = document.getElementById(lab.htmlFor);
      const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    },
    label,
    value,
  );
}

/** Click the first visible, enabled button/link whose text matches. */
async function click(page, text, { within = 'body', timeout = 15000 } = {}) {
  const handle = await page.waitForFunction(
    (t, w) => {
      const root = document.querySelector(w) ?? document.body;
      return [...root.querySelectorAll('button, a, [role="radio"]')].find(
        (b) => b.textContent.replace(/\s+/g, ' ').trim().includes(t) && !b.disabled && b.getAttribute('aria-disabled') !== 'true' && b.offsetParent !== null,
      );
    },
    { timeout },
    text,
    within,
  );
  await handle.asElement().click();
}

async function waitText(page, text, timeout = 15000) {
  await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text);
}

async function login(browser, email, who, viewport) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport(viewport ?? { width: 1366, height: 900 });
  watch(page, who);
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle0' });
  await fill(page, 'Work email', email);
  await fill(page, 'Password', PASSWORD);
  await click(page, 'Sign in');
  await page.waitForFunction(() => !location.pathname.startsWith('/login'), { timeout: 15000 });
  return page;
}

/** Coordinators sign in with their email and the mobile number an admin registered. */
async function coordinatorLogin(browser, email, phone) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1366, height: 900 });
  watch(page, 'coordinator');
  await page.goto(`${BASE}/coordinator-login`, { waitUntil: 'networkidle0' });
  await fill(page, 'Email', email);
  await fill(page, 'Mobile number', phone);
  await click(page, 'Sign in');
  await page.waitForFunction(() => !location.pathname.startsWith('/coordinator-login'), { timeout: 15000 });
  return page;
}

/** Drivers sign in with their mobile number and the last 4 characters of their vehicle number. */
async function driverLogin(browser, phone, vehicleLast4, viewport) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport(viewport ?? { width: 390, height: 844 });
  watch(page, 'driver');
  await page.goto(`${BASE}/driver-login`, { waitUntil: 'networkidle0' });
  await fill(page, 'Mobile number', phone);
  await fill(page, 'Last 4 characters of your vehicle number', vehicleLast4);
  await click(page, 'Sign in');
  await page.waitForFunction(() => !location.pathname.startsWith('/driver-login'), { timeout: 15000 });
  return page;
}

const browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
try {
  // 1. Employee requests a cab
  const emp = await login(browser, 'employee@example.com', 'employee', { width: 390, height: 844 });
  await waitText(emp, 'Request a cab');
  await shot(emp, 'employee-home-mobile');
  await emp.goto(`${BASE}/employee/request`, { waitUntil: 'networkidle0' });
  // random slot so repeated runs against the same database don't collide
  const d = new Date(Date.now() + (2 + Math.floor(Math.random() * 10)) * 86400_000);
  const travelDate = d.toISOString().slice(0, 10);
  const hour = String(6 + Math.floor(Math.random() * 14)).padStart(2, '0');
  const minute = String(Math.floor(Math.random() * 50) + 10);
  await fill(emp, 'Travel date', travelDate);
  await fill(emp, 'Pickup time', `${hour}:${minute}`);
  await fill(emp, 'Pickup location', 'Kondapur Main Road, Gate 2');
  await fill(emp, 'Drop-off location', 'HITEC City Campus, Tower B');
  await shot(emp, 'employee-request-form');
  await click(emp, 'Submit request');
  await emp.waitForFunction(() => /\/employee\/bookings\/[a-f0-9]{24}$/.test(location.pathname), { timeout: 15000 });
  const bookingId = emp.url().split('/').pop();
  await waitText(emp, 'CB-');
  const reference = await emp.evaluate(() => (document.body.innerText.match(/CB-\d{6}-\d{4}/) ?? [''])[0]);
  await shot(emp, 'employee-booking-requested');
  console.log('✓ employee created booking', reference, bookingId);

  // 2. Coordinator assigns driver + vehicle
  const coord = await coordinatorLogin(browser, 'coordinator@example.com', '9000000001');
  await shot(coord, 'coordinator-dashboard');
  await coord.goto(`${BASE}/ops/bookings?date=${travelDate}`, { waitUntil: 'networkidle0' });
  await waitText(coord, 'Asha Rao');
  await shot(coord, 'coordinator-requests');
  await coord.goto(`${BASE}/ops/bookings/${bookingId}`, { waitUntil: 'networkidle0' });
  await click(coord, 'Assign cab');
  await coord.waitForSelector('[role="radiogroup"][aria-label="Driver"] [role="radio"]');
  // first eligible driver (selecting a driver auto-selects their linked vehicle)
  const driverChoice = await coord.waitForFunction(() => [...document.querySelectorAll('[role="radiogroup"][aria-label="Driver"] [role="radio"]')].find((r) => !r.disabled && r.getAttribute('aria-disabled') !== 'true'), { timeout: 15000 });
  const driverName = await driverChoice.evaluate((el) => el.textContent);
  await driverChoice.asElement().click();
  const vehicleSelected = await coord.evaluate(() => !!document.querySelector('[role="radiogroup"][aria-label="Vehicle"] [role="radio"][aria-checked="true"]'));
  if (!vehicleSelected) {
    const v = await coord.waitForFunction(() => [...document.querySelectorAll('[role="radiogroup"][aria-label="Vehicle"] [role="radio"]')].find((r) => !r.disabled && r.getAttribute('aria-disabled') !== 'true'));
    await v.asElement().click();
  }
  await shot(coord, 'coordinator-assign-select');
  await click(coord, 'Review assignment');
  await click(coord, 'Confirm assignment');
  await coord.waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 15000 });
  await coord.reload({ waitUntil: 'networkidle0' });
  await waitText(coord, 'Assigned');
  const vehicleReg = await coord.evaluate(() => (document.body.innerText.match(/TS09[A-Z]{2}\d{4}/) ?? [''])[0]);
  await shot(coord, 'coordinator-booking-assigned');
  console.log('✓ coordinator assigned cab');

  // 3. Employee sees assignment and reveals PIN
  await emp.reload({ waitUntil: 'networkidle0' });
  await waitText(emp, vehicleReg || 'Assigned');
  await click(emp, 'Show');
  const pin = await emp.$eval('[aria-label^="PIN "]', (el) => el.getAttribute('aria-label').replace(/\D/g, ''));
  if (!/^\d{4}$/.test(pin)) throw new Error(`Unexpected PIN format: ${pin}`);
  await shot(emp, 'employee-pin-visible');
  console.log('✓ employee can see 4-digit PIN');

  // 4. Driver runs the trip on a phone-sized screen
  // seed data: DRV001 9000020001 / TS09AB1234, DRV002 9000020002 / TS09CD5678
  const drv = /Suresh/.test(driverName) ? await driverLogin(browser, '9000020002', '5678') : await driverLogin(browser, '9000020001', '1234');
  await drv.goto(`${BASE}/driver`, { waitUntil: 'networkidle0' });
  const bodyText = await drv.evaluate(() => document.body.innerText);
  if (bodyText.includes(pin)) problems.push('PIN visible on driver home!');
  await shot(drv, 'driver-home');
  // the ride card for THIS run's booking (seeded drivers accumulate rides across runs)
  const rideHref = await drv.waitForFunction(
    (ref) => {
      const a = [...document.querySelectorAll('a[href^="/driver/rides/"]')].find((x) => x.innerText.includes(ref));
      return a ? a.getAttribute('href') : null;
    },
    { timeout: 15000 },
    reference,
  );
  await drv.goto(`${BASE}${await rideHref.jsonValue()}`, { waitUntil: 'networkidle0' });
  // each step reveals the next single primary action
  const steps = [['Start driving to pickup', 'I have arrived at pickup'], ['I have arrived at pickup', 'Verify the passenger']];
  for (const [action, next] of steps) {
    try {
      await click(drv, action);
      await waitText(drv, next);
    } catch (e) {
      await shot(drv, `FAILED-${action.replace(/\W+/g, '-')}`);
      throw e;
    }
  }
  await drv.waitForSelector('input[inputmode="numeric"]');
  await shot(drv, 'driver-pin-entry');
  // a wrong PIN first
  const wrong = pin === '000000' ? '111111' : '000000';
  await drv.type('input[inputmode="numeric"]', wrong);
  await click(drv, 'Verify PIN & start trip');
  await waitText(drv, 'Incorrect PIN');
  await shot(drv, 'driver-wrong-pin');
  // the page clears the field after a failed attempt; wait for that before typing
  await drv.waitForFunction(() => document.querySelector('input[inputmode="numeric"]')?.value === '', { timeout: 10000 });
  await drv.type('input[inputmode="numeric"]', pin);
  await click(drv, 'Verify PIN & start trip');
  await waitText(drv, 'Complete trip');
  await shot(drv, 'driver-in-progress');
  await click(drv, 'Complete trip');
  await drv.waitForSelector('[role="dialog"]');
  await click(drv, 'Complete trip', { within: '[role="dialog"]' });
  await drv.waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 15000 });
  await waitText(drv, 'ompleted');
  await shot(drv, 'driver-completed');
  console.log('✓ driver completed trip using PIN');

  // 5. Employee sees completion
  await emp.reload({ waitUntil: 'networkidle0' });
  await waitText(emp, 'ompleted');
  await shot(emp, 'employee-completed');
  console.log('✓ employee sees completed trip');

  // 6. Admin pages render
  const admin = await login(browser, 'admin@example.com', 'admin');
  for (const p of ['/admin', '/admin/employees', '/admin/coordinators', '/admin/policy', '/admin/reports', '/admin/audit', '/admin/notifications', '/ops/drivers', '/ops/vehicles', '/ops/links']) {
    await admin.goto(`${BASE}${p}`, { waitUntil: 'networkidle0' });
    await admin.waitForSelector('h1', { timeout: 15000 });
    await shot(admin, `admin${p.replace(/\//g, '-')}`);
  }
  console.log('✓ admin and operations pages render');
} catch (err) {
  // capture every open page to make failures diagnosable
  for (const [i, pg] of (await Promise.all((browser.browserContexts()).map((c) => c.pages()))).flat().entries()) {
    await pg.screenshot({ path: path.join(SHOTS, `FAILED-page${i}.png`), fullPage: true }).catch(() => {});
  }
  throw err;
} finally {
  await browser.close();
}

if (problems.length) {
  console.error('\nProblems detected:\n - ' + problems.join('\n - '));
  process.exit(1);
}
console.log(`\nUI smoke test passed. Screenshots: ${SHOTS}`);

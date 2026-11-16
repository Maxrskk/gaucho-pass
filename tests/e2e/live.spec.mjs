// The real app against the REAL Supabase project (no stand-in).
//   LIVE=1 npx playwright test live --project=chromium
// Needs .env.demo.local. It resets the demo data, so don't run it mid-presentation.

import { expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { EMAIL, coverCamera, expectResult, nextScan, photoOf, pointCameraAt, test, watchErrors, withFakeCamera } from './helpers.mjs';

const LIVE = process.env.LIVE === '1';
const envPath = new URL('../../.env.demo.local', import.meta.url);
const env = LIVE && existsSync(envPath)
  ? Object.fromEntries(readFileSync(envPath, 'utf8').split('\n').map((l) => /^([A-Z_]+)=(.*)$/.exec(l.trim())).filter(Boolean).map((m) => [m[1], m[2]]))
  : {};
const PASSWORD = { student: env.DEMO_STUDENT_PASSWORD, scanner: env.DEMO_SCANNER_PASSWORD, admin: env.DEMO_ADMIN_PASSWORD };
const roleOf = (name) => (name === 'admin' ? 'admin' : name.startsWith('scanner') ? 'scanner' : 'student');

async function open(browser, { camera = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  if (camera) await withFakeCamera(context);
  const page = await context.newPage();
  return { context, page, errors: watchErrors(page) };
}

async function signIn(page, name) {
  await page.goto('/');
  await expect(page.locator('#view-login')).toBeVisible();
  await page.selectOption('#login-pick', EMAIL(name));
  await page.fill('#login-password', PASSWORD[roleOf(name)]);
  await page.click('#login-submit');
}

async function startScanning(page, name, location) {
  await signIn(page, name);
  await expect(page.locator('#view-scan')).toBeVisible({ timeout: 20000 });
  await page.click(`#loc-chips [data-loc="${location}"]`);
  await page.click('#cam-btn');
  await expect(page.locator('#cam-btn')).toHaveText('Stop camera');
}

test.describe('live backend', () => {
  test.describe.configure({ mode: 'serial' });
  test.skip(({ browserName }) => !LIVE || browserName !== 'chromium', 'set LIVE=1 to run against the real project');
  test.setTimeout(180_000);

  test('wrong password, then admin resets the demo data', async ({ browser }) => {
    const admin = await open(browser);
    await admin.page.goto('/');
    await admin.page.selectOption('#login-pick', EMAIL('admin'));
    await admin.page.fill('#login-password', 'definitely-not-the-password');
    await admin.page.click('#login-submit');
    await expect(admin.page.locator('#login-msg')).toHaveText('Wrong email or password.', { timeout: 20000 });

    await signIn(admin.page, 'admin');
    await expect(admin.page.locator('#view-live')).toBeVisible({ timeout: 20000 });
    await admin.page.click('#tabs [data-route="demo"]');
    await admin.page.click('#demo-reset');
    await admin.page.click('#confirm-yes');
    await expect(admin.page.locator('#toast')).toContainText('Demo data reset', { timeout: 30000 });
    await admin.page.click('#preflight-run');
    await expect(admin.page.locator('#preflight li', { hasText: /^Server:/ })).toContainText('answered in', { timeout: 30000 });
    await expect(admin.page.locator('#preflight li', { hasText: /^Scan check:/ })).toContainText('ready', { timeout: 30000 });
    await expect(admin.page.locator('#preflight li', { hasText: /^Demo data:/ })).toContainText('at the starting state', { timeout: 30000 });
    await admin.context.close();
    expect(admin.errors).toEqual([]);
  });

  test('scan a real code, reuse it on a second scanner, see it on the dashboard', async ({ browser }) => {
    const phone = await open(browser);
    const reader1 = await open(browser, { camera: true });
    const reader2 = await open(browser, { camera: true });
    await signIn(phone.page, 'jordan');
    await expect(phone.page.locator('#s-name')).toHaveText('Jordan Reyes', { timeout: 20000 });
    await expect(phone.page.locator('#qr svg')).toBeVisible({ timeout: 20000 });
    await expect(phone.page.locator('#id-clock')).toBeHidden();

    await startScanning(reader1.page, 'scanner1', 'rec');
    const picture = await photoOf(phone.page);
    await pointCameraAt(reader1.page, picture);
    await expectResult(reader1.page, 'Access granted');
    await expect(reader1.page.locator('#r-name')).toHaveText('Jordan Reyes');
    await expect(reader1.page.locator('#r-avatar img')).toHaveAttribute('src', 'avatars/jordan.svg');
    console.log('LIVE result line:', await reader1.page.locator('#r-meta').textContent());

    await startScanning(reader2.page, 'scanner2', 'lib');
    await pointCameraAt(reader2.page, picture);
    await expectResult(reader2.page, 'Code already used');
    await expect(reader2.page.locator('#r-reason')).toContainText('Rec Cen');

    await nextScan(reader1.page);
    await coverCamera(reader1.page);
    await reader1.page.click('[data-test="forged"]');
    await expectResult(reader1.page, 'Invalid code');
    await expect(reader1.page.locator('#r-who')).toBeHidden();
    await nextScan(reader1.page);
    await reader1.page.click('#tabs [data-route="log"]');
    await expect(reader1.page.locator('#log li')).toHaveCount(2, { timeout: 20000 });

    const admin = await open(browser);
    await signIn(admin.page, 'admin');
    await expect(admin.page.locator('#feed li')).toHaveCount(3, { timeout: 30000 });
    await expect(admin.page.locator('#t-granted')).toHaveText('1');
    await expect(admin.page.locator('#t-denied')).toHaveText('2');
    await admin.page.click('#tabs [data-route="stats"]');
    await expect(admin.page.locator('#sp-verify')).toHaveText(/\d/, { timeout: 20000 });
    console.log('LIVE speed tiles:', await admin.page.locator('#sp-shown').textContent(), '/', await admin.page.locator('#sp-verify').textContent());
    for (const d of [phone, reader1, reader2, admin]) await d.context.close();
    expect([...phone.errors, ...reader1.errors, ...reader2.errors, ...admin.errors]).toEqual([]);
  });

  test('lost phone on the real backend: old phone signs out, old code is dead, new code works', async ({ browser }) => {
    const lostPhone = await open(browser);
    const laptop = await open(browser);
    const reader = await open(browser, { camera: true });
    await signIn(lostPhone.page, 'dev');
    await expect(lostPhone.page.locator('#qr svg')).toBeVisible({ timeout: 20000 });
    const oldCode = await photoOf(lostPhone.page);

    await signIn(laptop.page, 'dev');
    await expect(laptop.page.locator('#qr svg')).toBeVisible({ timeout: 20000 });
    await laptop.page.click('#report-lost');
    await laptop.page.click('#confirm-yes');
    await expect(laptop.page.locator('#s-status')).toHaveText('Reported lost', { timeout: 20000 });

    await startScanning(reader.page, 'scanner1', 'lib');
    await pointCameraAt(reader.page, oldCode);
    await expectResult(reader.page, 'Card deactivated');
    await nextScan(reader.page);
    await coverCamera(reader.page);

    await expect(lostPhone.page.locator('#view-login')).toBeVisible({ timeout: 30000 });
    await expect(lostPhone.page.locator('#login-msg')).toBeVisible();

    await laptop.page.click('#reactivate');
    await expect(laptop.page.locator('#s-status')).toHaveText('Active', { timeout: 20000 });
    await expect(laptop.page.locator('#qr svg')).toBeVisible({ timeout: 20000 });
    await pointCameraAt(reader.page, await photoOf(laptop.page));
    await expectResult(reader.page, 'Access granted');
    await nextScan(reader.page);
    await pointCameraAt(reader.page, oldCode);
    await expect(reader.page.locator('#rescan-row')).toBeVisible();
    await reader.page.click('#rescan');
    await expectResult(reader.page, 'Deactivated phone');
    for (const d of [lostPhone, laptop, reader]) await d.context.close();
    expect([...laptop.errors, ...reader.errors]).toEqual([]);
  });

  test('guest pass and meal swipe on the real backend, then reset', async ({ browser }) => {
    const phone = await open(browser);
    const reader = await open(browser, { camera: true });
    await signIn(phone.page, 'maya');
    await expect(phone.page.locator('#s-access li').first()).toContainText('1 of 10 swipes left this week', { timeout: 20000 });
    await startScanning(reader.page, 'scanner1', 'carrillo');
    await pointCameraAt(reader.page, await photoOf(phone.page));
    await expectResult(reader.page, 'Access granted');
    await expect(reader.page.locator('#r-extra')).toHaveText('0 meal swipes left this week');
    await nextScan(reader.page);
    await coverCamera(reader.page);
    await expect(phone.page.locator('#s-access li').first()).toContainText('0 of 10 swipes left this week', { timeout: 30000 });

    await phone.page.click('#tabs [data-route="guests"]');
    await phone.page.click('#guest-new');
    await phone.page.fill('#guest-name', 'Alex Rivera');
    await phone.page.selectOption('#guest-where', 'rec');
    await phone.page.click('#guest-create');
    await expect(phone.page.locator('#guest-list .gpass .qr svg')).toBeVisible({ timeout: 20000 });
    await reader.page.click('#loc-chips [data-loc="rec"]');
    await pointCameraAt(reader.page, await photoOf(phone.page, '#guest-list .gpass .qr'));
    await expectResult(reader.page, 'Access granted');
    await expect(reader.page.locator('#r-reason')).toHaveText('Guest of Maya Castellanos.');
    await nextScan(reader.page);
    await reader.page.click('#rescan');
    await expectResult(reader.page, 'Guest pass already used');

    const admin = await open(browser);
    await signIn(admin.page, 'admin');
    await expect(admin.page.locator('#view-live')).toBeVisible({ timeout: 20000 });
    await admin.page.click('#tabs [data-route="demo"]');
    await admin.page.click('#demo-reset');
    await admin.page.click('#confirm-yes');
    await expect(admin.page.locator('#toast')).toContainText('Demo data reset', { timeout: 30000 });
    for (const d of [phone, reader, admin]) await d.context.close();
    expect([...phone.errors, ...reader.errors, ...admin.errors]).toEqual([]);
  });
});

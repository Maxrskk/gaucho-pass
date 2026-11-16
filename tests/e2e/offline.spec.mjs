// Offline ID, wrong clocks, and the saved key.

import { expect } from '@playwright/test';
import { device, expectResult, newBackend, photoOf, pointCameraAt, signIn, startScanning, test } from './helpers.mjs';

test('the student ID opens and keeps making codes with no connection', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'service workers are only testable in Chromium here');
  const backend = await newBackend();
  const net = { down: false };
  const phone = await device(browser, backend, { serviceWorkers: 'allow', net });
  await signIn(phone.page, 'jordan');
  await expect(phone.page.locator('#qr svg')).toBeVisible();
  await phone.page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => phone.page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  const onlineCode = await phone.page.locator('#code-peek').textContent();

  // Airplane mode, then open the app again.
  net.down = true;
  await phone.context.setOffline(true);
  await phone.page.reload();
  await expect(phone.page.locator('#s-name')).toHaveText('Jordan Reyes');
  await expect(phone.page.locator('#qr svg')).toBeVisible();
  await expect(phone.page.locator('#id-flags')).toContainText('Offline');
  await expect(phone.page.locator('#code-peek')).toHaveText(/^\d{3} \d{3}$/);
  await expect(phone.page.locator('#s-avatar img')).toBeVisible();

  // The offline code is a real one: a scanner that is online accepts it.
  const reader = await device(browser, backend, { camera: true });
  await startScanning(reader.page, 'scanner1', 'lib');
  await pointCameraAt(reader.page, await photoOf(phone.page));
  await expectResult(reader.page, 'Access granted');
  expect(typeof onlineCode).toBe('string');

  // Back online, it catches up without a reload.
  net.down = false;
  await phone.context.setOffline(false);
  await expect(phone.page.locator('#id-flags')).not.toContainText('Offline', { timeout: 15000 });
});

test('the secret is not readable from the page, storage, or the saved key', async ({ browser }) => {
  const backend = await newBackend();
  const phone = await device(browser, backend);
  await signIn(phone.page, 'jordan');
  await expect(phone.page.locator('#qr svg')).toBeVisible();
  const jordan = [...backend.state.students.values()].find((s) => s.perm === '9900142');
  const secret = backend.state.secrets.get(jordan.user_id).secret;

  const found = await phone.page.evaluate(async (needle) => {
    const places = [document.documentElement.outerHTML, JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage })];
    const db = await new Promise((resolve) => { const r = indexedDB.open('gaucho-pass', 1); r.onsuccess = () => resolve(r.result); });
    const rows = await new Promise((resolve) => { const q = db.transaction('keys').objectStore('keys').getAll(); q.onsuccess = () => resolve(q.result); });
    let exportable = false;
    for (const row of rows) {
      try { await crypto.subtle.exportKey('raw', row.key); exportable = true; } catch { /* expected: not extractable */ }
    }
    return { leaked: places.some((p) => p.includes(needle)), keys: rows.length, exportable, extractable: rows.map((r) => r.key.extractable) };
  }, secret);
  expect(found).toEqual({ leaked: false, keys: 1, exportable: false, extractable: [false] });
});

test('a phone with the wrong clock is warned, and its codes still work', async ({ browser }) => {
  // The server is five minutes ahead of this "phone".
  const backend = await newBackend({ skewMs: 5 * 60 * 1000 });
  const phone = await device(browser, backend);
  await signIn(phone.page, 'jordan');
  await expect(phone.page.locator('#id-clock')).toBeVisible();
  await expect(phone.page.locator('#id-clock')).toContainText('5 minutes behind');
  await expect(phone.page.locator('#qr svg')).toBeVisible();

  const reader = await device(browser, backend, { camera: true });
  await startScanning(reader.page, 'scanner1', 'lib');
  await phone.page.waitForTimeout(600); // let the card redraw with the corrected time
  await pointCameraAt(reader.page, await photoOf(phone.page));
  await expectResult(reader.page, 'Access granted');
});

test('a phone whose clock is right shows no warning', async ({ browser }) => {
  const backend = await newBackend();
  const phone = await device(browser, backend);
  await signIn(phone.page, 'jordan');
  await expect(phone.page.locator('#qr svg')).toBeVisible();
  await expect(phone.page.locator('#id-clock')).toBeHidden();
});

test('offline with an expired sign-in token: the ID still opens straight away', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'service workers are only testable in Chromium here');
  // Tokens that last 5 seconds are already "due for refresh", like a phone opened hours later.
  const backend = await newBackend({ accessTtlSec: 5 });
  const net = { down: false };
  const phone = await device(browser, backend, { serviceWorkers: 'allow', net });
  await signIn(phone.page, 'sam');
  await expect(phone.page.locator('#qr svg')).toBeVisible();
  await phone.page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => phone.page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await phone.page.waitForTimeout(6000); // the token is now fully expired

  net.down = true;
  await phone.context.setOffline(true);
  const started = Date.now();
  await phone.page.reload();
  await expect(phone.page.locator('#s-name')).toHaveText('Sam Okafor', { timeout: 5000 });
  await expect(phone.page.locator('#qr svg')).toBeVisible({ timeout: 5000 });
  expect(Date.now() - started).toBeLessThan(6000);
  await expect(phone.page.locator('#id-flags')).toContainText('Offline');

  // Reconnecting refreshes the sign-in quietly; the student is not thrown out.
  net.down = false;
  await phone.context.setOffline(false);
  await expect(phone.page.locator('#id-flags')).not.toContainText('Offline', { timeout: 45000 });
  await expect(phone.page.locator('#view-id')).toBeVisible();
});

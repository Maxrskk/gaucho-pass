// Admin dashboard, meal swipes, guest passes, speed stats and the demo page.

import { expect } from '@playwright/test';
import { coverCamera, device, expectResult, newBackend, nextScan, photoOf, pointCameraAt, signIn, startScanning, test } from './helpers.mjs';

test('admin dashboard: live scans from every scanner, deactivate a student, reset', async ({ browser }) => {
  const backend = await newBackend();
  const admin = await device(browser, backend);
  const reader = await device(browser, backend);
  const phone = await device(browser, backend);

  await signIn(admin.page, 'admin');
  await expect(admin.page.locator('#view-live')).toBeVisible();
  await expect(admin.page.locator('#feed-empty')).toBeVisible();
  await expect(admin.page.locator('#t-granted')).toHaveText('0');

  // Scans made on another device show up by themselves.
  await signIn(reader.page, 'scanner1');
  await reader.page.click('#loc-chips [data-loc="lib"]');
  await reader.page.click('[data-test="live"]');
  await expectResult(reader.page, 'Access granted');
  await nextScan(reader.page);
  await reader.page.click('[data-test="forged"]');
  await expectResult(reader.page, 'Invalid code');

  await expect(admin.page.locator('#feed li')).toHaveCount(2, { timeout: 10000 });
  await expect(admin.page.locator('#t-granted')).toHaveText('1');
  await expect(admin.page.locator('#t-denied')).toHaveText('1');
  await expect(admin.page.locator('#feed li').first()).toContainText('Invalid code');
  await expect(admin.page.locator('#feed li').first()).toContainText('not verified');
  await expect(admin.page.locator('#feed li').first()).toContainText('Dining Commons Staff');
  await admin.page.click('#f-denied');
  await expect(admin.page.locator('#feed li')).toHaveCount(1);
  await admin.page.click('#f-all');

  // Stats
  await admin.page.click('#tabs [data-route="stats"]');
  await expect(admin.page.locator('#loc-bars .loc-row')).toHaveCount(5);
  await expect(admin.page.locator('#loc-bars')).toContainText('1 granted · 1 denied');
  await expect(admin.page.locator('#reason-list')).toContainText('Invalid code');

  // Deactivate a student: their phone signs out, and the card shows as deactivated when they come back.
  await signIn(phone.page, 'sam');
  await expect(phone.page.locator('#qr svg')).toBeVisible();
  await admin.page.click('#tabs [data-route="people"]');
  const sam = admin.page.locator('#people li', { hasText: 'Sam Okafor' });
  await sam.locator('button').click();
  await expect(admin.page.locator('#confirm-title')).toHaveText("Deactivate Sam Okafor's ID?");
  await admin.page.click('#confirm-yes');
  await expect(sam.locator('.tag')).toHaveText('Deactivated');
  await expect(sam.locator('button')).toHaveText('Reactivate');
  await expect(phone.page.locator('#view-login')).toBeVisible({ timeout: 15000 });
  await signIn(phone.page, 'sam');
  await expect(phone.page.locator('#s-status')).toHaveText('Deactivated');
  await expect(phone.page.locator('#dead-title')).toHaveText('ID deactivated');
  await expect(phone.page.locator('#reactivate')).toBeHidden();

  // Reset puts everything back.
  await admin.page.click('#tabs [data-route="demo"]');
  await admin.page.click('#demo-reset');
  await admin.page.click('#confirm-yes');
  await expect(admin.page.locator('#toast')).toContainText('Demo data reset');
  await admin.page.click('#tabs [data-route="live"]');
  await expect(admin.page.locator('#feed li')).toHaveCount(0);
  await expect(admin.page.locator('#t-denied')).toHaveText('0');
  await expect(phone.page.locator('#s-status')).toHaveText('Active', { timeout: 15000 });
  expect([...admin.errors, ...reader.errors]).toEqual([]);
});

test('admin can switch the demo tools off for scanners', async ({ browser }) => {
  const backend = await newBackend();
  const admin = await device(browser, backend);
  await signIn(admin.page, 'admin');
  await admin.page.click('#tabs [data-route="demo"]');
  await expect(admin.page.locator('#demo-tools-on')).toBeChecked();
  await admin.page.uncheck('#demo-tools-on');
  await expect(admin.page.locator('#toast')).toContainText('Demo tools are off');
  const reader = await device(browser, backend);
  await signIn(reader.page, 'scanner1');
  await expect(reader.page.locator('#view-scan')).toBeVisible();
  await expect(reader.page.locator('#demo-tools')).toBeHidden();
});

test('meal swipes count down on the student\'s card after a dining scan', async ({ browser }) => {
  const backend = await newBackend();
  const phone = await device(browser, backend);
  const reader = await device(browser, backend, { camera: true });
  await signIn(phone.page, 'maya');
  await expect(phone.page.locator('#s-access li').first()).toContainText('1 of 10 swipes left this week');

  await startScanning(reader.page, 'scanner1', 'carrillo');
  await pointCameraAt(reader.page, await photoOf(phone.page));
  await expectResult(reader.page, 'Access granted');
  await expect(reader.page.locator('#r-extra')).toHaveText('0 meal swipes left this week');

  await expect(phone.page.locator('#s-access li').first()).toContainText('0 of 10 swipes left this week', { timeout: 15000 });
  await expect(phone.page.locator('#s-access li').first().locator('.tag')).toHaveText('No swipes');
  expect([...phone.errors, ...reader.errors]).toEqual([]);
});

test('guest pass: create, scan once, refused the second time', async ({ browser }) => {
  const backend = await newBackend();
  const phone = await device(browser, backend);
  const reader = await device(browser, backend, { camera: true });
  await signIn(phone.page, 'jordan');
  await phone.page.click('#tabs [data-route="guests"]');
  await expect(phone.page.locator('#guest-empty')).toBeVisible();

  await phone.page.click('#guest-new');
  await phone.page.click('#guest-create');
  await expect(phone.page.locator('#guest-error')).toHaveText("Enter your guest's name.");
  await phone.page.fill('#guest-name', '<b>Alex</b>');
  await phone.page.click('#guest-create');
  await expect(phone.page.locator('#guest-error')).toContainText('letters, numbers');
  await phone.page.fill('#guest-name', 'Alex Rivera');
  await phone.page.selectOption('#guest-where', 'rec');
  await phone.page.click('#guest-create');
  await expect(phone.page.locator('#guest-sheet')).toBeHidden();
  const pass = phone.page.locator('#guest-list .gpass').first();
  await expect(pass).toContainText('Alex Rivera');
  await expect(pass.locator('.tag')).toHaveText('Active');
  await expect(pass.locator('.qr svg')).toBeVisible();

  await startScanning(reader.page, 'scanner1', 'lib');
  const picture = await photoOf(phone.page, '#guest-list .gpass .qr');
  await pointCameraAt(reader.page, picture);
  await expectResult(reader.page, 'Wrong place for this pass');
  await nextScan(reader.page);
  await coverCamera(reader.page);

  await reader.page.click('#loc-chips [data-loc="rec"]');
  await pointCameraAt(reader.page, picture);
  await expectResult(reader.page, 'Access granted');
  await expect(reader.page.locator('#r-name')).toHaveText('Alex Rivera');
  await expect(reader.page.locator('#r-perm')).toHaveText('Guest pass');
  await expect(reader.page.locator('#r-detail')).toHaveText('Host: Jordan Reyes');
  await expect(reader.page.locator('#r-reason')).toHaveText('Guest of Jordan Reyes.');
  await nextScan(reader.page);
  await reader.page.click('#rescan');
  await expectResult(reader.page, 'Guest pass already used');

  await expect(phone.page.locator('#guest-list .gpass').first().locator('.tag')).toHaveText('Used', { timeout: 15000 });
  await expect(phone.page.locator('#guest-list .qr')).toHaveCount(0);
  expect([...phone.errors, ...reader.errors]).toEqual([]);
});

test('guest pass link: opens without sign-in, shows the code, and can be cancelled by the host', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'reading the clipboard needs Chromium permissions');
  const backend = await newBackend();
  const phone = await device(browser, backend, { permissions: ['clipboard-read', 'clipboard-write'] });
  await signIn(phone.page, 'jordan');
  await phone.page.click('#tabs [data-route="guests"]');
  await phone.page.click('#guest-new');
  await phone.page.fill('#guest-name', "Zoë O'Neil");
  await phone.page.selectOption('#guest-where', 'library');
  await phone.page.click('#guest-create');
  await expect(phone.page.locator('#guest-list .gpass .qr svg')).toBeVisible();
  await phone.page.click('[data-share]');
  await expect(phone.page.locator('#toast')).toContainText('Link copied');
  const link = await phone.page.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(/#guest=[A-Za-z0-9_-]+$/);

  const friend = await device(browser, backend);
  await friend.page.goto(link);
  await expect(friend.page.locator('#view-guest')).toBeVisible();
  await expect(friend.page.locator('#g-name')).toHaveText("Zoë O'Neil");
  await expect(friend.page.locator('#g-sub')).toHaveText('Guest of Jordan · Library');
  await expect(friend.page.locator('#g-qr svg')).toBeVisible();
  await expect(friend.page.locator('#g-hint')).toContainText('Expires in');
  expect(backend.state.requests.filter((r) => r.includes('/rest/') || r.includes('/functions/')).length).toBeGreaterThan(0);

  const reader = await device(browser, backend, { camera: true });
  await startScanning(reader.page, 'scanner1', 'lib');
  // The host cancels before the friend arrives.
  await phone.page.click('[data-revoke]');
  await phone.page.click('#confirm-yes');
  await expect(phone.page.locator('#guest-list .gpass .tag')).toHaveText('Cancelled');
  await pointCameraAt(reader.page, await photoOf(friend.page, '#g-qr'));
  await expectResult(reader.page, 'Guest pass cancelled');

  // A broken or tampered link shows the sign-in screen, not an error.
  await friend.page.goto('/#guest=bm90LWEtcGFzcy1ub3QtYS1wYXNz');
  await friend.page.reload();
  await expect(friend.page.locator('#view-login')).toBeVisible();
  expect([...friend.errors, ...phone.errors]).toEqual([]);
});

test('scan speed shows on the result and in the admin stats', async ({ browser }) => {
  const backend = await newBackend({ latencyMs: 20 });
  const phone = await device(browser, backend);
  const reader = await device(browser, backend, { camera: true });
  const admin = await device(browser, backend);
  await signIn(phone.page, 'jordan');
  await expect(phone.page.locator('#qr svg')).toBeVisible();
  await startScanning(reader.page, 'scanner1', 'rec');
  await pointCameraAt(reader.page, await photoOf(phone.page));
  await expectResult(reader.page, 'Access granted');
  await expect(reader.page.locator('#r-meta')).toContainText(/checked in \d+ ms/);

  await signIn(admin.page, 'admin');
  await admin.page.click('#tabs [data-route="stats"]');
  await expect(admin.page.locator('#sp-verify')).toHaveText(/^\d+ ms$/, { timeout: 10000 });
  await expect(admin.page.locator('#sp-shown')).toHaveText(/^(\d+ ms|\d+\.\d+ s)$/);
  await expect(admin.page.locator('#speed-detail')).toContainText('Scans measured');
  const scan = backend.state.scans[0];
  expect(scan.shown_ms).toBeGreaterThan(0);
  expect(scan.shown_ms).toBeLessThan(60000);
  expect(scan.verify_ms).toBeGreaterThanOrEqual(0);
});

test('demo page: pre-flight check and a script whose ticks are remembered', async ({ browser }) => {
  const backend = await newBackend();
  const { page, errors } = await device(browser, backend);
  await signIn(page, 'admin');
  await page.click('#tabs [data-route="demo"]');
  await expect(page.locator('#preflight li')).toHaveCount(7);
  await page.click('#preflight-run');
  await expect(page.locator('#preflight li', { hasText: /^Server:/ })).toContainText('answered in');
  await expect(page.locator('#preflight li', { hasText: /^Clock:/ })).toContainText('in sync');
  await expect(page.locator('#preflight li', { hasText: /^Scan check:/ })).toContainText('ready');
  await expect(page.locator('#preflight li', { hasText: /^Demo data:/ })).toContainText('at the starting state');
  expect(backend.state.scans.length).toBe(0); // the check does not write to the scan log

  await page.check('#step-0');
  await page.check('#step-2');
  await page.reload();
  await page.click('#tabs [data-route="demo"]');
  await expect(page.locator('#step-0')).toBeChecked();
  await expect(page.locator('#step-1')).not.toBeChecked();
  await expect(page.locator('#step-2')).toBeChecked();
  await page.click('#script-clear');
  await expect(page.locator('#step-0')).not.toBeChecked();
  expect(errors).toEqual([]);
});

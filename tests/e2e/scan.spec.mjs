// Scanning: a student's phone on one side, a scanner on the other, and a fake
// camera in between that "sees" whatever picture the test holds up.

import { expect } from '@playwright/test';
import { coverCamera, device, expectResult, newBackend, nextScan, photoOf, pointCameraAt, signIn, startScanning, test } from './helpers.mjs';

async function studentWithCode(browser, backend, name = 'jordan') {
  const phone = await device(browser, backend);
  await signIn(phone.page, name);
  await expect(phone.page.locator('#qr svg')).toBeVisible();
  return phone;
}

test('live camera scan: granted with the photo, then the same code fails on a second scanner', async ({ browser }) => {
  const backend = await newBackend();
  const phone = await studentWithCode(browser, backend);
  const reader1 = await device(browser, backend, { camera: true });
  const reader2 = await device(browser, backend, { camera: true });

  await startScanning(reader1.page, 'scanner1', 'rec');
  const picture = await photoOf(phone.page);
  await pointCameraAt(reader1.page, picture);
  await expectResult(reader1.page, 'Access granted');
  await expect(reader1.page.locator('#result')).toHaveClass(/ok/);
  await expect(reader1.page.locator('#r-name')).toHaveText('Jordan Reyes');
  await expect(reader1.page.locator('#r-perm')).toHaveText('Perm 9900142');
  await expect(reader1.page.locator('#r-avatar img')).toHaveAttribute('src', 'avatars/jordan.svg');
  await expect(reader1.page.locator('#r-meta')).toContainText('Recreation Center');
  await expect(reader1.page.locator('#r-meta')).toContainText('checked in');

  // A second scanner, somewhere else, sees the very same code (a forwarded screenshot).
  await startScanning(reader2.page, 'scanner2', 'lib');
  await pointCameraAt(reader2.page, picture);
  await expectResult(reader2.page, 'Code already used');
  await expect(reader2.page.locator('#result')).toHaveClass(/bad/);
  await expect(reader2.page.locator('#r-reason')).toContainText('Rec Cen');

  // Back on the first scanner the code is still in front of the camera: it is not re-sent by accident.
  await nextScan(reader1.page);
  await expect(reader1.page.locator('#rescan-row')).toBeVisible();
  await expect(reader1.page.locator('#result')).toBeHidden();
  await reader1.page.click('#rescan');
  await expectResult(reader1.page, 'Code already used');

  // Both scans are in the scanner's own log.
  await nextScan(reader1.page);
  await coverCamera(reader1.page);
  await reader1.page.click('#tabs [data-route="log"]');
  await expect(reader1.page.locator('#log li')).toHaveCount(2);
  await expect(reader1.page.locator('#log li').first()).toContainText('Code already used');
  await expect(reader1.page.locator('#log li').last()).toContainText('Access granted');
  await expect(reader1.page.locator('#log li').last()).toContainText('Jordan Reyes');
  expect([...phone.errors, ...reader1.errors, ...reader2.errors]).toEqual([]);
});

test('the jsQR fallback reads the camera when BarcodeDetector is missing', async ({ browser }) => {
  const backend = await newBackend();
  const phone = await studentWithCode(browser, backend, 'sam');
  const reader = await device(browser, backend, { camera: true });
  await reader.context.addInitScript(() => { Object.defineProperty(window, 'BarcodeDetector', { value: undefined, configurable: true }); });
  await startScanning(reader.page, 'scanner1', 'lib');
  await pointCameraAt(reader.page, await photoOf(phone.page));
  await expectResult(reader.page, 'Access granted');
  await expect(reader.page.locator('#r-name')).toHaveText('Sam Okafor');
  expect(reader.errors).toEqual([]);
});

test('upload a screenshot instead of using the camera', async ({ browser }) => {
  const backend = await newBackend();
  const phone = await studentWithCode(browser, backend, 'aiko');
  const reader = await device(browser, backend);
  await signIn(reader.page, 'scanner1');
  await reader.page.click('#loc-chips [data-loc="lib"]');
  const png = await phone.page.locator('#qr').screenshot();
  await reader.page.setInputFiles('#file-input', { name: 'code.png', mimeType: 'image/png', buffer: png });
  await expectResult(reader.page, 'Access granted');
  await expect(reader.page.locator('#r-name')).toHaveText('Aiko Tanaka');

  await nextScan(reader.page);
  const blank = await phone.page.locator('#view-id .id-strip').screenshot();
  await reader.page.setInputFiles('#file-input', { name: 'blank.png', mimeType: 'image/png', buffer: blank });
  await expectResult(reader.page, 'No QR code found');
  await expect(reader.page.locator('#result')).toHaveClass(/warn/);
  expect(reader.errors).toEqual([]);
});

test('a scanner that is offline shows an amber "can\'t verify" and never grants', async ({ browser }) => {
  const backend = await newBackend();
  const phone = await studentWithCode(browser, backend, 'priya');
  const net = { down: false };
  const reader = await device(browser, backend, { camera: true, net });
  await startScanning(reader.page, 'scanner1', 'rec');
  net.down = true;
  await pointCameraAt(reader.page, await photoOf(phone.page));
  await expectResult(reader.page, "Can't verify");
  await expect(reader.page.locator('#result')).toHaveClass(/warn/);
  await expect(reader.page.locator('#r-reason')).toContainText('offline');
  expect(backend.state.scans.length).toBe(0);

  // Back online, the same code can be checked (it was never used).
  net.down = false;
  await nextScan(reader.page);
  await expectResult(reader.page, 'Access granted');
});

test('every demo tool button shows the result it promises', async ({ browser }) => {
  const backend = await newBackend();
  const reader = await device(browser, backend);
  await signIn(reader.page, 'scanner1');
  await reader.page.click('#loc-chips [data-loc="lib"]');
  const expected = {
    live: 'Access granted', expired: 'Code expired', reuse: 'Code already used', forged: 'Invalid code', lost: 'Card deactivated',
    mealplan: 'No meal plan', no_swipes: 'No swipes left', guest_reuse: 'Guest pass already used', guest_expired: 'Guest pass expired',
  };
  for (const [scenario, title] of Object.entries(expected)) {
    await reader.page.click(`[data-test="${scenario}"]`);
    await expectResult(reader.page, title);
    await expect(reader.page.locator('#r-meta')).toContainText('demo test');
    if (scenario === 'forged') await expect(reader.page.locator('#r-who')).toBeHidden();
    if (scenario === 'reuse') await expect(reader.page.locator('#r-reason')).toContainText('First scan at Library: granted');
    if (scenario === 'no_swipes') await expect(reader.page.locator('#r-extra')).toHaveText('0 meal swipes left this week');
    await nextScan(reader.page);
  }
  expect(reader.errors).toEqual([]);
});

test('sound switch is remembered, and auto-continue closes a granted result', async ({ browser }) => {
  const backend = await newBackend();
  const reader = await device(browser, backend);
  await signIn(reader.page, 'scanner1');
  await expect(reader.page.locator('#sound-on')).toBeChecked();
  await reader.page.uncheck('#sound-on');
  await reader.page.check('#auto-next');
  await reader.page.reload();
  await expect(reader.page.locator('#view-scan')).toBeVisible();
  await expect(reader.page.locator('#sound-on')).not.toBeChecked();
  await expect(reader.page.locator('#auto-next')).toBeChecked();

  await reader.page.click('[data-test="live"]');
  await expectResult(reader.page, 'Access granted');
  await expect(reader.page.locator('#result')).toBeHidden({ timeout: 6000 });
  await reader.page.click('[data-test="forged"]');
  await expectResult(reader.page, 'Invalid code');
  await reader.page.waitForTimeout(3500);
  await expect(reader.page.locator('#result')).toBeVisible(); // a denial waits for a person
  expect(reader.errors).toEqual([]);
});

test('sound plays through Web Audio when unmuted and stays silent when muted', async ({ browser }) => {
  const backend = await newBackend();
  const reader = await device(browser, backend);
  await reader.context.addInitScript(() => {
    window.__beeps = 0;
    const Real = window.AudioContext || window.webkitAudioContext;
    if (!Real) return;
    const original = Real.prototype.createOscillator;
    Real.prototype.createOscillator = function patched() { window.__beeps += 1; return original.call(this); };
  });
  await signIn(reader.page, 'scanner1');
  await reader.page.click('[data-test="live"]');
  await expectResult(reader.page, 'Access granted');
  expect(await reader.page.evaluate(() => window.__beeps)).toBeGreaterThan(0);
  await nextScan(reader.page);
  await reader.page.uncheck('#sound-on');
  const before = await reader.page.evaluate(() => window.__beeps);
  await reader.page.click('[data-test="forged"]');
  await expectResult(reader.page, 'Invalid code');
  expect(await reader.page.evaluate(() => window.__beeps)).toBe(before);
});

test('rate limit: an amber "slow down" instead of a result', async ({ browser }) => {
  const backend = await newBackend();
  const reader = await device(browser, backend);
  await signIn(reader.page, 'scanner1');
  const scannerId = [...backend.state.profiles.values()].find((p) => p.display_name === 'Dining Commons Staff').user_id;
  const start = Math.floor(Date.now() / 60000) * 60;
  for (const s of [start, start + 60]) backend.state.rateLimits.set(`scan:${scannerId}|${s}`, { key: `scan:${scannerId}`, start: s, count: 30 });
  await reader.page.click('[data-test="forged"]');
  await expectResult(reader.page, 'Slow down');
  await expect(reader.page.locator('#r-reason')).toContainText('Try again in');
});

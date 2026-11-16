// Lost phone: report from another device, the old phone's codes die at once.

import { expect } from '@playwright/test';
import { coverCamera, device, expectResult, newBackend, nextScan, photoOf, pointCameraAt, signIn, startScanning, test } from './helpers.mjs';

test('report lost from a second device, then reactivate', async ({ browser }) => {
  const backend = await newBackend();
  const lostPhone = await device(browser, backend);
  const laptop = await device(browser, backend);
  const reader = await device(browser, backend, { camera: true });

  await signIn(lostPhone.page, 'dev');
  await expect(lostPhone.page.locator('#qr svg')).toBeVisible();
  await expect(lostPhone.page.locator('#s-status')).toHaveText('Active');
  const oldCode = await photoOf(lostPhone.page);

  // The student signs in somewhere else and reports the phone lost.
  await signIn(laptop.page, 'dev');
  await expect(laptop.page.locator('#qr svg')).toBeVisible();
  await laptop.page.click('#report-lost');
  await expect(laptop.page.locator('#confirm')).toBeVisible();
  await laptop.page.click('#confirm-yes');
  await expect(laptop.page.locator('#s-status')).toHaveText('Reported lost');
  await expect(laptop.page.locator('#qr')).toBeHidden();
  await expect(laptop.page.locator('#dead-title')).toHaveText('ID reported lost');
  await expect(laptop.page.locator('#lost-panel')).toBeHidden();

  // The code still showing on the lost phone is refused straight away.
  await startScanning(reader.page, 'scanner1', 'lib');
  await pointCameraAt(reader.page, oldCode);
  await expectResult(reader.page, 'Card deactivated');
  await expect(reader.page.locator('#r-name')).toHaveText('Dev Malhotra');
  await nextScan(reader.page);
  await coverCamera(reader.page);

  // The lost phone signs itself out the next time it checks in, and keeps nothing.
  await expect(lostPhone.page.locator('#view-login')).toBeVisible({ timeout: 15000 });
  await expect(lostPhone.page.locator('#login-msg')).toContainText('reported lost');
  const leftovers = await lostPhone.page.evaluate(async () => {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith('gp:pass') || k === 'gp:me');
    const db = await new Promise((resolve) => { const r = indexedDB.open('gaucho-pass', 1); r.onupgradeneeded = () => r.result.createObjectStore('keys'); r.onsuccess = () => resolve(r.result); });
    const count = await new Promise((resolve) => { const q = db.transaction('keys').objectStore('keys').count(); q.onsuccess = () => resolve(q.result); });
    return { keys, count };
  });
  expect(leftovers).toEqual({ keys: [], count: 0 });

  // Reactivate on the laptop: a brand new code that works.
  await laptop.page.click('#reactivate');
  await expect(laptop.page.locator('#s-status')).toHaveText('Active');
  await expect(laptop.page.locator('#qr svg')).toBeVisible();
  await pointCameraAt(reader.page, await photoOf(laptop.page));
  await expectResult(reader.page, 'Access granted');
  await nextScan(reader.page);

  // The old phone's code is still dead, and now recognised as a deactivated device.
  // (The reader holds back a second code for someone it just let in, until staff tap "Scan it again".)
  await pointCameraAt(reader.page, oldCode);
  await expect(reader.page.locator('#rescan-row')).toContainText('This ID was just scanned.');
  await reader.page.click('#rescan');
  await expectResult(reader.page, 'Deactivated phone');
  expect([...laptop.errors, ...reader.errors, ...lostPhone.errors]).toEqual([]);
});

test('a card that starts out lost shows no code and can be reactivated', async ({ browser }) => {
  const backend = await newBackend();
  const { page, errors } = await device(browser, backend);
  await signIn(page, 'lena');
  await expect(page.locator('#s-status')).toHaveText('Reported lost');
  await expect(page.locator('#qr')).toBeHidden();
  await expect(page.locator('#s-access .tag.no')).toHaveCount(4);
  await page.click('#tabs [data-route="guests"]');
  await expect(page.locator('#guest-new')).toBeDisabled();
  await page.click('#tabs [data-route="id"]');
  await page.click('#reactivate');
  await expect(page.locator('#s-status')).toHaveText('Active');
  await expect(page.locator('#qr svg')).toBeVisible();
  expect(errors).toEqual([]);
});

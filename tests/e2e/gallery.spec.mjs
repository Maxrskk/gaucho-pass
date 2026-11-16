// Not a test of behaviour: takes a picture of every screen for a visual check.
//   SHOTS_DIR=/some/folder npx playwright test gallery --project=chromium

import { expect } from '@playwright/test';
import { coverCamera, device, expectResult, newBackend, nextScan, photoOf, pointCameraAt, signIn, startScanning, test } from './helpers.mjs';

const DIR = process.env.SHOTS_DIR;

for (const colorScheme of ['light', 'dark']) {
  test(`gallery (${colorScheme})`, async ({ browser, browserName }) => {
    test.skip(!DIR || browserName !== 'chromium', 'set SHOTS_DIR to take pictures');
    test.setTimeout(180_000);
    const backend = await newBackend();
    const snap = async (page, name, fullPage = true) => page.screenshot({ path: `${DIR}/${colorScheme}-${name}.png`, fullPage });
    const open = (extra = {}) => device(browser, backend, { colorScheme, ...extra });

    const phone = await open();
    await phone.page.goto('/');
    await expect(phone.page.locator('#view-login')).toBeVisible();
    await snap(phone.page, '01-login');
    await signIn(phone.page, 'jordan');
    await expect(phone.page.locator('#qr svg')).toBeVisible();
    await snap(phone.page, '02-id');
    await phone.page.click('#wallet-open');
    await snap(phone.page, '03-wallet', false);
    await phone.page.click('#wallet-close');

    await phone.page.click('#tabs [data-route="guests"]');
    await phone.page.click('#guest-new');
    await phone.page.fill('#guest-name', 'Alex Rivera');
    await phone.page.selectOption('#guest-where', 'rec');
    await snap(phone.page, '04-guest-new', false);
    await phone.page.click('#guest-create');
    await expect(phone.page.locator('#guest-list .qr svg')).toBeVisible();
    await phone.page.waitForTimeout(4200); // let the toast go
    await snap(phone.page, '05-guests');

    const reader = await open({ camera: true });
    await startScanning(reader.page, 'scanner1', 'rec');
    await pointCameraAt(reader.page, await photoOf(phone.page, '#guest-list .gpass .qr'));
    await expectResult(reader.page, 'Access granted');
    await snap(reader.page, '06-result-guest', false);
    await nextScan(reader.page);
    await coverCamera(reader.page);
    await reader.page.waitForTimeout(500); // let the last camera frame of the old code pass

    await phone.page.click('#tabs [data-route="id"]');
    await expect(phone.page.locator('#qr svg')).toBeVisible();
    await reader.page.click('#loc-chips [data-loc="carrillo"]');
    await pointCameraAt(reader.page, await photoOf(phone.page));
    await expectResult(reader.page, 'Access granted');
    await snap(reader.page, '07-result-granted', false);
    await nextScan(reader.page);
    await snap(reader.page, '08-scan-live');
    await reader.page.click('#rescan');
    await expectResult(reader.page, 'Code already used');
    await snap(reader.page, '09-result-denied', false);
    await nextScan(reader.page);
    await reader.page.click('#cam-btn');
    await reader.page.click('[data-test="forged"]');
    await expectResult(reader.page, 'Invalid code');
    await snap(reader.page, '10-result-forged', false);
    await nextScan(reader.page);
    await reader.page.click('[data-test="lost"]');
    await expectResult(reader.page, 'Card deactivated');
    await nextScan(reader.page);
    await reader.page.setInputFiles('#file-input', { name: 'x.png', mimeType: 'image/png', buffer: await phone.page.locator('#view-id .account').screenshot() });
    await expectResult(reader.page, 'No QR code found');
    await snap(reader.page, '11-result-warn', false);
    await nextScan(reader.page);
    await snap(reader.page, '12-scan-idle');
    await reader.page.click('#tabs [data-route="log"]');
    await expect(reader.page.locator('#log li').first()).toBeVisible();
    await snap(reader.page, '13-log');

    const lena = await open();
    await signIn(lena.page, 'lena');
    await expect(lena.page.locator('#dead-title')).toBeVisible();
    await snap(lena.page, '14-id-lost');

    const admin = await open();
    await signIn(admin.page, 'admin');
    await expect(admin.page.locator('#feed li').first()).toBeVisible();
    await snap(admin.page, '15-admin-live');
    await admin.page.click('#tabs [data-route="people"]');
    await expect(admin.page.locator('#people li').first()).toBeVisible();
    await snap(admin.page, '16-admin-students');
    await admin.page.click('#tabs [data-route="stats"]');
    await expect(admin.page.locator('#loc-bars .loc-row').first()).toBeVisible();
    await snap(admin.page, '17-admin-stats');
    await admin.page.click('#tabs [data-route="demo"]');
    await admin.page.click('#preflight-run');
    await expect(admin.page.locator('#preflight li', { hasText: /^Demo data:/ })).toContainText(/state|reset/i);
    await snap(admin.page, '18-demo');
    await admin.page.click('#tabs [data-route="people"]');
    await admin.page.locator('#people li button').first().click();
    await snap(admin.page, '19-confirm', false);

    const friend = await open();
    const token = Object.values(await phone.page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => k.startsWith('gp:guest-tokens')) ?? '') ?? '{}')))[0] ?? '0'.repeat(32);
    const packed = Buffer.from(JSON.stringify({ t: token, n: 'Alex Rivera', h: 'Jordan', w: 'rec', e: Math.floor(Date.now() / 1000) + 3000 })).toString('base64url');
    await friend.page.goto(`/#guest=${packed}`);
    await expect(friend.page.locator('#view-guest')).toBeVisible();
    await snap(friend.page, '20-guest-page');
  });
}

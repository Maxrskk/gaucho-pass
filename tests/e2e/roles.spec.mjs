// Sign-in, roles, and who can open which screen.

import { expect } from '@playwright/test';
import { device, newBackend, signIn, test } from './helpers.mjs';

test('wrong password and empty fields give clear messages', async ({ browser }) => {
  const backend = await newBackend();
  const { page, errors } = await device(browser, backend);
  await page.goto('/');
  await page.click('#login-submit');
  await expect(page.locator('#login-msg')).toHaveText('Enter the email of a test account.');
  await signIn(page, 'jordan', { password: 'not-the-password' });
  await expect(page.locator('#login-msg')).toHaveText('Wrong email or password.');
  await expect(page.locator('#view-login')).toBeVisible();
  await expect(page.locator('#tabs')).toBeHidden();
  expect(errors).toEqual([]);
});

test('a student sees only student screens and cannot open scanner or admin screens', async ({ browser }) => {
  const backend = await newBackend();
  const { page, errors } = await device(browser, backend);
  await signIn(page, 'jordan');
  await expect(page.locator('#s-name')).toHaveText('Jordan Reyes');
  await expect(page.locator('#tabs .tab')).toHaveText(['My ID', 'Guest passes']);

  for (const hash of ['#scan', '#scanner', '#admin', '#live', '#people', '#stats', '#log', '#demo']) {
    await page.evaluate((h) => { location.hash = h; }, hash);
    await expect(page.locator('#view-id')).toBeVisible();
    await expect(page).toHaveURL(/#id$/);
    for (const view of ['scan', 'log', 'live', 'people', 'stats', 'demo']) await expect(page.locator(`#view-${view}`)).toBeHidden();
  }
  await expect(page.locator('#toast')).toContainText("isn't available for student accounts");

  // Loading the page straight at an admin address makes no difference.
  await page.goto('/#live');
  await expect(page.locator('#view-id')).toBeVisible();
  await expect(page.locator('#view-live')).toBeHidden();

  // The server never sent this student any scanner or admin data.
  expect(backend.state.requests.some((r) => r.includes('admin_overview') || r.includes('my_recent_scans'))).toBe(false);
  expect(errors).toEqual([]);
});

test('a scanner sees scanner screens only, with no student data', async ({ browser }) => {
  const backend = await newBackend();
  const { page, errors } = await device(browser, backend);
  await signIn(page, 'scanner1');
  await expect(page.locator('#view-scan')).toBeVisible();
  await expect(page.locator('#tabs .tab')).toHaveText(['Scan', 'Log', 'Demo']);
  for (const hash of ['#id', '#student', '#guests', '#live', '#admin', '#people', '#stats']) {
    await page.evaluate((h) => { location.hash = h; }, hash);
    await expect(page.locator('#view-scan')).toBeVisible();
    for (const view of ['id', 'guests', 'live', 'people', 'stats']) await expect(page.locator(`#view-${view}`)).toBeHidden();
  }
  expect(backend.state.requests.some((r) => r.includes('get_my_pass') || r.includes('admin_overview'))).toBe(false);
  await expect(page.locator('#demo-admin')).toBeHidden();
  expect(errors).toEqual([]);
});

test('an admin gets the dashboard, the scanner and the demo controls', async ({ browser }) => {
  const backend = await newBackend();
  const { page, errors } = await device(browser, backend);
  await signIn(page, 'admin');
  await expect(page.locator('#view-live')).toBeVisible();
  await expect(page.locator('#tabs .tab')).toHaveText(['Live', 'Students', 'Stats', 'Scan', 'Demo']);
  await page.click('#tabs [data-route="people"]');
  await expect(page.locator('#people li')).toHaveCount(8);
  await page.click('#tabs [data-route="demo"]');
  await expect(page.locator('#demo-admin')).toBeVisible();
  await expect(page.locator('#script li')).toHaveCount(12);
  expect(errors).toEqual([]);
});

test('signing out clears the device, and staying signed in survives a reload', async ({ browser }) => {
  const backend = await newBackend();
  const { page, errors } = await device(browser, backend);
  await signIn(page, 'jordan');
  await expect(page.locator('#qr svg')).toBeVisible();
  await page.reload();
  await expect(page.locator('#s-name')).toHaveText('Jordan Reyes');
  await expect(page.locator('#qr svg')).toBeVisible();

  await page.click('#view-id [data-signout]');
  await expect(page.locator('#view-login')).toBeVisible();
  const left = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('gp:pass') || k === 'gp:me' || k === 'gp-auth'));
  expect(left).toEqual([]);
  await page.reload();
  await expect(page.locator('#view-login')).toBeVisible();
  expect(errors).toEqual([]);
});

test('an expired session sends the user back to sign in with a clear message', async ({ browser }) => {
  const backend = await newBackend();
  const { page } = await device(browser, backend);
  await signIn(page, 'scanner1');
  await expect(page.locator('#view-scan')).toBeVisible();
  backend.state.sessions.clear(); // the server ends every session
  await page.click('[data-test="forged"]');
  await expect(page.locator('#view-login')).toBeVisible();
  await expect(page.locator('#login-msg')).toContainText('session has expired');
});

test('phone width: nothing scrolls sideways, in light and dark mode', async ({ browser }) => {
  test.setTimeout(120_000);
  const backend = await newBackend();
  for (const colorScheme of ['light', 'dark']) {
    for (const [name, views] of [['jordan', ['id', 'guests']], ['admin', ['live', 'people', 'stats', 'scan', 'demo']]]) {
      const { page, context } = await device(browser, backend, { colorScheme, viewport: { width: 320, height: 640 } });
      await signIn(page, name);
      for (const view of views) {
        await page.click(`#tabs [data-route="${view}"]`);
        await expect(page.locator(`#view-${view}`)).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `${name} ${view} ${colorScheme}`).toBeLessThanOrEqual(0);
      }
      await context.close();
    }
  }
});

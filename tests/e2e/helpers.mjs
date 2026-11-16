// Shared helpers for the browser tests.

import { test as base, expect } from '@playwright/test';
import { MOCK_PASSWORDS, createMockBackend } from '../mock/backend.mjs';

// Every "device" a test opens is closed when the test ends. Without this, old
// pages keep their camera loops and timers running and slow down later tests.
const opened = [];
export const test = base.extend({
  closeDevices: [async ({}, use) => {
    await use();
    await Promise.all(opened.splice(0).map((context) => context.close().catch(() => {})));
  }, { auto: true }],
});

export const SUPABASE = 'https://vewlvgzlgcowyambvmep.supabase.co';
export const EMAIL = (name) => `${name}@gauchopass.example`;
const roleOf = (name) => (name === 'admin' ? 'admin' : name.startsWith('scanner') ? 'scanner' : 'student');

export async function newBackend(options) {
  const backend = createMockBackend(options);
  await backend.seed();
  return backend;
}

/** Answer every Supabase request from this browser context with the in-memory backend. */
export async function attach(context, backend, net = { down: false }) {
  await context.route(`${SUPABASE}/**`, async (route) => {
    if (net.down) { await route.abort('internetdisconnected'); return; }
    const req = route.request();
    const headers = {};
    for (const [k, v] of Object.entries(await req.allHeaders())) if (!k.startsWith(':')) headers[k] = v;
    const hasBody = !['GET', 'HEAD', 'OPTIONS'].includes(req.method());
    const res = await backend.handle(new Request(req.url(), {
      method: req.method(),
      headers,
      body: hasBody ? req.postDataBuffer() ?? undefined : undefined,
    }));
    await route.fulfill({
      status: res.status,
      headers: Object.fromEntries(res.headers),
      body: Buffer.from(await res.arrayBuffer()),
    });
  });
}

/** Fail the test on page errors and on CSP or console errors. */
export function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (/Failed to load resource|net::ERR_|fonts\.g(oogleapis|static)/.test(text)) return; // expected offline / font noise
    errors.push(`console: ${text}`);
  });
  return errors;
}

export async function signIn(page, name, { password } = {}) {
  await page.goto('/');
  await expect(page.locator('#view-login')).toBeVisible();
  await page.selectOption('#login-pick', EMAIL(name));
  await page.fill('#login-password', password ?? MOCK_PASSWORDS[roleOf(name)]);
  await page.click('#login-submit');
}

/** A context with a fake camera: the test decides what picture the camera "sees". */
export async function withFakeCamera(context) {
  await context.addInitScript(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    const ctx = canvas.getContext('2d');
    let picture = null;
    const draw = () => {
      ctx.fillStyle = '#8a8f96';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (picture) ctx.drawImage(picture, 170, 90, 300, 300);
    };
    setInterval(draw, 80);
    draw();
    // Replace the real camera. Defined on the prototype too, because WebKit ignores a plain assignment.
    const fake = async () => canvas.captureStream(12);
    if (!navigator.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', { value: {}, configurable: true });
    for (const target of [window.MediaDevices && window.MediaDevices.prototype, navigator.mediaDevices]) {
      if (target) Object.defineProperty(target, 'getUserMedia', { value: fake, configurable: true, writable: true });
    }
    window.__camera = {
      show: (dataUrl) => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => { picture = img; draw(); resolve(true); };
        img.onerror = () => reject(new Error('bad picture'));
        img.src = dataUrl;
      }),
      clear: () => { picture = null; draw(); },
    };
  });
}

/** Take a picture of the QR code showing on a page (as a phone camera would see it). */
export async function photoOf(page, selector = '#qr') {
  // Centre it first, so the sticky header or a toast can't cover part of the code.
  await page.locator(selector).first().evaluate((el) => el.scrollIntoView({ block: 'center' }));
  const png = await page.locator(selector).first().screenshot();
  return `data:image/png;base64,${png.toString('base64')}`;
}

export const pointCameraAt = (scannerPage, dataUrl) => scannerPage.evaluate((url) => window.__camera.show(url), dataUrl);
export const coverCamera = (scannerPage) => scannerPage.evaluate(() => window.__camera.clear());

/** Open a new "device": its own browser context wired to the same backend. */
export async function device(browser, backend, { camera = false, net, ...options } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block', ...options });
  opened.push(context);
  await attach(context, backend, net);
  if (camera) await withFakeCamera(context);
  const page = await context.newPage();
  const errors = watchErrors(page);
  return { context, page, errors };
}

/** Sign a scanner in, pick a location and start the (fake) camera. */
export async function startScanning(page, name, location) {
  await signIn(page, name);
  await page.click('#tabs [data-route="scan"]');
  await expect(page.locator('#view-scan')).toBeVisible();
  if (location) await page.click(`#loc-chips [data-loc="${location}"]`);
  await page.click('#cam-btn');
  await expect(page.locator('#cam-btn')).toHaveText('Stop camera');
}

export const result = (page) => page.locator('#result');
export async function expectResult(page, title) {
  await expect(page.locator('#result')).toBeVisible();
  await expect(page.locator('#r-title')).toHaveText(title);
}
export async function nextScan(page) {
  await page.click('#r-close');
  await expect(page.locator('#result')).toBeHidden();
}

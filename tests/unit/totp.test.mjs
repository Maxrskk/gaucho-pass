// The phone and the server must compute identical codes and QR text.
// This test runs the browser module (js/totp.js) against the server module.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as server from '../../supabase/functions/_shared/core.ts';

// js/totp.js imports js/ui.js, which touches localStorage only inside try/catch,
// so it loads in Node without a browser.
const phone = await import('../../js/totp.js');

test('phone and server agree on every code', async () => {
  for (let i = 0; i < 25; i++) {
    const secret = server.bytesToHex(crypto.getRandomValues(new Uint8Array(20)));
    const key = await phone.importSecret(secret);
    const window = 59_000_000 + i * 7919;
    assert.equal(await phone.codeFor(key, window), await server.totp(secret, window));
  }
});

test('the phone key cannot be exported', async () => {
  const key = await phone.importSecret('ab'.repeat(20));
  assert.equal(key.extractable, false);
  await assert.rejects(() => crypto.subtle.exportKey('raw', key));
});

test('phone and server agree on windows and QR text', () => {
  for (const ms of [0, 29_999, 30_000, 1_800_000_000_123]) assert.equal(phone.windowAt(ms), server.windowAt(ms));
  assert.equal(phone.STEP, server.STEP_SECONDS);
  const shown = 1_800_000_000_123;
  assert.equal(phone.studentPayload('9900142', '012345', shown), server.studentPayload('9900142', '012345', shown));
  assert.equal(phone.guestPayload('0'.repeat(32)), server.guestPayload('0'.repeat(32)));
  const parsed = server.parsePayload(phone.studentPayload('9900142', '012345', shown));
  assert.deepEqual(parsed, { kind: 'student', perm: '9900142', code: '012345', shownAt: shown });
});

test('the clock check only corrects when the phone is clearly wrong', () => {
  const t = Date.now();
  phone.noteServerTime(t + 1200, t - 50, t + 50); // 1.2 s out: normal
  assert.equal(phone.clockSkewSeconds(), 0);
  assert.ok(Math.abs(phone.serverNow() - Date.now()) < 50);
  phone.noteServerTime(t + 300_000, t - 50, t + 50); // 5 minutes out
  assert.equal(phone.clockSkewSeconds(), 300);
  assert.ok(Math.abs(phone.serverNow() - (Date.now() + 300_000)) < 100);
  phone.noteServerTime(t + 300_000, t - 9000, t); // reply took 9 s: ignore it
  assert.equal(phone.clockSkewSeconds(), 300);
  phone.noteServerTime(t, t - 50, t + 50);
  assert.equal(phone.clockSkewSeconds(), 0);
});

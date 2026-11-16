// Turns the server's short reason codes into words for people.
// The server decides; this file only explains the decision.

import { fmtDuration, fmtTime } from './ui.js';

export const PLACE = { dining: 'dining commons', rec: 'the Rec Cen', library: 'the Library', bus: 'MTD buses' };
export const PLACE_LABEL = { dining: 'Dining commons', rec: 'Rec Cen', library: 'Library', bus: 'MTD buses' };

const who = (r) => r.person?.first_name || 'This student';
const isGuest = (r) => r.person?.kind === 'guest';

const REASONS = {
  ok: {
    title: 'Access granted',
    text: (r) => (isGuest(r) ? `Guest of ${r.person.host_name}.` : `Welcome, ${who(r)}.`),
  },
  bad_format: {
    title: 'Not a Gaucho Pass code',
    text: (r) => (r.detail?.why === 'old_version'
      ? 'This code is from an old version of the app. Ask the student to reload Gaucho Pass.'
      : "This QR code didn't come from Gaucho Pass. Ask the student to open their Digital ID."),
  },
  unknown_id: { title: 'Unknown ID', text: () => 'No student account matches this code.' },
  invalid_code: {
    title: 'Invalid code',
    text: () => "This code doesn't match the ID's current code. It may be forged or copied.",
  },
  expired: {
    title: 'Code expired',
    text: (r) => `This code stopped working ${fmtDuration(r.detail?.age_seconds ?? 60)} ago, so it's likely a screenshot. Ask ${who(r)} to show their live screen.`,
  },
  clock_ahead: {
    title: 'Phone clock is wrong',
    text: (r) => `${who(r)}'s phone clock is about ${fmtDuration(r.detail?.ahead_seconds ?? 60)} ahead. Ask them to set the time to automatic and reload.`,
  },
  already_used: {
    title: 'Code already used',
    text: (r) => {
      const where = r.detail?.first_used_where ? ` at ${r.detail.first_used_where}` : '';
      const when = r.detail?.first_used_at ? ` at ${fmtTime(r.detail.first_used_at)}` : '';
      return `This exact code was already accepted${where}${when}. Each code works once.`;
    },
  },
  card_lost: {
    title: 'Card deactivated',
    text: (r) => `${who(r)}'s ID was reported lost or deactivated. It can't be used until it is reactivated.`,
  },
  revoked_device: {
    title: 'Deactivated phone',
    text: (r) => `This code came from a phone that was reported lost. ${who(r)}'s ID now lives on a different device.`,
  },
  no_access: {
    title: 'No access here',
    text: (r) => (isGuest(r) ? `The host's account doesn't include ${r.location?.name ?? 'this location'}.` : `${who(r)}'s account doesn't include ${r.location?.name ?? 'this location'}.`),
  },
  no_meal_plan: {
    title: 'No meal plan',
    text: (r) => (isGuest(r) ? "The host doesn't have a meal plan." : `${who(r)} doesn't have a meal plan, so this dining commons reader won't let them in.`),
  },
  no_swipes: {
    title: 'No swipes left',
    text: (r) => (isGuest(r) ? 'The host has no meal swipes left this week.' : `${who(r)} has used all their meal swipes for this week.`),
  },
  too_many_attempts: {
    title: 'Too many wrong codes',
    text: () => 'This ID is locked for a few minutes after repeated wrong codes. If it keeps happening, send the student to the access office.',
  },
  guest_used: {
    title: 'Guest pass already used',
    text: (r) => `This guest pass was used${r.detail?.used_at ? ` at ${fmtTime(r.detail.used_at)}` : ''}. A guest pass works for one scan.`,
  },
  guest_expired: { title: 'Guest pass expired', text: () => 'Guest passes last one hour. Ask the host to make a new one.' },
  guest_revoked: { title: 'Guest pass cancelled', text: () => 'The host cancelled this pass, or their ID was deactivated.' },
  guest_wrong_place: {
    title: 'Wrong place for this pass',
    text: (r) => `This guest pass is for ${PLACE[r.detail?.valid_for] ?? 'a different place'}.`,
  },
};

export const reasonTitle = (reason) => REASONS[reason]?.title ?? 'Denied';

/** Words for one verify-scan answer. */
export function describe(result) {
  const entry = REASONS[result.reason] ?? { title: 'Denied', text: () => 'The server refused this scan.' };
  const granted = result.result === 'granted';
  let extra = null;
  if (result.unlimited) extra = 'Unlimited meal plan';
  else if (typeof result.swipes_left === 'number') {
    extra = `${result.swipes_left} meal swipe${result.swipes_left === 1 ? '' : 's'} left this week`;
  }
  return { tone: granted ? 'ok' : 'bad', title: entry.title, text: entry.text(result), extra };
}

// ---------- Problems that are not a decision about a code ----------

const SYSTEM = {
  offline: { title: "Can't verify", text: "This reader is offline, so the code can't be checked. Nobody is let in until it reconnects. Check the Wi-Fi and scan again." },
  rate_limited: { title: 'Slow down', text: 'Too many scans in a short time. Wait a few seconds and scan again.' },
  not_signed_in: { title: 'Signed out', text: 'Your session has expired. Sign in again to keep scanning.' },
  wrong_role: { title: 'Not allowed', text: "This account can't verify scans." },
  demo_off: { title: 'Demo tools are off', text: 'An admin has turned the demo tools off.' },
  not_seeded: { title: 'Demo data missing', text: 'Ask an admin to reset the demo data.' },
  invalid_request: { title: "Couldn't read that", text: 'The reader sent something the server did not understand. Try scanning again.' },
  server_error: { title: 'Server problem', text: 'The server had a problem checking this code. Try again.' },
  no_qr: { title: 'No QR code found', text: 'Use a picture with the whole code in frame and the phone screen turned up bright.' },
  bad_image: { title: "Couldn't read that image", text: 'Try a different photo or a PNG or JPG screenshot.' },
};

export function systemResult(code, err) {
  const entry = SYSTEM[code] ?? SYSTEM.server_error;
  let text = entry.text;
  if (code === 'rate_limited' && err?.payload?.retry_after) text = `Too many scans in a short time. Try again in ${err.payload.retry_after} seconds.`;
  return { tone: 'warn', title: entry.title, text, extra: null };
}

// ---------- Short messages for actions (toasts and form errors) ----------

const ERRORS = {
  offline: "You're offline. Connect to the internet and try again.",
  not_signed_in: 'Your session has expired. Sign in again.',
  wrong_role: "This account isn't allowed to do that.",
  device_blocked: 'This device was signed out when the ID was reported lost. Sign in again.',
  admin_locked: 'The access office deactivated this ID. Only they can reactivate it.',
  card_lost: 'Your ID is deactivated. Reactivate it first.',
  bad_guest_name: "Enter the guest's name using letters, numbers, spaces, or . ' -",
  bad_location_type: 'Choose where the pass is for.',
  no_access: "Your ID doesn't include that place.",
  no_meal_plan: 'You need a meal plan to bring a guest to a dining commons.',
  no_swipes: 'You have no meal swipes left this week.',
  too_many_active: 'You already have 2 active guest passes. Cancel one or wait for it to be used.',
  daily_limit: "You've reached today's limit of 6 guest passes.",
  rate_limited: 'Too many requests. Wait a moment and try again.',
  demo_off: 'Demo tools are turned off.',
};

export const errorText = (err) => ERRORS[err?.code] ?? 'Something went wrong. Try again.';

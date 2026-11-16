// The page a guest sees when they open the link their host shared.
// No sign-in. Everything shown here comes from the link itself and is only for
// display: the server decides whether the pass is valid when it is scanned.

import { PLACE_LABEL } from './reasons.js';
import { guestPayload } from './totp.js';
import { $, fmtDuration, qrSvg } from './ui.js';

let timer = null;

/** Read "#guest=..." from the address bar. Returns null if it isn't a usable guest link. */
export function parseGuestLink(hash) {
  const match = /^#guest=([A-Za-z0-9_-]{20,600})$/.exec(hash);
  if (!match) return null;
  try {
    const b64 = match[1].replace(/-/g, '+').replace(/_/g, '/');
    const data = JSON.parse(decodeURIComponent(escape(atob(b64))));
    if (typeof data !== 'object' || data === null) return null;
    if (typeof data.t !== 'string' || !/^[0-9a-f]{32}$/.test(data.t)) return null;
    const expires = Number(data.e);
    return {
      token: data.t,
      name: typeof data.n === 'string' ? data.n.slice(0, 40) : 'Guest',
      host: typeof data.h === 'string' ? data.h.slice(0, 40) : '',
      where: typeof data.w === 'string' && Object.hasOwn(PLACE_LABEL, data.w) ? data.w : null,
      expiresAt: Number.isFinite(expires) ? expires * 1000 : null,
    };
  } catch {
    return null;
  }
}

export function showGuest(pass) {
  $('g-name').textContent = pass.name;
  $('g-sub').textContent = [pass.host ? `Guest of ${pass.host}` : 'Guest pass', pass.where ? PLACE_LABEL[pass.where] : null].filter(Boolean).join(' · ');
  $('g-qr').innerHTML = qrSvg(guestPayload(pass.token));

  const update = () => {
    const left = pass.expiresAt === null ? null : (pass.expiresAt - Date.now()) / 1000;
    const expired = left !== null && left <= 0;
    $('g-qr').hidden = expired;
    $('g-dead').hidden = !expired;
    const status = $('g-status');
    status.textContent = expired ? 'Expired' : 'One scan';
    status.className = 'status ' + (expired ? 'lost' : 'active');
    $('g-hint').textContent = expired || left === null ? '' : `Expires in ${fmtDuration(left)}`;
  };
  update();
  clearInterval(timer);
  timer = setInterval(update, 5000);
}

export function hideGuest() {
  clearInterval(timer);
  $('g-qr').innerHTML = '';
}

// Sound and vibration for scan results, with a mute switch.
// Browsers only allow sound after a tap, so unlock() is called from button taps.

import { store } from './ui.js';

let ctx = null;

export const soundOn = () => store.get('sound', '1') === '1';
export const setSoundOn = (on) => store.set('sound', on ? '1' : '0');

export function unlock() {
  try {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    ctx = ctx || new Ctor();
    if (ctx.state === 'suspended') ctx.resume();
  } catch { /* no audio on this device */ }
}

function beep(freq, startAt, seconds, type = 'sine', volume = 0.2) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const t = ctx.currentTime + startAt;
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(volume, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + seconds + 0.02);
}

const SOUNDS = {
  ok: () => { beep(880, 0, 0.1); beep(1318.5, 0.11, 0.16); },
  bad: () => { beep(196, 0, 0.18, 'square', 0.12); beep(155.6, 0.22, 0.26, 'square', 0.12); },
  warn: () => { beep(440, 0, 0.22, 'triangle'); },
};
const BUZZ = { ok: [70], bad: [140, 70, 140], warn: [90] };

/** Play the sound and vibration for a result. Returns true if sound was attempted. */
export function signal(tone) {
  if (!soundOn()) return false;
  try { if (navigator.vibrate) navigator.vibrate(BUZZ[tone] ?? BUZZ.warn); } catch { /* not supported (iPhone) */ }
  try {
    unlock();
    if (!ctx) return false;
    const play = () => (SOUNDS[tone] ?? SOUNDS.warn)();
    // Right after the first tap the audio may still be waking up: play as soon as it is ready.
    if (ctx.state === 'running') play();
    else ctx.resume().then(play).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

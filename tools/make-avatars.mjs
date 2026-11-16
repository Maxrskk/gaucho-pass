// Draws the avatar illustrations for the made-up test students.
// These are original drawings built from simple shapes, not photos of anyone.
//
//   node tools/make-avatars.mjs      writes avatars/<name>.svg

import { mkdirSync, writeFileSync } from 'node:fs';

const out = new URL('../avatars/', import.meta.url);

/** Darken a hex colour by mixing it with black. */
function darken(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (shift) => Math.round(((n >> shift) & 255) * (1 - amount)).toString(16).padStart(2, '0');
  return `#${ch(16)}${ch(8)}${ch(0)}`;
}

const BACK_HAIR = {
  long: 'M33 56c-4-28 10-41 27-41s31 13 27 41c-1 14 2 27 7 36H26c5-9 8-22 7-36z',
  bob: 'M33 54c-3-25 9-38 27-38s30 13 27 38c0 9 0 16 3 22H30c3-6 3-13 3-22z',
  afro: 'M60 12c20 0 33 14 33 32 0 10-4 18-9 23H36c-5-5-9-13-9-23 0-18 13-32 33-32z',
  wavy: 'M32 58c-5-28 9-43 28-43s33 15 28 43c0 6 4 10 3 17-1 8 3 13 6 17H23c3-4 7-9 6-17-1-7 3-11 3-17z',
};

const FRONT_HAIR = {
  short: 'M36 52c-2-22 10-34 24-34s26 11 24 34c-3-9-7-15-24-16-17 1-21 7-24 16z',
  side: 'M36 51c-2-21 10-33 25-33 14 0 25 10 23 32-6-6-9-14-17-16-9 7-22 7-31 17z',
  buzz: 'M37 49c0-18 10-29 23-29s23 11 23 29c-4-10-10-14-23-14s-19 4-23 14z',
  part: 'M36 57c-4-25 8-39 24-39s28 14 24 39c-2-13-8-22-24-25-16 3-22 12-24 25z',
  fringe: 'M36 53c-1-22 10-34 24-34s25 12 24 34c-8-7-14-10-24-10s-16 3-24 10z',
  curls: null, // drawn as circles
};

function hairFront(style, colour) {
  if (style === 'curls') {
    const dots = [[42, 34, 9], [52, 27, 10], [64, 26, 10], [75, 31, 9], [81, 41, 8], [38, 44, 8], [58, 33, 9], [70, 36, 8]];
    return dots.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${colour}"/>`).join('');
  }
  return `<path d="${FRONT_HAIR[style]}" fill="${colour}"/>`;
}

function avatar(p) {
  const shade = darken(p.skin, 0.2);
  const ink = '#2A1F1A';
  const parts = [];
  parts.push(`<rect width="120" height="120" fill="${p.bg}"/>`);
  if (p.back) parts.push(`<path d="${BACK_HAIR[p.back]}" fill="${p.hair}"/>`);
  if (p.tail) parts.push(`<path d="M79 28c13 3 19 16 14 32-3 9-8 14-13 16 5-13 3-27-5-36z" fill="${p.hair}"/>`);
  if (p.bun) parts.push(`<circle cx="60" cy="16" r="10" fill="${p.hair}"/>`);
  // shoulders and neck
  parts.push(`<path d="M10 120c0-23 21-34 50-34s50 11 50 34z" fill="${p.shirt}"/>`);
  parts.push(`<path d="M49 72h22v15c0 6-5 11-11 11s-11-5-11-11z" fill="${p.skin}"/>`);
  parts.push(`<path d="M49 79c6 5 16 5 22 0v5c-6 5-16 5-22 0z" fill="${shade}" opacity=".55"/>`);
  if (p.collar) parts.push(`<path d="M44 90l16 12 16-12 4 4-20 16-20-16z" fill="${darken(p.shirt, 0.25)}"/>`);
  // head
  parts.push(`<circle cx="36.5" cy="57" r="5" fill="${p.skin}"/><circle cx="83.5" cy="57" r="5" fill="${p.skin}"/>`);
  parts.push(`<ellipse cx="60" cy="54" rx="23" ry="26" fill="${p.skin}"/>`);
  if (p.beard) parts.push(`<path d="M37.5 58c1 19 10 26 22.500 26s21.500-7 22.500-26c-4 9-9 11-22.500 11s-18.500-2-22.500-11z" fill="${p.hair}" opacity=".92"/>`);
  parts.push(hairFront(p.front, p.hair));
  // face
  parts.push(`<circle cx="51" cy="56" r="2.600" fill="${ink}"/><circle cx="69" cy="56" r="2.600" fill="${ink}"/>`);
  parts.push(`<g fill="none" stroke="${p.brow ?? p.hair}" stroke-width="2.200" stroke-linecap="round"><path d="M46 49.500q5-3 10 0"/><path d="M64 49.500q5-3 10 0"/></g>`);
  parts.push(`<path d="M60 58v6q0 2.500-3 2.500" fill="none" stroke="${shade}" stroke-width="1.800" stroke-linecap="round"/>`);
  parts.push(p.smile === 'open'
    ? `<path d="M52 69q8 9 16 0z" fill="#fff" stroke="#8A3B34" stroke-width="1.800" stroke-linejoin="round"/>`
    : `<path d="M52.500 70q7.500 5.500 15 0" fill="none" stroke="#8A3B34" stroke-width="2.200" stroke-linecap="round"/>`);
  if (p.glasses === 'round') {
    parts.push(`<g fill="none" stroke="#2B2B2B" stroke-width="2"><circle cx="51" cy="56" r="7.500"/><circle cx="69" cy="56" r="7.500"/><path d="M58.500 56h3"/></g>`);
  } else if (p.glasses === 'square') {
    parts.push(`<g fill="none" stroke="#2B2B2B" stroke-width="2"><rect x="43" y="50" width="15.500" height="12" rx="3.500"/><rect x="61.500" y="50" width="15.500" height="12" rx="3.500"/><path d="M58.500 55h3"/></g>`);
  }
  if (p.earrings) parts.push(`<circle cx="36" cy="64" r="2.400" fill="#F3B61F"/><circle cx="84" cy="64" r="2.400" fill="#F3B61F"/>`);
  const body = parts.join('').replace(/(\d)\.(\d)00\b/g, '$1.$2');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" role="img" aria-label="Illustrated avatar of ${p.name}"><title>Illustrated avatar of ${p.name}</title>${body}</svg>\n`;
}

const PEOPLE = {
  jordan: { name: 'Jordan Reyes', bg: '#CFE3F5', skin: '#D9A074', hair: '#3B2A20', front: 'side', shirt: '#274C77', collar: true },
  priya: { name: 'Priya Natarajan', bg: '#F6D5E3', skin: '#A9714B', hair: '#1E1A1A', back: 'long', front: 'part', shirt: '#B0336B', earrings: true, smile: 'open' },
  theo: { name: 'Theo Whitfield', bg: '#DCEBD9', skin: '#F0C8A8', hair: '#B9853F', front: 'short', beard: true, shirt: '#3F7D58' },
  lena: { name: 'Lena Park', bg: '#D3EEEA', skin: '#EBC3A0', hair: '#22201F', back: 'bob', front: 'fringe', glasses: 'round', shirt: '#1F8A8A' },
  sam: { name: 'Sam Okafor', bg: '#E2DAF7', skin: '#6F4A34', hair: '#161414', back: 'afro', front: 'curls', shirt: '#6A4BC4', smile: 'open' },
  maya: { name: 'Maya Castellanos', bg: '#FBE3CC', skin: '#C98F63', hair: '#5A3A28', back: 'wavy', front: 'part', shirt: '#D9772B', earrings: true },
  dev: { name: 'Dev Malhotra', bg: '#DDE3EA', skin: '#B37D55', hair: '#1B1817', front: 'buzz', beard: true, glasses: 'square', shirt: '#4B6584', collar: true },
  aiko: { name: 'Aiko Tanaka', bg: '#F8D9D6', skin: '#F2D0B4', hair: '#1F1B1D', front: 'fringe', bun: true, shirt: '#C94A4A', smile: 'open' },
};

mkdirSync(out, { recursive: true });
for (const [key, person] of Object.entries(PEOPLE)) {
  writeFileSync(new URL(`${key}.svg`, out), avatar(person));
}
console.log(`Wrote ${Object.keys(PEOPLE).length} avatars to avatars/`);

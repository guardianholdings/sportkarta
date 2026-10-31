// The clubs page's product screenshots (components/marketing/clubs/shots.ts):
// one picture per catalogue area, taken from a running dev server with a
// seeded demo club — fixture names, nobody real — and written as WebP under
// public/marketing with a manifest the page reads for the dimensions.
//
//   pnpm --filter @sportkarta/web shots:marketing
//
// Needs: a dev server (SHOTS_BASE_URL, default http://localhost:3040) started
// with CLUBS_ENABLED and every CLUB_*_ENABLED switch on (so no area is hidden),
// MAIL_TRANSPORT=file (the sign-in code is read from the outbox, exactly as the
// e2e suite does — the app has no backdoor), and a club whose owner's address
// is SHOTS_OWNER_EMAIL. The
// default is the local parity club, whose fixtures read as placeholders —
// «Твоята зала», «Твоето име», «Твоят клиент» — so a visitor sees their own
// club in the picture rather than someone else's. A page that answers
// anything but 200 (the portal needs the owner to be a linked member) is
// skipped and reported, never written. Re-run after UI changes; the output is
// committed. Not part of any test suite.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { chromium } from '@playwright/test';
import sharp from 'sharp';

const BASE = (process.env.SHOTS_BASE_URL ?? 'http://localhost:3040').replace(/\/+$/, '');
const SLUG = process.env.SHOTS_CLUB_SLUG ?? 'tvoyata-zala';
const OWNER = process.env.SHOTS_OWNER_EMAIL ?? 'tvoeto.ime@example.org';
const OUTBOX = process.env.MAIL_OUTBOX_DIR?.trim() || './var/mail';
const OUT_DIR = 'public/marketing';
const MANIFEST = 'lib/marketing-shots.json';
const WIDTH = 1200;
// The address a visitor knows. Screens that print the club's own links (the
// settings page, the embeds) print the dev server's origin; the picture shows
// this one in its place.
const PUBLIC_ORIGIN = (process.env.SHOTS_PUBLIC_ORIGIN ?? 'https://pops.bg').replace(/\/+$/, '');

/** Catalogue area → the office screen that shows it (lib/src/clubs/catalogue.ts keys). */
const SHOTS = [
  { key: 'hero', file: 'tablo', path: `/klub/${SLUG}/tablo` },
  { key: 'dashboard', file: 'tablo', path: `/klub/${SLUG}/tablo` },
  { key: 'members', file: 'chlenove', path: `/klub/${SLUG}/chlenove` },
  { key: 'plans', file: 'abonamenti', path: `/klub/${SLUG}/abonamenti` },
  { key: 'schedule', file: 'grafik', path: `/klub/${SLUG}/grafik` },
  { key: 'attendance', file: 'prisastviya', path: `/klub/${SLUG}/prisastviya` },
  { key: 'courts', file: 'kalendar', path: `/klub/${SLUG}/kalendar` },
  { key: 'events', file: 'sabitiya', path: `/klub/${SLUG}/sabitiya` },
  { key: 'payments', file: 'plashtaniya', path: `/klub/${SLUG}/plashtaniya` },
  { key: 'shop', file: 'prodazhbi', path: `/klub/${SLUG}/prodazhbi` },
  { key: 'invoices', file: 'fakturi', path: `/klub/${SLUG}/fakturi` },
  { key: 'messaging', file: 'saobshteniya', path: `/klub/${SLUG}/saobshteniya` },
  { key: 'inbox', file: 'vhodyashti', path: `/klub/${SLUG}/vhodyashti` },
  { key: 'documents', file: 'dokumenti', path: `/klub/${SLUG}/dokumenti` },
  { key: 'reports', file: 'otcheti', path: `/klub/${SLUG}/otcheti` },
  { key: 'team', file: 'ekip', path: `/klub/${SLUG}/ekip` },
  // From the club's own heading down: the consent status line above it is
  // the visitor's, not the page's.
  { key: 'website', file: 'stranitsa', path: `/klub/${SLUG}`, anonymous: true, from: 'h1' },
  { key: 'portal', file: 'portal', path: `/klub/${SLUG}/az` },
  { key: 'integrations', file: 'integratsii', path: `/klub/${SLUG}/integratsii` },
  { key: 'security', file: 'nastroyki', path: `/klub/${SLUG}/nastroyki` },
];

async function outbox(email) {
  let files;
  try {
    files = (await readdir(OUTBOX)).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const found = [];
  for (const name of files) {
    try {
      const message = JSON.parse(await readFile(path.join(OUTBOX, name), 'utf8'));
      if (message.to === email)
        found.push({ id: name, at: Date.parse(message.sentAt), text: message.text });
    } catch {
      // a file still being written
    }
  }
  return found;
}

async function readOtp(email, since, seen) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const newest = (await outbox(email))
      .filter((m) => !seen.has(m.id) && m.at >= since)
      .sort((a, b) => b.at - a.at)[0];
    const code = newest && /\b(\d{6})\b/.exec(newest.text)?.[1];
    if (code) return code;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`no sign-in code was delivered to ${email}`);
}

async function signIn(page, email) {
  await page.goto(`${BASE}/vhod`);
  await page.getByLabel(/имейл|email/i).fill(email);
  const seen = new Set((await outbox(email)).map((m) => m.id));
  const since = Date.now() - 1000;
  await page.getByRole('button', { name: /изпрати код|send code/i }).click();
  const code = await readOtp(email, since, seen);
  await page.getByLabel(/код|code/i).fill(code);
  await page.getByRole('button', { name: /^(влез|sign in)$/i }).click();
  await page.waitForURL(/\/(profil|klub)/);
}

// The dev overlay and the site footer stay out of the picture: a short office
// screen would otherwise end in the footer's link columns.
const HIDE_DEV_UI =
  'nextjs-portal, #__next-build-watcher, body > footer, footer.border-t { display: none !important; }';

async function capture(page, shot) {
  const response = await page.goto(`${BASE}${shot.path}`, { waitUntil: 'networkidle' });
  const status = response?.status() ?? 0;
  if (status !== 200 || !page.url().endsWith(shot.path)) {
    return { skipped: `${shot.path} answered ${status} at ${page.url()}` };
  }
  await page.addStyleTag({ content: HIDE_DEV_UI });
  await page.evaluate((origin) => {
    const local = /(https?:\/\/)?(?:localhost|127\.0\.0\.1)(?::\d+)?/g;
    const host = origin.replace(/^https?:\/\//, '');
    const swap = (text) => text.replace(local, (_, scheme) => (scheme ? origin : host));
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (local.test(node.nodeValue)) node.nodeValue = swap(node.nodeValue);
      local.lastIndex = 0;
    }
    for (const field of document.querySelectorAll('input, textarea')) {
      if (local.test(field.value)) field.value = swap(field.value);
      local.lastIndex = 0;
    }
  }, PUBLIC_ORIGIN);
  // A club with its own pixels opens its public page with the consent card
  // (wave H2); the picture is of the page, not of the question — decline it.
  const decline = page.getByRole('button', { name: /отказвам всички|reject all/i });
  if (await decline.count()) {
    await decline.first().click();
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(900);
  // The content's own height when it is shorter than the viewport, so a short
  // screen is a short picture rather than a tall one with a blank foot.
  const top = shot.from
    ? await page.evaluate((selector) => {
        const el = document.querySelector(selector);
        return el
          ? Math.max(0, Math.round(el.getBoundingClientRect().top + window.scrollY) - 24)
          : 0;
      }, shot.from)
    : 0;
  // Down to the last thing on the screen (the shell keeps the page a viewport
  // tall even when the office screen is short), at most the viewport.
  const clipHeight = await page.evaluate((start) => {
    let bottom = 0;
    for (const el of document.querySelectorAll('main *, main')) {
      const rect = el.getBoundingClientRect();
      if (rect.height > 0) bottom = Math.max(bottom, rect.bottom + window.scrollY);
    }
    return Math.min(800, Math.max(360, Math.round(bottom) + 24 - start));
  }, top);
  const png = await page.screenshot({
    type: 'png',
    fullPage: true,
    clip: { x: 0, y: top, width: 1280, height: clipHeight },
  });
  const out = path.join(OUT_DIR, `${shot.file}.webp`);
  const image = sharp(png).resize({ width: WIDTH }).webp({ quality: 80 });
  const { width, height, size } = await image.toFile(out);
  return { src: `/marketing/${shot.file}.webp`, width, height, size };
}

const browser = await chromium.launch();
try {
  await mkdir(OUT_DIR, { recursive: true });
  const signedIn = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1.5,
    locale: 'bg-BG',
  });
  const anonymous = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1.5,
    locale: 'bg-BG',
  });
  const office = await signedIn.newPage();
  await signIn(office, OWNER);
  const visitor = await anonymous.newPage();

  const manifest = {};
  const done = new Map();
  for (const shot of SHOTS) {
    const page = shot.anonymous ? visitor : office;
    const result = done.get(shot.file) ?? (await capture(page, shot));
    done.set(shot.file, result);
    if (result.skipped) {
      console.log(`skip  ${shot.key.padEnd(13)} ${result.skipped}`);
      continue;
    }
    manifest[shot.key] = { src: result.src, width: result.width, height: result.height };
    console.log(
      `shot  ${shot.key.padEnd(13)} ${result.src} ${result.width}x${result.height} ${Math.round(result.size / 1024)} KB`,
    );
  }
  await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`manifest ${MANIFEST}: ${Object.keys(manifest).length} areas`);
} finally {
  await browser.close();
}

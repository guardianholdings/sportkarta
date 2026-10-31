// The front page's screen recordings (components/guide/screen-recording.tsx):
// five short flows, each a sequence of real phone screens plus where the
// finger lands, written as WebP under public/guide with a manifest the page
// reads (lib/home/guide-recordings.json).
//
//   pnpm --filter @sportkarta/web shots:guide
//
// One member per language walks the whole product, so every number in the
// pictures is earned in front of the camera: they add a place (+10), confirm
// another (+3), report a third's condition (+2) and check in to a тренировка
// with the organiser's live QR code (+2) — and the passport at the end shows
// the 17 points those four steps paid. Nothing is typed into a counter.
//
// Needs, all local:
//  - a dev server (SHOTS_BASE_URL, default http://localhost:3040) whose
//    database holds the OSM places (a copy of the dev database is fine) and
//    whose NEXT_PUBLIC_SITE_URL is that same origin — the scanner only opens
//    codes for its own origin;
//  - MAIL_TRANSPORT=file, so the sign-in codes are read from the outbox
//    exactly as the e2e suite reads them (the app has no backdoor);
//  - an admin account (SHOTS_ORGANISER_EMAIL) — the association organises the
//    open тренировки, and guide-fixtures.mts names it «POPS»;
//  - ffmpeg, which turns the organiser's QR screen into the fake camera feed
//    the in-app scanner reads.
// The basemap is read from the public tiles archive (SHOTS_TILES_URL), range
// by range, as every visitor's browser reads it; nothing is downloaded.
// Re-run after UI changes; the output is committed. Not part of any suite.
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { chromium } from '@playwright/test';
import sharp from 'sharp';

const BASE = (process.env.SHOTS_BASE_URL ?? 'http://localhost:3040').replace(/\/+$/, '');
// It signs accounts in and writes data: a local server only.
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(BASE).hostname)) {
  throw new Error(`shots:guide records a local dev server, not ${BASE}`);
}
const TILES = process.env.SHOTS_TILES_URL ?? 'https://pops.bg/tiles/bulgaria.pmtiles';
const ORGANISER = process.env.SHOTS_ORGANISER_EMAIL ?? 'e2e@example.org';
const OUTBOX = process.env.MAIL_OUTBOX_DIR?.trim() || './var/mail';
const OUT_DIR = 'public/guide';
const MANIFEST = 'lib/home/guide-recordings.json';
const PHONE = { width: 390, height: 844 };
const SCALE = 2;
const RUN = Date.now().toString(36);

/** Южен парк, Sofia: where the member stands, and the real places around them. */
const SPOT = { latitude: 42.6685, longitude: 23.3165 };
const PLACES = {
  verify: { slug: 'node-6268614279', at: { latitude: 42.6688, longitude: 23.3156 } },
  condition: { slug: 'node-13307755942', at: { latitude: 42.6694, longitude: 23.3172 } },
  checkin: { at: { latitude: 42.6704, longitude: 23.3137 } },
};

const LOCALES = {
  bg: {
    prefix: '',
    browserLocale: 'bg-BG',
    name: 'Вашето име',
    // Where each member adds their place: open ground in the park, apart.
    add: { latitude: 42.6679, longitude: 23.3171 },
  },
  en: {
    prefix: '/en',
    browserLocale: 'en-GB',
    name: 'Your name',
    add: { latitude: 42.6672, longitude: 23.3158 },
  },
};

const messages = {
  bg: JSON.parse(await readFile('messages/bg.json', 'utf8')),
  en: JSON.parse(await readFile('messages/en.json', 'utf8')),
};
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const exact = (text) => new RegExp(`^\\s*${escape(text)}\\s*$`);
/** The fixed opening of an ICU message, before its first argument. */
const opening = (message) => new RegExp(escape(message.split('{')[0].trim()));

// ── sign-in through the outbox, as e2e/auth.ts does ──────────────────────────

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

async function signIn(page, email, prefix) {
  await page.goto(`${BASE}${prefix}/vhod`);
  await page.getByLabel(/имейл|email/i).fill(email);
  const seen = new Set((await outbox(email)).map((m) => m.id));
  const since = Date.now() - 1000;
  await page.getByRole('button', { name: /изпрати код|send code/i }).click();
  const code = await readOtp(email, since, seen);
  await page.getByLabel(/код|code/i).fill(code);
  await page.getByRole('button', { name: /^(влез|sign in)$/i }).click();
  await page.waitForLoadState('networkidle');
}

// ── the basemap, range by range from the public archive ──────────────────────

async function proxyTiles(context) {
  await context.route('**/tiles/bulgaria.pmtiles', async (route) => {
    const range = route.request().headers().range;
    // A dropped range leaves the map blank for good, so each is retried.
    for (let attempt = 1; ; attempt += 1) {
      try {
        const res = await fetch(TILES, { headers: range ? { range } : {} });
        const body = Buffer.from(await res.arrayBuffer());
        const headers = { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes' };
        const contentRange = res.headers.get('content-range');
        if (contentRange) headers['content-range'] = contentRange;
        await route.fulfill({ status: res.status, headers, body });
        return;
      } catch (error) {
        if (attempt === 4) return route.abort().catch(() => {});
        await new Promise((r) => setTimeout(r, 400 * attempt));
        void error;
      }
    }
  });
}

async function phone(browser, locale, geolocation = SPOT, storageState) {
  const context = await browser.newContext({
    viewport: PHONE,
    deviceScaleFactor: SCALE,
    locale: LOCALES[locale].browserLocale,
    isMobile: true,
    hasTouch: true,
    geolocation,
    permissions: ['geolocation', 'camera'],
    ...(storageState ? { storageState } : {}),
  });
  await proxyTiles(context);
  return context;
}

// ── capturing ────────────────────────────────────────────────────────────────

// The dev overlay and the site footer stay out of the picture; the bottom bar
// is captured once as its own strip (the player lays it over every screen),
// so a tall page can scroll under it the way it does on a phone.
const SHOT_CSS = `nextjs-portal, #__next-build-watcher, body > footer, footer.border-t { display: none !important; }
.sk-shot-hidden { visibility: hidden !important; }`;
// The address a visitor knows. Screens that print the site's own links (the
// passport's share text) print the dev server's origin; the picture shows
// this one in its place.
const PUBLIC_ORIGIN = (process.env.SHOTS_PUBLIC_ORIGIN ?? 'https://pops.bg').replace(/\/+$/, '');

async function prepare(page) {
  await page.addStyleTag({ content: SHOT_CSS });
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
  await page.waitForTimeout(700);
}

/**
 * The phone's bottom bar is the primary nav standing in the lower half of the
 * screen — the desktop rail carries the same links but is hidden on a phone.
 * Marked once per page so the capture helpers can find it.
 */
async function markBar(page) {
  await page.evaluate(() => {
    for (const nav of document.querySelectorAll('nav[aria-label]')) {
      if (!nav.querySelector('a[href$="/karta"]')) continue;
      const rect = nav.getBoundingClientRect();
      if (rect.height > 0 && rect.top > window.innerHeight / 2) {
        nav.setAttribute('data-shot-bar', '');
        let el = nav;
        while (el && getComputedStyle(el).position !== 'fixed') el = el.parentElement;
        (el ?? nav).setAttribute('data-shot-bar-box', '');
        return;
      }
    }
  });
}

/** The bottom bar's fixed container, toggled out of a capture. */
async function barVisible(page, visible) {
  await markBar(page);
  await page.evaluate((show) => {
    document.querySelector('[data-shot-bar-box]')?.classList.toggle('sk-shot-hidden', !show);
  }, visible);
}

/** The bar as a strip — from just above the «+», which stands proud of it. */
async function captureBar(page) {
  await barVisible(page, true);
  const top = await page.evaluate(() => {
    const nav = document.querySelector('[data-shot-bar]');
    return nav ? Math.floor(nav.getBoundingClientRect().top) - 30 : null;
  });
  if (top === null) throw new Error('no bottom bar on this page');
  // Only the bar, on a transparent ground: the «+» stands proud of it, and
  // whatever page lay behind that corner must not ride along over the others.
  const only = await page.addStyleTag({
    content: `html, body { background: transparent !important; }
      body { visibility: hidden !important; }
      [data-shot-bar-box] { visibility: visible !important; }`,
  });
  const png = await page.screenshot({
    clip: { x: 0, y: top, width: PHONE.width, height: PHONE.height - top },
    omitBackground: true,
  });
  await only.evaluate((el) => el.remove());
  return { png, top };
}

/** A box in page coordinates (what a tall capture is measured in). */
async function box(page, locator) {
  await locator.first().waitFor({ state: 'visible', timeout: 15_000 });
  const b = await locator.first().boundingBox();
  const scrollY = await page.evaluate(() => window.scrollY);
  return {
    x: Math.round(b.x),
    y: Math.round(b.y + scrollY),
    w: Math.round(b.width),
    h: Math.round(b.height),
  };
}

/**
 * One screen. `height` keeps that much of the page from its top (a tall page
 * scrolls in the player); without it the picture is the viewport at the
 * current scroll position, and `top` says where that is so boxes line up.
 */
async function capture(page, { height, keepBar = false } = {}) {
  await prepare(page);
  if (!keepBar) await barVisible(page, false);
  let png;
  let top = 0;
  if (height) {
    const full = await page.evaluate(() => document.documentElement.scrollHeight);
    png = await page.screenshot({
      fullPage: true,
      clip: { x: 0, y: 0, width: PHONE.width, height: Math.min(height, full) },
    });
  } else {
    top = await page.evaluate(() => Math.round(window.scrollY));
    png = await page.screenshot();
  }
  await barVisible(page, true);
  return { png, top };
}

const written = [];
async function save(name, png) {
  const file = `${name}.webp`;
  const info = await sharp(png).webp({ quality: 72, effort: 6 }).toFile(path.join(OUT_DIR, file));
  written.push({ file, size: info.size });
  return {
    src: `/guide/${file}`,
    w: Math.round(info.width / SCALE),
    h: Math.round(info.height / SCALE),
  };
}

/** Collects one recording's steps for one language. */
class Recording {
  constructor(key, locale) {
    this.key = key;
    this.locale = locale;
    this.steps = [];
    this.bar = null;
  }

  async step(shot, actions = [], { bar = true } = {}) {
    const n = this.steps.length + 1;
    const image = await save(`${this.key}-${this.locale}-${n}`, shot.png);
    // Boxes were measured in page coordinates; a viewport picture starts at
    // its scroll offset.
    const shift = (a) => (a.on === 'bar' || !('y' in a) ? a : { ...a, y: a.y - shot.top });
    this.steps.push({ ...image, bar, actions: actions.map(shift) });
  }

  async useBar(page) {
    const { png, top } = await captureBar(page);
    this.bar = { ...(await save(`${this.key}-${this.locale}-bar`, png)), top };
  }
}

const tap = (b, on = 'screen') => ({ type: 'tap', on, ...b });
const mark = (b) => ({ type: 'mark', ...b });
const scroll = (to) => ({ type: 'scroll', to: Math.max(0, Math.round(to)) });

/** A box measured on the bar strip rather than the page. */
async function barBox(page, locator, recording) {
  const b = await locator.first().boundingBox();
  return {
    x: Math.round(b.x),
    y: Math.round(b.y - recording.bar.top),
    w: Math.round(b.width),
    h: Math.round(b.height),
  };
}

async function scrollTo(page, y) {
  await page.evaluate((top) => window.scrollTo(0, Math.max(0, top)), y);
  await page.waitForTimeout(300);
}

/** Brings an answer (a thanks line, a status) to the upper middle of the screen. */
async function centre(page, locator) {
  await locator.first().waitFor({ state: 'visible', timeout: 15_000 });
  await scrollTo(page, (await box(page, locator)).y - 300);
  return box(page, locator);
}

/** The map's list has loaded for the area on screen — the basemap with it. */
async function listReady(page, m) {
  await page.locator('li button[data-slug]:visible').first().waitFor({ timeout: 30_000 });
  // The status line reads «Зареждане на съоръженията…» until the places for
  // the area on screen arrive (it carries more than the message, so not exact).
  await page
    .getByText(m.Map.resultsLoading.replace(/…$/, ''))
    .first()
    .waitFor({ state: 'hidden', timeout: 60_000 });
  await page.waitForTimeout(2500);
}

// ── the five flows ───────────────────────────────────────────────────────────

async function find(browser, locale) {
  const { prefix } = LOCALES[locale];
  const m = messages[locale];
  const rec = new Recording('find', locale);
  const context = await phone(browser, locale);
  const page = await context.newPage();

  await page.goto(`${BASE}${prefix}/`, { waitUntil: 'networkidle' });
  await prepare(page);
  await rec.useBar(page);
  const nearMe = page.getByRole('link', { name: exact(m.Home.hero.nearMe) });
  await rec.step(await capture(page), [tap(await box(page, nearMe))]);

  await nearMe.first().click();
  await page.waitForURL(/\/karta/);
  const chip = page.getByRole('button', { name: exact(m.Sport.basketball) });
  await listReady(page, m);
  await rec.step(await capture(page), [tap(await box(page, chip))]);

  await chip.first().click();
  await page.waitForTimeout(800);
  await listReady(page, m);
  const first = page.locator('li button[data-slug]:visible').first();
  await rec.step(await capture(page), [tap(await box(page, first))]);

  await first.click();
  await page.waitForTimeout(2000);
  const details = page.getByRole('link', { name: exact(m.Map.viewDetails) });
  await rec.step(await capture(page), [tap(await box(page, details))]);

  await details.first().click();
  await page.waitForURL(/\/obekt\//);
  await page.waitForLoadState('networkidle');
  await scrollTo(page, 0);
  // The name with what is there (sports, access, surface, light), the way
  // there, and the block that asks the reader to help.
  const title = await box(page, page.locator('main h1'));
  const directions = await box(page, page.getByRole('link', { name: /google maps/i }));
  const help = await box(page, page.getByRole('heading', { name: exact(m.Contribute.title) }));
  await rec.step(await capture(page, { height: help.y + 520 }), [
    mark({ x: 12, y: title.y - 8, w: 366, h: directions.y - title.y - 8 }),
    scroll(directions.y - 420),
    mark({ x: 12, y: directions.y - 8, w: 366, h: directions.h + 16 }),
    scroll(help.y - 160),
    mark({ x: 12, y: help.y - 12, w: 366, h: 140 }),
  ]);

  await context.close();
  return rec;
}

async function member(browser, locale) {
  const { prefix, name } = LOCALES[locale];
  const context = await phone(browser, locale);
  const page = await context.newPage();
  await signIn(page, `guide-${locale}-${RUN}@example.org`, prefix);
  // The first-run name step (dobre-doshli), answered the way a member would.
  await page.waitForURL(/dobre-doshli/, { timeout: 30_000 }).catch(async (error) => {
    await page.screenshot({ path: path.join(os.tmpdir(), `guide-signin-${locale}.png`) });
    throw new Error(`no welcome step after signing in (at ${page.url()})`, { cause: error });
  });
  await page.getByLabel(exact(messages[locale].Welcome.nameLabel)).fill(name);
  await page.getByRole('button', { name: exact(messages[locale].Welcome.submit) }).click();
  await page.waitForURL((url) => !url.pathname.includes('dobre-doshli'));
  return { context, page };
}

/** A plain picture for the photo field: court lines on asphalt, nobody in it. */
async function courtPhoto() {
  const file = path.join(os.tmpdir(), `guide-court-${RUN}.jpg`);
  const line = 'fill="none" stroke="#eef0f0" stroke-width="10"';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900">
    <rect width="1200" height="900" fill="#6d7377"/>
    <rect x="80" y="80" width="1040" height="740" ${line}/>
    <line x1="600" y1="80" x2="600" y2="820" ${line}/>
    <circle cx="600" cy="450" r="110" ${line}/>
    <rect x="80" y="330" width="220" height="240" ${line}/>
    <rect x="900" y="330" width="220" height="240" ${line}/>
  </svg>`;
  await sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toFile(file);
  return file;
}

async function add(page, locale) {
  const { prefix } = LOCALES[locale];
  const m = messages[locale];
  const rec = new Recording('add', locale);
  await page.context().setGeolocation(LOCALES[locale].add);

  await page.goto(`${BASE}${prefix}/`, { waitUntil: 'networkidle' });
  await prepare(page);
  await rec.useBar(page);
  const plus = page.getByRole('button', { name: exact(m.Nav.quick.title) }).first();
  await rec.step(await capture(page), [tap(await barBox(page, plus, rec), 'bar')]);

  await plus.click();
  const addItem = page.getByRole('link', { name: opening(m.Nav.quick.addFacility.title) });
  await addItem.first().waitFor();
  await page.waitForTimeout(600);
  await rec.step(await capture(page, { keepBar: true }), [tap(await box(page, addItem))], {
    bar: false,
  });

  await addItem.first().click();
  await page.waitForURL(/\/dobavi/);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2500);
  const locate = page.getByRole('button', { name: exact(m.AddFacility.useMyLocation) });
  await rec.step(await capture(page), [tap(await box(page, locate))]);

  await locate.click();
  await page.waitForTimeout(3500);
  await page
    .locator('input[type="file"]')
    .first()
    .setInputFiles(await courtPhoto());
  const sport = page.getByText(exact(m.Sport.calisthenics)).first();
  await sport.click();
  const submit = page.getByRole('button', { name: exact(m.AddFacility.submit) });
  const submitBox = await box(page, submit);
  const mapBox = await box(page, page.locator('.maplibregl-map'));
  const sportBox = await box(page, sport);
  await rec.step(await capture(page, { height: submitBox.y + submitBox.h + 140 }), [
    mark(mapBox),
    scroll(sportBox.y - 300),
    tap(sportBox),
    scroll(submitBox.y - 560),
    tap(submitBox),
  ]);

  await submit.click();
  // A place the public map shows is thanked on its own new page.
  await page.waitForURL(/\/obekt\//, { timeout: 30_000 });
  await page.waitForLoadState('networkidle');
  const thanks = page
    .getByRole('status')
    .filter({ hasText: opening(m.Contribute.thanksWithPoints) });
  const thanksBox = await centre(page, thanks);
  await rec.step(await capture(page), [mark(thanksBox)]);
  return rec;
}

async function verify(page, locale) {
  const { prefix } = LOCALES[locale];
  const m = messages[locale];
  const rec = new Recording('verify', locale);
  await page.context().setGeolocation(PLACES.verify.at);

  await page.goto(`${BASE}${prefix}/obekt/${PLACES.verify.slug}`, { waitUntil: 'networkidle' });
  await prepare(page);
  await rec.useBar(page);
  // The radio is visually hidden behind its label, which is what a finger hits.
  const yes = page.locator('label').filter({ hasText: exact(m.Contribute.existsYes) });
  const confirm = page.getByRole('button', { name: exact(m.Contribute.verifySubmit) });
  const heading = await box(page, page.getByRole('heading', { name: exact(m.Contribute.title) }));
  const confirmBox = await box(page, confirm);
  await rec.step(await capture(page, { height: confirmBox.y + confirmBox.h + 160 }), [
    scroll(heading.y - 100),
    tap(await box(page, yes)),
    scroll(confirmBox.y - 560),
    tap(confirmBox),
  ]);

  await yes.first().click();
  await confirm.first().click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);
  const thanks = page.getByText(opening(m.Contribute.thanksWithPoints));
  const thanksBox = await centre(page, thanks);
  await rec.step(await capture(page), [mark(thanksBox)]);

  // The condition of a second place, a few steps away.
  await page.context().setGeolocation(PLACES.condition.at);
  await page.goto(`${BASE}${prefix}/obekt/${PLACES.condition.slug}`, { waitUntil: 'networkidle' });
  await prepare(page);
  const conditionHeading = await box(
    page,
    page.getByRole('heading', { name: exact(m.Contribute.conditionHeading) }),
  );
  await scrollTo(page, conditionHeading.y - 120);
  // The inputs are visually hidden behind their labels, as a finger finds them.
  const state = page.locator('label:has(input[type="radio"][name="state"])').nth(1);
  const tag = page.locator('label:has(input[type="checkbox"][name="tags"])').first();
  const stateBox = await box(page, state);
  const tagBox = await box(page, tag);
  await state.click();
  await tag.click();
  const send = page.getByRole('button', { name: exact(m.Contribute.conditionSubmit) });
  const sendBox = await box(page, send);
  const shot = await capture(page, { height: sendBox.y + sendBox.h + 160 });
  await rec.step(shot, [
    scroll(conditionHeading.y - 120),
    tap(stateBox),
    tap(tagBox),
    scroll(sendBox.y - 560),
    tap(sendBox),
  ]);

  await send.first().click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);
  const thanks2 = page.getByText(opening(m.Contribute.thanksWithPoints));
  const thanks2Box = await centre(page, thanks2);
  await rec.step(await capture(page), [mark(thanks2Box)]);
  return rec;
}

/**
 * The organiser's QR screen, turned into a camera feed: the screen held up in
 * front of the phone, as somebody would at the court. ffmpeg writes the Y4M
 * file Chromium plays as its fake camera.
 */
async function cameraFeed(qrPng) {
  const dir = path.join(os.tmpdir(), `guide-camera-${RUN}`);
  await mkdir(dir, { recursive: true });
  const screen = await sharp(qrPng).resize({ width: 300 }).toBuffer();
  const meta = await sharp(screen).metadata();
  const framed = await sharp({
    create: {
      width: meta.width + 24,
      height: meta.height + 24,
      channels: 3,
      background: '#ffffff',
    },
  })
    .composite([{ input: screen, left: 12, top: 12 }])
    .png()
    .toBuffer();
  const tilted = await sharp(framed).rotate(-5, { background: '#2b2f2c' }).png().toBuffer();
  const scene = path.join(dir, 'scene.png');
  await sharp({ create: { width: 640, height: 480, channels: 3, background: '#2b2f2c' } })
    .composite([
      { input: await sharp(tilted).resize({ height: 440 }).toBuffer(), gravity: 'center' },
    ])
    .png()
    .toFile(scene);
  const feed = path.join(dir, 'feed.y4m');
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-loop',
    '1',
    '-i',
    scene,
    '-t',
    '6',
    '-r',
    '15',
    '-pix_fmt',
    'yuv420p',
    feed,
  ]);
  return feed;
}

async function play(page, locale, organiser) {
  const { prefix } = LOCALES[locale];
  const m = messages[locale];
  const rec = new Recording('play', locale);
  await page.context().setGeolocation(PLACES.checkin.at);

  await page.goto(`${BASE}${prefix}/sesii`, { waitUntil: 'networkidle' });
  await prepare(page);
  await rec.useBar(page);
  const card = page.getByRole('link', { name: /Баскетбол 3×3/ });
  await rec.step(await capture(page), [tap(await box(page, card))]);

  await card.first().click();
  await page.waitForURL(/\/sesiya\//);
  await page.waitForLoadState('networkidle');
  const occurrence = /\/sesiya\/([0-9a-f-]{36})/.exec(page.url())[1];
  const join = page.getByRole('button', { name: exact(m.Session.join) }).first();
  await rec.step(await capture(page), [tap(await box(page, join))]);

  await join.click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1200);
  const going = page.getByRole('status');
  await rec.step(await capture(page), (await going.count()) ? [mark(await box(page, going))] : []);

  // The organiser's screen at the court.
  await organiser.goto(`${BASE}${prefix}/sesiya/${occurrence}/qr`, { waitUntil: 'networkidle' });
  await prepare(organiser);
  const area = await organiser.evaluate(() => {
    const h1 = document.querySelector('h1');
    const svg = document.querySelector('main svg');
    if (!h1 || !svg) return null;
    const a = h1.getBoundingClientRect();
    const b = svg.getBoundingClientRect();
    return { y: Math.max(0, Math.floor(a.top) - 12), h: Math.ceil(b.bottom - a.top) + 24 };
  });
  if (!area) throw new Error('the organiser’s QR screen did not render a code');
  const feed = await cameraFeed(
    await organiser.screenshot({ clip: { x: 0, y: area.y, width: PHONE.width, height: area.h } }),
  );

  // The member's own camera pointed at it: a browser whose fake camera plays
  // the organiser's screen, carrying the member's session.
  const state = await page.context().storageState();
  const camera = await chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${feed}`,
    ],
  });
  try {
    const context = await phone(camera, locale, PLACES.checkin.at, state);
    const scanner = await context.newPage();
    // The decoder is held back until the camera view is in the picture: the
    // scanner reads a code the moment it sees one and closes the camera. The
    // browser's own BarcodeDetector is taken away so it falls back to jsQR,
    // whose chunk is the thing held.
    await scanner.addInitScript(() => {
      Object.defineProperty(window, 'BarcodeDetector', { value: undefined });
    });
    let held;
    await scanner.route(
      (url) => /jsqr/i.test(url.href),
      (route) => {
        if (held) return route.continue();
        held = route;
      },
    );
    // A member with a тренировка on now finds the check-in card on their home.
    await scanner.goto(`${BASE}${prefix}/`, { waitUntil: 'networkidle' });
    await prepare(scanner);
    const scanCard = scanner.getByRole('link', { name: exact(m.Home.personal.checkinCta) });
    await rec.step(await capture(scanner), [tap(await box(scanner, scanCard))]);
    await scanCard.first().click();
    await scanner.waitForURL(/\/skenirai/);
    const deadline = Date.now() + 20_000;
    while (!held && Date.now() < deadline) await scanner.waitForTimeout(200);
    if (!held) throw new Error('the scanner never asked for its decoder');
    await scanner.waitForTimeout(1500);
    await rec.step(await capture(scanner), [mark(await box(scanner, scanner.locator('video')))]);
    await held.continue();
    await scanner.waitForURL(/\/otmetka\//, { timeout: 30_000 });
    await scanner.waitForLoadState('networkidle');
    const submit = scanner.getByRole('button', { name: exact(m.Checkin.submit) });
    await rec.step(await capture(scanner), [tap(await box(scanner, submit))]);
    await submit.first().click();
    await scanner.waitForLoadState('networkidle');
    await scanner.waitForTimeout(2500);
    const done = scanner.getByRole('status');
    await rec.step(
      await capture(scanner),
      (await done.count()) ? [mark(await box(scanner, done))] : [],
    );
  } finally {
    await camera.close();
  }
  return rec;
}

async function passport(page, locale) {
  const { prefix } = LOCALES[locale];
  const m = messages[locale];
  const rec = new Recording('passport', locale);

  await page.goto(`${BASE}${prefix}/pasport`, { waitUntil: 'networkidle' });
  await prepare(page);
  await rec.useBar(page);
  const heading = (text) => page.getByRole('heading', { name: exact(text) });

  // The totals the four steps above paid for.
  const totals = await box(page, heading(m.Passport.totalsTitle));
  await rec.step(await capture(page), [mark({ x: 12, y: totals.y - 8, w: 366, h: 250 })]);

  // Down past the streaks to the badges: the two just earned glow.
  const badges = await box(page, heading(m.Passport.badgesTitle));
  const streaks = await box(page, heading(m.Passport.streaksTitle));
  await rec.step(await capture(page, { height: badges.y + 760 }), [
    scroll(streaks.y - 140),
    scroll(badges.y - 120),
    mark({ x: 12, y: badges.y + 30, w: 366, h: 210 }),
  ]);

  // The one decision the passport asks for.
  const publish = page.getByRole('button', { name: exact(m.Passport.makePublic) });
  await centre(page, publish);
  await rec.step(await capture(page), [tap(await box(page, publish))]);

  await publish.first().click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);
  await prepare(page);
  const panel = heading(m.Passport.visibilityTitle);
  const panelBox = await centre(page, panel);
  await rec.step(await capture(page), [mark({ x: 12, y: panelBox.y - 12, w: 366, h: 230 })]);
  return rec;
}

// ── run ──────────────────────────────────────────────────────────────────────

execFileSync('../../db/node_modules/.bin/tsx', ['scripts/marketing-shots/guide-fixtures.mts'], {
  stdio: 'inherit',
});
await mkdir(OUT_DIR, { recursive: true });

// A cold dev server compiles the map's data route on its first request; ask
// once before the camera is pointed at the map.
await fetch(`${BASE}/api/facilities?bbox=23.3,42.66,23.33,42.68`).catch(() => {});

const browser = await chromium.launch();
const manifest = JSON.parse(await readFile(MANIFEST, 'utf8').catch(() => '{}'));
try {
  const organiserContext = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 1 });
  const organiser = await organiserContext.newPage();
  await signIn(organiser, ORGANISER, '');

  // SHOTS_LOCALES=en re-records one language; the manifest keeps the other's.
  const only = process.env.SHOTS_LOCALES?.split(',');
  for (const locale of Object.keys(LOCALES)) {
    if (only && !only.includes(locale)) continue;
    const recordings = [await find(browser, locale)];
    const { context, page } = await member(browser, locale);
    recordings.push(await add(page, locale));
    recordings.push(await verify(page, locale));
    recordings.push(await play(page, locale, organiser));
    recordings.push(await passport(page, locale));
    await context.close();
    for (const rec of recordings) {
      manifest[rec.key] ??= {};
      manifest[rec.key][locale] = { bar: rec.bar, steps: rec.steps };
      console.log(`rec   ${rec.key.padEnd(9)} ${locale} ${rec.steps.length} steps`);
    }
  }
} finally {
  await browser.close();
}

await writeFile(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
const total = written.reduce((sum, w) => sum + w.size, 0);
console.log(
  `${written.length} pictures, ${Math.round(total / 1024)} KB → ${OUT_DIR}; manifest ${MANIFEST}`,
);

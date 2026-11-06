// Failure modes recorded before implementation:
// - Size whitelists ignore 256/512/multi-size declarations; declarations can lie.
// - Social previews, startup images, mask-only icons, and maskable icons can crop badly.
// - Article fetches fail, redirect, or omit icons that the homepage declares.
// - SVGs and multi-frame ICOs need conversion; corrupt/blank/HTML images must be skipped.
// - Search-provider 404 bodies are generic icons, not successful fallbacks.
// - A small direct icon should be upgraded, but a new site's good direct icon must survive.
// - Relative HTML/base/manifest paths must resolve against the final resource URL.
// - Requests may hang, exceed limits, target private networks, or duplicate work.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { createThumbnailService } = require('../src/thumbnail');
const { publicUrl, publicLookup } = require('../src/resource');

const origin = 'https://example.com';
const story = `${origin}/news/story`;
const svg = (color = 'red') => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><circle cx="128" cy="128" r="100" fill="${color}"/></svg>`);
const png = (size, color = 'red') => sharp(svg(color)).resize(size, size).png().toBuffer();
const response = (body, url, status = 200) => ({ body: Buffer.from(body), url, status });
const request = (url = story) => ({ query: new URLSearchParams({ url }) });
function fixture(resources, options = {}) {
  const calls = [];
  const fetchResource = async (url, { signal } = {}) => {
    calls.push(url);
    if (signal?.aborted) throw signal.reason;
    const value = resources[url];
    if (typeof value === 'function') return value(signal);
    if (!value) throw new Error(`Missing fixture: ${url}`);
    return response(value.body ?? value, value.url ?? url, value.status ?? 200);
  };
  return { handler: createThumbnailService({ fetchResource, ...options }), calls };
}
async function pixel(result) {
  assert.equal(result.status, 200);
  assert.equal(result.headers['Content-Type'], 'image/png');
  const { data } = await sharp(result.body).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return [...data.subarray((96 * 192 + 96) * 4, (96 * 192 + 96) * 4 + 4)];
}

test('chooses actual resolution over the old size list and incorrect size declarations', async () => {
  const f = fixture({
    [story]: '<link rel="icon" href="/small.png" sizes="192x192"><link rel="icon" href="/large.png" sizes="256x256 512x512">',
    [`${origin}/small.png`]: await png(16, 'red'),
    [`${origin}/large.png`]: await png(512, 'blue'),
  });
  assert.deepEqual(await pixel(await f.handler(request())), [0, 0, 255, 255]);
  assert.ok(f.calls.every(url => !url.includes('google') && !url.includes('duckduckgo')));
});

test('returns SVG as a 192px PNG and ignores social/startup/mask previews', async () => {
  const f = fixture({
    [story]: '<meta property="og:image" content="/preview.jpg"><link rel="apple-touch-startup-image" href="/splash.png"><link rel="mask-icon" href="/mask.svg"><link rel="alternate ICON" href="/brand.svg" sizes="any">',
    [`${origin}/brand.svg`]: svg('blue'),
  });
  assert.deepEqual(await pixel(await f.handler(request())), [0, 0, 255, 255]);
  assert.deepEqual((await sharp((await f.handler(request())).body).metadata()).width, 192);
  assert.ok(!f.calls.some(url => /preview|splash|mask/.test(url)));
});

test('renders small SVGs at output resolution without blurring vector detail', async () => {
  const f = fixture({
    [story]: '<link rel="icon" href="/tiny.svg">',
    [`${origin}/tiny.svg`]: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path fill="red" d="M0 0h8v16H0z"/><path fill="blue" d="M8 0h8v16H8z"/></svg>',
  });
  const result = await f.handler(request());
  const data = await sharp(result.body).ensureAlpha().raw().toBuffer();
  assert.deepEqual([...data.subarray((96 * 192 + 95) * 4, (96 * 192 + 95) * 4 + 4)], [255, 0, 0, 255]);
  assert.deepEqual(await pixel(result), [0, 0, 255, 255]);
});

test('resolves base and manifest paths using final URLs and prefers general-purpose icons', async () => {
  const f = fixture({
    [story]: { url: 'https://www.example.com/article', body: '<base href="/assets/"><link rel="manifest" href="app.webmanifest">' },
    'https://www.example.com/assets/app.webmanifest': { url: 'https://cdn.example.com/app/manifest.json', body: JSON.stringify({ icons: [
      { src: 'mask.png', sizes: '512x512', purpose: 'maskable' },
      { src: 'any.png', sizes: '256x256', purpose: 'any' },
      { src: 'mono.png', sizes: '512x512', purpose: 'monochrome' },
    ] }) },
    'https://cdn.example.com/app/mask.png': await png(512, 'red'),
    'https://cdn.example.com/app/any.png': await png(256, 'blue'),
  });
  assert.deepEqual(await pixel(await f.handler(request())), [0, 0, 255, 255]);
});

test('tries the homepage when an article is blocked and skips broken/HTML/blank icons', async () => {
  const f = fixture({
    [story]: { status: 403, body: 'blocked' },
    [`${origin}/`]: '<link rel="icon" href="/broken.png"><link rel="icon" href="/html.png"><link rel="icon" href="/blank.png"><link rel="apple-touch-icon" href="/valid.png">',
    [`${origin}/html.png`]: '<html>not an image</html>',
    [`${origin}/blank.png`]: await sharp({ create: { width: 256, height: 256, channels: 4, background: '#0000' } }).png().toBuffer(),
    [`${origin}/valid.png`]: await png(180, 'blue'),
  });
  assert.deepEqual(await pixel(await f.handler(request())), [0, 0, 255, 255]);
});

test('upgrades a 16px direct icon using Google, ignoring DuckDuckGo generic 404 images', async () => {
  const google = 'https://www.google.com/s2/favicons?domain=example.com&sz=256';
  const ddg = 'https://icons.duckduckgo.com/ip3/example.com.ico';
  const f = fixture({
    [story]: '<link rel="icon" href="/small.png">',
    [`${origin}/small.png`]: await png(16, 'red'),
    [google]: await png(128, 'blue'),
    [ddg]: { status: 404, body: await png(256, 'red') },
  });
  assert.deepEqual(await pixel(await f.handler(request())), [0, 0, 255, 255]);
});

test('uses DuckDuckGo when direct discovery and Google fail', async () => {
  const f = fixture({
    'https://icons.duckduckgo.com/ip3/example.com.ico': await png(300, 'blue'),
  });
  assert.deepEqual(await pixel(await f.handler(request())), [0, 0, 255, 255]);
});

test('decodes the largest ICO frame, even when the first frame is small', async () => {
  const small = await png(16, 'red'), large = await png(256, 'blue');
  const header = Buffer.alloc(38);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(2, 4);
  for (const [i, size, bytes, offset] of [[0, 16, small, 38], [1, 0, large, 38 + small.length]]) {
    const entry = 6 + i * 16;
    header[entry] = size; header[entry + 1] = size;
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(bytes.length, entry + 8); header.writeUInt32LE(offset, entry + 12);
  }
  const f = fixture({ [`${origin}/favicon.ico`]: Buffer.concat([header, small, large]) });
  assert.deepEqual(await pixel(await f.handler(request())), [0, 0, 255, 255]);
});

test('skips a corrupt largest ICO frame and keeps the smaller valid frame', async () => {
  const small = await png(32, 'blue');
  const corrupt = (await png(256, 'red')).subarray(0, 33);
  const header = Buffer.alloc(38);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(2, 4);
  for (const [i, size, bytes, offset] of [[0, 32, small, 38], [1, 0, corrupt, 38 + small.length]]) {
    const entry = 6 + i * 16;
    header[entry] = size; header[entry + 1] = size;
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(bytes.length, entry + 8); header.writeUInt32LE(offset, entry + 12);
  }
  const f = fixture({ [`${origin}/favicon.ico`]: Buffer.concat([header, small, corrupt]) });
  assert.deepEqual(await pixel(await f.handler(request())), [0, 0, 255, 255]);
});

test('rejects non-icon aspect ratios and returns uncached 404 rather than generic images', async () => {
  const f = fixture({
    [story]: '<link rel="icon" href="/wide.png">',
    [`${origin}/wide.png`]: await sharp(svg()).resize(512, 100).png().toBuffer(),
  });
  const r = await f.handler(request());
  assert.equal(r.status, 404);
  assert.equal(r.headers['Cache-Control'], 'no-store');
});

test('bounds slow upstreams and deduplicates concurrent/cache requests', async () => {
  const f = fixture({ [`${origin}/favicon.ico`]: await png(256, 'blue') });
  const [a, b] = await Promise.all([f.handler(request()), f.handler(request())]);
  assert.equal(a.status, 200); assert.deepEqual(a.body, b.body);
  const count = f.calls.length;
  await f.handler(request());
  assert.equal(f.calls.length, count);
  const hanging = fixture({ [story]: signal => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) }, { timeoutMs: 30 });
  const before = Date.now();
  assert.equal((await hanging.handler(request())).status, 404);
  assert.ok(Date.now() - before < 500);
});

test('reserves time for a cached-provider fallback when the origin hangs', async () => {
  const f = fixture({
    [story]: signal => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
    'https://icons.duckduckgo.com/ip3/example.com.ico': await png(300, 'blue'),
  }, { timeoutMs: 100 });
  assert.deepEqual(await pixel(await f.handler(request())), [0, 0, 255, 255]);
});

test('validates input and rejects local/private targets including DNS answers', async () => {
  const f = fixture({});
  for (const url of ['file:///etc/passwd', 'http://localhost/', 'http://127.1/', 'http://10.0.0.1/', 'http://[::1]/', 'https://user:password@example.com/']) {
    assert.equal((await f.handler(request(url))).status, 400, url);
  }
  assert.equal((await f.handler({ query: new URLSearchParams() })).status, 400);
  assert.throws(() => publicUrl('http://169.254.169.254/latest/meta-data'));
  const lookup = publicLookup(async () => [{ address: '192.168.1.2', family: 4 }]);
  await assert.rejects(new Promise((resolve, reject) => lookup('example.com', {}, (error, ...args) => error ? reject(error) : resolve(args))));
});

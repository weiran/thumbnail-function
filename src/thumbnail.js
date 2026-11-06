const cheerio = require('cheerio');
const sharp = require('sharp');
const { fetchResource: defaultFetch, publicUrl } = require('./resource');

const SIZE = 192; // 55pt feed thumbnails at 3x, with a little room to spare.
const INPUT_OPTIONS = { limitInputPixels: 16 * 1024 * 1024, failOn: 'error' };
const missing = () => ({ status: 404, headers: { 'Cache-Control': 'no-store' } });

function resolveUrl(value, base) {
  try { return publicUrl(value, base).href; } catch { return undefined; }
}

function declaredSize(sizes = '') {
  if (typeof sizes !== 'string') return 0;
  return Math.max(0, ...sizes.toLowerCase().split(/\s+/).map(size => {
    const match = /^(\d+)x(\d+)$/.exec(size);
    return match && match[1] === match[2] ? Number(match[1]) : 0;
  }));
}

function discover(html, url) {
  const $ = cheerio.load(html);
  const base = resolveUrl($('base[href]').first().attr('href') || url, url) || url;
  const icons = [], manifests = [];
  $('link[href]').each((_, el) => {
    const rel = ($(el).attr('rel') || '').toLowerCase().split(/\s+/);
    const src = resolveUrl($(el).attr('href'), base);
    if (!src) return;
    if (rel.includes('manifest')) manifests.push(src);
    if (rel.some(token => ['icon', 'apple-touch-icon', 'apple-touch-icon-precomposed', 'fluid-icon'].includes(token))) {
      icons.push({ url: src, size: declaredSize($(el).attr('sizes')) });
    }
  });
  return { icons, manifests: manifests.slice(0, 2) };
}

async function icoImage(body) {
  const count = body.readUInt16LE(4);
  if (!count || count > 64 || body.length < 6 + count * 16) throw new Error('Invalid ICO');
  const frames = [];
  for (let index = 0; index < count; index++) {
    const entry = body.subarray(6 + index * 16, 22 + index * 16);
    const length = entry.readUInt32LE(8), offset = entry.readUInt32LE(12);
    if (offset < 6 + count * 16 || offset + length > body.length) continue;
    const data = body.subarray(offset, offset + length);
    if (data.length < 24) continue;
    const png = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const width = png ? data.readUInt32BE(16) : data.readInt32LE(4);
    const height = png ? data.readUInt32BE(20) : data.readInt32LE(8) / 2;
    if (width < 8 || height < 8 || width > 256 || height > 256) continue;
    frames.push({ entry, data, size: Math.min(width, height) });
  }
  frames.sort((a, b) => b.size - a.size);
  for (const frame of frames) {
    try {
      if (frame.data[0] === 137) return await sharp(frame.data, INPUT_OPTIONS).png().toBuffer();
      const header = Buffer.alloc(22);
      header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
      frame.entry.copy(header, 6); header.writeUInt32LE(22, 18);
      const { decodeIco } = await import('icojs');
      const [decoded] = await decodeIco(Buffer.concat([header, frame.data]));
      return Buffer.from(decoded.buffer);
    } catch { /* A corrupt frame must not hide the next usable frame. */ }
  }
  throw new Error('No usable ICO frame');
}

async function decodeIcon(body) {
  if (body.length >= 6 && body.readUInt32LE(0) === 0x00010000) body = await icoImage(body);
  const metadata = await sharp(body, INPUT_OPTIONS).metadata();
  const { width, height } = metadata;
  if (!width || !height || Math.min(width, height) < 8 || width / height < 0.8 || width / height > 1.25) {
    throw new Error('Not a square site icon');
  }
  const png = await sharp(body, INPUT_OPTIONS).rotate().resize(SIZE, SIZE, {
    fit: 'contain', background: '#0000',
  }).png().toBuffer();
  const stats = await sharp(png).stats();
  if (stats.channels.every(channel => channel.max === channel.min) || stats.channels[3]?.max === 0) {
    throw new Error('Empty icon');
  }
  return { body: png, size: metadata.format === 'svg' ? SIZE : Math.min(width, height) };
}

function better(a, b) {
  // Once resolution is sufficient, keep a general-purpose icon ahead of a
  // maskable-only icon. Actual decoded dimensions always beat declared sizes.
  const score = icon => Math.min(icon.size, SIZE) * (icon.maskable ? 0.8 : 1);
  return !b || score(a) > score(b);
}

function createThumbnailService({ fetchResource = defaultFetch, timeoutMs = 10000 } = {}) {
  const cache = new Map(), pending = new Map();

  async function generate(url) {
    const controller = new AbortController();
    const deadline = Date.now() + timeoutMs;
    let phaseDeadline = Date.now() + timeoutMs * 0.7;
    const timer = setTimeout(() => controller.abort(new Error('Thumbnail deadline')), timeoutMs);
    const signal = controller.signal;
    const visited = new Set();
    let best;
    async function get(value, maxBytes) {
      const remaining = Math.floor(phaseDeadline - Date.now());
      if (remaining <= 0) return undefined;
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.min(3000, remaining))]);
      let onAbort;
      try {
        requestSignal.throwIfAborted();
        const resource = await Promise.race([
          fetchResource(value, { signal: requestSignal, maxBytes }),
          new Promise((_, reject) => {
            onAbort = () => reject(requestSignal.reason);
            requestSignal.addEventListener('abort', onAbort, { once: true });
          }),
        ]);
        return resource.status === 200 ? resource : undefined;
      } catch { return undefined; }
      finally { if (onAbort) requestSignal.removeEventListener('abort', onAbort); }
    }
    async function inspect(candidates) {
      const unique = candidates.filter(candidate => candidate.url && !visited.has(candidate.url) && visited.add(candidate.url));
      unique.sort((a, b) => (b.size || 0) - (a.size || 0));
      for (let i = 0; i < Math.min(unique.length, 12); i += 4) {
        if (signal.aborted) break;
        const batch = await Promise.all(unique.slice(i, i + 4).map(async candidate => {
          const resource = await get(candidate.url, 2 * 1024 * 1024);
          if (!resource) return undefined;
          try { return { ...candidate, ...await decodeIcon(resource.body) }; } catch { return undefined; }
        }));
        for (const icon of batch) if (icon && better(icon, best)) best = icon;
      }
    }
    async function page(value) {
      const resource = await get(value, 1024 * 1024);
      if (!resource) return;
      const { icons, manifests } = discover(resource.body.toString('utf8'), resource.url);
      const manifestIcons = await Promise.all(manifests.map(async manifestUrl => {
        const manifest = await get(manifestUrl, 128 * 1024);
        try {
          return JSON.parse(manifest.body.toString('utf8')).icons.slice(0, 20).flatMap(icon => {
            if (!icon || typeof icon.src !== 'string') return [];
            const purpose = (typeof icon.purpose === 'string' ? icon.purpose : 'any').split(/\s+/);
            if (!purpose.some(p => ['any', 'maskable'].includes(p))) return [];
            return [{ url: resolveUrl(icon.src, manifest.url), size: declaredSize(icon.sizes), maskable: !purpose.includes('any') }];
          });
        } catch { return []; }
      }));
      await inspect([...icons, ...manifestIcons.flat(), { url: resolveUrl('/favicon.ico', resource.url) }]);
    }
    try {
      await page(url.href);
      if ((!best || best.size < SIZE) && url.pathname !== '/') await page(`${url.origin}/`);
      if (!best || best.size < SIZE) await inspect([{ url: `${url.origin}/favicon.ico` }]);
      if (!best || best.size < SIZE) {
        phaseDeadline = deadline;
        // Send only the hostname to third parties, never the story path/query.
        const domain = encodeURIComponent(url.hostname);
        await inspect([
          { url: `https://www.google.com/s2/favicons?domain=${domain}&sz=256` },
          { url: `https://icons.duckduckgo.com/ip3/${domain}.ico` },
        ]);
      }
      return best ? {
        status: 200,
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' },
        body: best.body,
      } : missing();
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  return async request => {
    let url;
    try {
      const value = request.query.get('url');
      if (!value || value.length > 4096) throw new Error('Missing URL');
      url = publicUrl(value);
    } catch { return { status: 400, headers: { 'Cache-Control': 'no-store' } }; }
    const key = url.href;
    const cached = cache.get(key);
    if (cached?.expires > Date.now()) return cached.result;
    cache.delete(key);
    if (pending.has(key)) return pending.get(key);
    const work = generate(url).catch(() => missing()).then(result => {
      if (result.status === 200) {
        if (cache.size >= 256) cache.delete(cache.keys().next().value);
        cache.set(key, { result, expires: Date.now() + 3600000 });
      }
      return result;
    }).finally(() => pending.delete(key));
    pending.set(key, work);
    return work;
  };
}

module.exports = { createThumbnailService };

const http = require('node:http');
const https = require('node:https');
const { lookup } = require('node:dns/promises');
const { isIP } = require('node:net');
const zlib = require('node:zlib');
const ipaddr = require('ipaddr.js');

function isPublicAddress(address) {
  return ipaddr.process(address).range() === 'unicast';
}

function publicUrl(value, base) {
  const url = new URL(value, base);
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && !['80', '443'].includes(url.port)) ||
      hostname === 'localhost' || hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') || (!hostname.includes('.') && !isIP(hostname)) ||
      (isIP(hostname) && !isPublicAddress(hostname))) {
    throw new Error('Expected a public HTTP(S) URL');
  }
  url.hash = '';
  return url;
}

// Validate and pin the actual connection address, including after redirects.
// Checking DNS separately from fetch would permit DNS rebinding.
function publicLookup(resolve = lookup) {
  return (hostname, options, callback) => {
    resolve(hostname, { all: true, verbatim: true }).then(addresses => {
      if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
        throw new Error('Private network destination');
      }
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    }).catch(error => callback(error));
  };
}

async function fetchResource(value, { signal, maxBytes = 2 * 1024 * 1024 } = {}, redirects = 0) {
  const url = publicUrl(value);
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).get(url, {
      signal,
      lookup: publicLookup(),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; HackersThumbnails/2.0; +https://weiran.co/hackers)',
        Accept: '*/*',
        'Accept-Encoding': 'identity',
      },
    }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (!response.headers.location || redirects >= 4) return reject(new Error('Redirect limit'));
        try {
          resolve(fetchResource(publicUrl(response.headers.location, url).href, { signal, maxBytes }, redirects + 1));
        } catch (error) { reject(error); }
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error(`Upstream HTTP ${response.statusCode}`));
      }
      let stream = response;
      const decoder = { gzip: zlib.createGunzip, deflate: zlib.createInflate, br: zlib.createBrotliDecompress }[response.headers['content-encoding']];
      if (decoder) stream = response.pipe(decoder());
      const chunks = [];
      let bytes = 0;
      stream.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          const error = new Error('Resource too large');
          stream.destroy(error);
          request.destroy(error);
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', reject);
      stream.on('error', reject);
      stream.on('end', () => resolve({ status: 200, body: Buffer.concat(chunks), url: url.href }));
    });
    request.setTimeout(3000, () => request.destroy(new Error('Upstream timeout')));
    request.on('error', reject);
  });
}

module.exports = { fetchResource, publicUrl, publicLookup };

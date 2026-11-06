const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const https = require('node:https');
const zlib = require('node:zlib');
const { fetchResource, publicUrl, publicLookup } = require('../src/resource');

// Transport tests exercise redirects, DNS pinning and decompressed byte limits
// without connecting to private or third-party hosts.
function transport(responses) {
  const calls = [];
  mock.method(https, 'get', (url, options, callback) => {
    calls.push({ url: url.href, options });
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = error => request.emit('error', error);
    queueMicrotask(() => {
      const fixture = responses.shift();
      const response = Readable.from([fixture.body || Buffer.alloc(0)]);
      response.statusCode = fixture.status || 200;
      response.headers = fixture.headers || {};
      callback(response);
    });
    return request;
  });
  return calls;
}

test('checks redirect destinations and does not connect to a private redirect', async () => {
  const calls = transport([{ status: 302, headers: { location: 'https://127.0.0.1/secret' } }]);
  try {
    await assert.rejects(fetchResource('https://example.com/icon'));
    assert.equal(calls.length, 1);
  } finally { mock.restoreAll(); }
});

test('follows relative redirects and bounds decompressed response bytes', async () => {
  const calls = transport([
    { status: 302, headers: { location: '/image.png' } },
    { body: Buffer.from('image') },
    { headers: { 'content-encoding': 'gzip' }, body: zlib.gzipSync(Buffer.alloc(1024)) },
  ]);
  try {
    const result = await fetchResource('https://example.com/icon');
    assert.equal(result.url, 'https://example.com/image.png');
    assert.equal(result.body.toString(), 'image');
    assert.equal(typeof calls[0].options.lookup, 'function');
    await assert.rejects(fetchResource('https://example.com/large', { maxBytes: 100 }), /too large/);
  } finally { mock.restoreAll(); }
});

test('rejects private address spellings and mixed public/private DNS answers', async () => {
  for (const value of ['https://2130706433/', 'http://0x7f000001/', 'http://[::ffff:127.0.0.1]/', 'http://169.254.169.254/', 'http://[fe80::1]/']) {
    assert.throws(() => publicUrl(value), value);
  }
  const lookup = publicLookup(async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]);
  await assert.rejects(new Promise((resolve, reject) => lookup('example.com', { all: true }, error => error ? reject(error) : resolve())));
});

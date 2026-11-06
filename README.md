# Hackers thumbnails

`GET /api/FetchThumbnail?url=<encoded-public-url>&v=2` returns a validated
192 × 192 PNG site icon, or an uncached 404 when none is available. Invalid URLs
return 400. `v=2` lets app clients bypass permanent redirects cached from the old
implementation; the service accepts requests with or without it.

## Selection

1. Read declared favicon/touch icons and web manifest icons from the submitted
   page. Resolve relative URLs against redirects, HTML `base`, and manifest URLs.
2. Decode candidates and compare their actual resolution. Prefer general-purpose
   icons to maskable-only icons at comparable resolution. Render SVGs and use the
   largest usable ICO frame. Ignore social preview/startup images, monochrome-only
   icons, corrupt images, empty images, and unsuitable aspect ratios.
3. If resolution is below 192px, check the origin homepage and root favicon.
4. If still below 192px, compare Google (requested at 256px) and DuckDuckGo results
   with the direct result. Only hostnames are sent to those services. Reject their
   non-200 responses, including generic placeholder images returned with 404.
5. Fit the best available icon into a transparent square without cropping it.
   A low-resolution source remains low-resolution detail; resizing cannot recover
   missing detail, and third-party caches can contain older branding.

Successful images are cached for one hour, with a bounded 256-entry process cache
and in-flight request deduplication. Discovery has a 10-second overall budget,
reserving its final 30% for provider fallbacks. Requests and decoded image sizes
are bounded. Only public HTTP(S) destinations on standard ports are fetched;
DNS answers are checked and pinned to the connection on every redirect.

## Development and deployment

Use Node 22 (Node 20.19.4+ is also supported):

```sh
npm ci
npm test
npm start
```

Tests cover discovery, rendering and selection through the handler with fixture
HTTP resources, plus transport redirect/DNS/response-size behavior. The deployment
workflow runs them before publishing. Sharp includes native dependencies: install
with `npm ci` on the Linux deployment runner, rather than copying macOS
`node_modules` to Azure. Changes remain local until pushed/deployed.

The iOS client is in `../Hackers`; `ThumbnailView.swift` selects this service by
default. Google and DuckDuckGo remain separate DEBUG comparison options.

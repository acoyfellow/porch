import manifest from '../public/app/.vite/manifest.json';

type ManifestEntry = { readonly file: string; readonly css?: ReadonlyArray<string> };

const entry = (manifest as Record<string, ManifestEntry>)['src/entry.ts'];

const escapeHtml = (value: string) => value.replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`);

export const appPage = (who: string): Response => {
  const css = (entry?.css ?? []).map((href) => `<link rel="stylesheet" href="/app/${href}">`).join('');
  const script = entry ? `<script type="module" src="/app/${entry.file}"></script>` : '';
  const html = `<!doctype html>
<html lang="en" class="h-full">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="theme-color" content="#0b0c0f">
<meta name="color-scheme" content="dark">
<meta name="description" content="Your cmux sidebar, terminals, Pi sessions and browsers, live on your phone.">
<meta name="robots" content="noindex, nofollow">
<meta name="application-name" content="porch">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="porch">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="format-detection" content="telephone=no">
<meta property="og:type" content="website">
<meta property="og:site_name" content="porch">
<meta property="og:title" content="porch">
<meta property="og:description" content="Your cmux, live on your phone. Behind Cloudflare Access, outbound-only from your Mac.">
<meta property="og:image" content="/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">
<title>porch</title>
${css}
</head>
<body class="h-full bg-[#0b0c0f] text-zinc-100" data-who="${escapeHtml(who)}">
<div id="root" class="h-full"></div>
${script}
</body>
</html>`;

  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
};

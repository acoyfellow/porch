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
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="robots" content="noindex">
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

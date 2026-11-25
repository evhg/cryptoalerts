#!/usr/bin/env python3
"""Builds the standalone (Vercel) copy of the dashboard from index.html.

The page is the same one the Claude dashboard uses. Here a small stand-in for the
dashboard runtime feeds it from public.stusds_board(), which answers only to the
random key carried in the link (#k=...). Run: python3 dashboard/build-vercel.py
"""
import pathlib
here = pathlib.Path(__file__).parent
page = (here / 'index.html').read_text()
SUPABASE = 'https://vaelokyqjdsxveqvdtbo.supabase.co'
# The project's public (anon) API key: meant to be embedded in web pages.
ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZhZWxva3lxamRzeHZlcXZkdGJvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMyNjQ3NjQsImV4cCI6MjEwODg0MDc2NH0.G5YzIlVlzL1stkdfTT6JKrOpjGaQjf7KVpD1ou0tIIQ'
head = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>stUSDS exit watch</title>
<style>
  :root {
    --color-fg: #0b0b0b; --color-fg-muted: #52514e; --color-bg: #f9f9f7; --color-panel: #fcfcfb; --color-border-line: #e1e0d9;
    --color-ok: #0a8a0a; --color-warn: #b97800; --color-bad: #d03b3b;
    --series-1: #2a78d6; --series-2: #eb6834; --series-3: #1baf7a;
    --font-anthropic-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --font-anthropic-serif: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
    --cds-font-size-caption: 13px; --cds-font-size-body: 15px; --cds-font-size-heading: 17px; --cds-font-size-title: 24px; --cds-font-weight-medium: 600;
    --cds-gap-xs: 4px; --cds-gap-sm: 8px; --cds-gap-md: 16px; --cds-gap-lg: 24px; --cds-gap-xl: 36px;
    --cds-pad-xs: 4px; --cds-pad-sm: 10px; --cds-pad-md: 14px; --cds-pad-lg: 20px; --cds-pad-xl: 28px; --cds-radius: 12px;
    --cds-chart-muted: #898781; --cds-chart-grid: #e1e0d9; --cds-chart-axis: #c3c2b7; --cds-chart-reference: #898781; --cds-chart-status-critical: #d03b3b;
    --cds-text-secondary: #52514e; --cds-surface-popover: #ffffff; --cds-border: #d9d8d0; --cds-shadow-popover: 0 6px 20px rgba(0, 0, 0, .14);
    --cds-dur-slow: .4s; --cds-ease-out: cubic-bezier(.2, .8, .2, 1);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --color-fg: #f0efec; --color-fg-muted: #c3c2b7; --color-bg: #0d0d0d; --color-panel: #1a1a19; --color-border-line: #2c2c2a;
      --color-ok: #0ca30c; --color-warn: #fab219; --color-bad: #e66767;
      --series-1: #3987e5; --series-2: #d95926; --series-3: #199e70;
      --cds-chart-grid: #2c2c2a; --cds-chart-axis: #383835; --cds-text-secondary: #c3c2b7; --cds-surface-popover: #242423; --cds-border: #383835; --cds-shadow-popover: 0 6px 20px rgba(0, 0, 0, .5);
    }
  }
  html { color-scheme: light dark; }
  body { margin: 0; background: var(--color-bg); color: var(--color-fg); font: var(--cds-font-size-body)/1.45 var(--font-anthropic-sans); }
  #dash-root { max-width: 1180px; margin: 0 auto; padding: 28px 16px 64px; }
  .dash-skeleton { color: transparent !important; background: color-mix(in srgb, var(--color-fg) 12%, transparent); border-radius: 6px; }
  .dash-skeleton * { visibility: hidden; }
  #gate { max-width: 520px; margin: 18vh auto; padding: 0 16px; text-align: center; color: var(--color-fg-muted); }
  #gate h1 { font: 400 28px/1.2 var(--font-anthropic-serif); color: var(--color-fg); margin: 0 0 12px; }
</style>
<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js" integrity="sha512-vc58qvvBdrDR4etbxMdlTt4GBQk1qjvyORR2nrsPsFPyrs+/u5c3+1Ct6upOgdZoIl7eq6k3a1UPDSNAQi/32A==" crossorigin="anonymous" referrerpolicy="no-referrer"></script>
<script>
  // Stand-in for the dashboard runtime: one request brings every table; the page's own code draws it.
  (() => {
    const fromHash = new URLSearchParams(location.hash.slice(1)).get('k');
    let key = fromHash;
    try { if (fromHash) localStorage.setItem('stusds_board_key', fromHash); else key = localStorage.getItem('stusds_board_key'); } catch (e) { /* storage unavailable */ }
    if (fromHash) history.replaceState(null, '', location.pathname);
    let status = 'loading', tables = {}, timer = null;
    const draws = {}, watchers = [];
    const run = () => {
      for (const f of watchers) { try { f(); } catch (e) { console.error(e); } }
      for (const [name, fn] of Object.entries(draws)) {
        document.querySelectorAll('[data-draw="' + name + '"]').forEach((el) => { if (!el.closest('[hidden]')) { try { fn(el); } catch (e) { console.error(name, e); } } });
      }
    };
    const gate = (on) => { const g = document.getElementById('gate'), r = document.getElementById('dash-root'); if (g && r) { g.hidden = !on; r.hidden = on; } };
    const load = async () => {
      if (!key) { gate(true); return; }
      try {
        const res = await fetch('__SUPABASE__/rest/v1/rpc/stusds_board', {
          method: 'POST', headers: {apikey: '__ANON__', authorization: 'Bearer __ANON__', 'content-type': 'application/json'}, body: JSON.stringify({p_key: key}),
        });
        const j = await res.json();
        if (res.ok && j && j.authorized) { tables = j; status = 'ok'; gate(false); }
        else if (res.ok) { gate(true); return; }
        else if (status !== 'ok') status = 'error';
      } catch (e) { if (status !== 'ok') status = 'error'; }
      run();
    };
    window.dash = {
      colors: ['var(--series-1)', 'var(--series-2)', 'var(--series-3)'],
      data: (id) => ({status, data: status === 'ok' && Array.isArray(tables[id]) ? tables[id] : []}),
      draw: (name, fn) => { if (fn) draws[name] = fn; else run(); },
      onData: (fn) => { watchers.push(fn); },
      refresh: () => { clearTimeout(timer); timer = setTimeout(load, 100); },
      loader: () => {}, calc: () => {}, params: () => ({}), setParams: () => {}, resetParams: () => {}, setLink: () => {},
    };
    let resize = null;
    window.addEventListener('resize', () => { clearTimeout(resize); resize = setTimeout(run, 150); });
    window.addEventListener('DOMContentLoaded', () => { run(); load(); });
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(); });
  })();
</script>
</head>
<body>
<div id="gate" hidden><h1>stUSDS exit watch</h1><p>This page needs its private link. Open the full link you were given (it ends in a key), once, on this device.</p></div>
<div id="dash-root">
""".replace('__SUPABASE__', SUPABASE).replace('__ANON__', ANON)
out = head + page + "\n</div>\n</body>\n</html>\n"
(here / 'vercel' / 'index.html').write_text(out)
(here / 'vercel' / 'vercel.json').write_text('{\n  "headers": [{"source": "/(.*)", "headers": [{"key": "X-Robots-Tag", "value": "noindex, nofollow"}, {"key": "Referrer-Policy", "value": "no-referrer"}, {"key": "X-Frame-Options", "value": "DENY"}]}]\n}\n')
print(len(out))

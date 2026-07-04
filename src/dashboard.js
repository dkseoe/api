// Minimal single-file HTML dashboard served at GET /.
// Polls /__status and renders running state, counters, recent requests,
// per-provider breakdown, and a live debug-log tail.

export const STATUS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>API Gateway — Status</title>
<style>
  :root {
    --bg:#0b0f14; --panel:#121821; --panel2:#0f141b; --ink:#e6edf3;
    --muted:#8b97a6; --accent:#58a6ff; --green:#3fb950; --red:#f85149;
    --yellow:#d29922; --border:#1f2a37; --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
    font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  header { padding:16px 20px; border-bottom:1px solid var(--border);
    display:flex; align-items:center; gap:14px; flex-wrap:wrap; }
  header h1 { margin:0; font-size:16px; font-weight:600; }
  .pill { font-size:12px; padding:3px 10px; border-radius:999px; border:1px solid var(--border); color:var(--muted); }
  .ok { color:var(--green); border-color:var(--green); }
  main { padding:16px 20px; display:grid; gap:16px; }
  .row { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:14px; }
  .card h2 { margin:0 0 10px; font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); }
  .stat { display:flex; justify-content:space-between; padding:3px 0; }
  .stat span:last-child { font-variant-numeric:tabular-nums; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th,td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--border); white-space:nowrap; }
  th { color:var(--muted); font-weight:500; position:sticky; top:0; background:var(--panel); }
  td { font-variant-numeric:tabular-nums; }
  .scroll { max-height:340px; overflow:auto; }
  .status-2 { color:var(--green); } .status-4 { color:var(--yellow); } .status-5 { color:var(--red); }
  .mono { font-family:var(--mono); }
  .logline { font-family:var(--mono); font-size:12px; padding:2px 8px; border-bottom:1px solid var(--panel2); white-space:pre-wrap; word-break:break-all; }
  .lvl-debug{color:#7d8590} .lvl-info{color:var(--ink)} .lvl-warn{color:var(--yellow)} .lvl-error{color:var(--red)}
  .bar { height:6px; border-radius:3px; background:var(--panel2); overflow:hidden; margin-top:4px; }
  .bar > i { display:block; height:100%; background:var(--accent); }
  .muted { color:var(--muted); }
  a { color:var(--accent); }
  .tag { font-size:11px; padding:1px 6px; border-radius:4px; background:var(--panel2); border:1px solid var(--border); color:var(--muted); }
  #pause { cursor:pointer; }
</style>
</head>
<body>
<header>
  <h1>⚡ API Gateway</h1>
  <span class="pill ok" id="health">…</span>
  <span class="pill" id="uptime">uptime —</span>
  <span class="pill" id="upstreams">upstreams —</span>
  <span class="pill" id="models">models —</span>
  <span style="flex:1"></span>
  <label class="pill"><input type="checkbox" id="pause" /> pause</label>
  <span class="pill" id="updated">—</span>
</header>
<main>
  <div class="row">
    <div class="card">
      <h2>Requests</h2>
      <div class="stat"><span>total</span><span id="c-total">0</span></div>
      <div class="stat"><span class="status-2">2xx success</span><span id="c-ok">0</span></div>
      <div class="stat"><span class="status-4">4xx client error</span><span id="c-4">0</span></div>
      <div class="stat"><span class="status-5">5xx server error</span><span id="c-5">0</span></div>
      <div class="stat"><span>streaming</span><span id="c-stream">0</span></div>
    </div>
    <div class="card">
      <h2>By provider</h2>
      <div id="providers" class="scroll" style="max-height:170px"></div>
    </div>
    <div class="card">
      <h2>By upstream</h2>
      <div id="byupstream" class="scroll" style="max-height:170px"></div>
    </div>
    <div class="card">
      <h2>Prompt cache <span class="muted" id="pc-mode"></span></h2>
      <div class="stat"><span>cache hits</span><span id="pc-hits">0</span></div>
      <div class="stat"><span class="status-2">read tokens</span><span id="pc-read">0</span></div>
      <div class="stat"><span>write tokens</span><span id="pc-write">0</span></div>
      <div class="stat"><span>auto-injected</span><span id="pc-injected">0</span></div>
      <div class="stat"><span>sticky</span><span id="pc-sticky">—</span></div>
    </div>
  </div>

  <div class="card">
    <h2>Recent requests <span class="muted" id="req-count"></span></h2>
    <div class="scroll">
      <table>
        <thead><tr>
          <th>#</th><th>time</th><th>method</th><th>path</th><th>model</th>
          <th>provider</th><th>upstream</th><th>status</th><th>latency</th>
          <th>tokens</th><th>bytes</th><th>cache</th><th>session</th><th>error</th>
        </tr></thead>
        <tbody id="reqs"></tbody>
      </table>
    </div>
  </div>

  <div class="card">
    <h2>Debug log</h2>
    <div class="scroll" id="logs" style="max-height:300px"></div>
  </div>
</main>
<script>
let paused = false;
document.getElementById('pause').addEventListener('change', e => paused = e.target.checked);

const fmtMs = ms => ms == null ? '—' : (ms < 1000 ? ms + 'ms' : (ms/1000).toFixed(2) + 's');
const fmtAgo = ts => {
  const d = (Date.now() - new Date(ts).getTime())/1000;
  if (d < 1) return 'now';
  if (d < 60) return Math.floor(d) + 's ago';
  if (d < 3600) return Math.floor(d/60) + 'm ago';
  return Math.floor(d/3600) + 'h ago';
};
const clsFor = s => s >= 500 ? 'status-5' : s >= 400 ? 'status-4' : 'status-2';

function render(s) {
  document.getElementById('health').textContent = 'healthy';
  document.getElementById('uptime').textContent = 'uptime ' + fmtMs(s.uptimeMs);
  document.getElementById('upstreams').textContent = 'upstreams: ' + s.upstreams.length;
  document.getElementById('models').textContent = s.models != null ? 'models: ' + s.models : 'models: —';
  document.getElementById('updated').textContent = new Date().toLocaleTimeString();

  const c = s.counters;
  document.getElementById('c-total').textContent = c.total;
  document.getElementById('c-ok').textContent = c.success;
  document.getElementById('c-4').textContent = c.clientError;
  document.getElementById('c-5').textContent = c.serverError;
  document.getElementById('c-stream').textContent = c.streaming;

  const provEl = document.getElementById('providers');
  provEl.innerHTML = Object.entries(c.byProvider).sort((a,b)=>b[1].total-a[1].total).map(([k,v]) => {
    const pct = v.total ? Math.round(v.ok/v.total*100) : 0;
    return '<div style="margin:4px 0"><div class="stat"><span class="mono">'+k+'</span><span>'+v.ok+'/'+v.total+' · '+pct+'%</span></div><div class="bar"><i style="width:'+pct+'%;background:'+(pct===100?'var(--green)':pct>50?'var(--accent)':'var(--red)')+'"></i></div></div>';
  }).join('') || '<div class="muted">no requests yet</div>';

  const upEl = document.getElementById('byupstream');
  upEl.innerHTML = Object.entries(c.byUpstream).map(([k,v])=>{
    return '<div class="stat"><span class="mono">'+k+'</span><span>'+v.ok+'/'+v.total+' ok</span></div>';
  }).join('') || '<div class="muted">no upstream calls yet</div>';

  // Prompt cache
  const pc = s.promptCache;
  if (pc) {
    document.getElementById('pc-mode').textContent = '(' + pc.inject + ', ttl ' + pc.ttl + ')';
    document.getElementById('pc-sticky').innerHTML = pc.sticky ? '<span class="status-2">on</span>' : 'off';
  }
  document.getElementById('pc-hits').textContent = c.cacheHits || 0;
  document.getElementById('pc-read').textContent = c.cacheReadTokens || 0;
  document.getElementById('pc-write').textContent = c.cacheWriteTokens || 0;
  document.getElementById('pc-injected').textContent = c.cacheInjected || 0;

  const tbody = document.getElementById('reqs');
  tbody.innerHTML = s.requests.slice(0,100).map(r => {
    const tok = r.tokens ? (r.tokens.prompt||0)+'+'+(r.tokens.completion||0)+'='+(r.tokens.total||0) : (r.stream ? 'stream' : '—');
    return '<tr>' +
      '<td>'+r.id+'</td>' +
      '<td class="muted">'+fmtAgo(r.ts)+'</td>' +
      '<td>'+r.method+'</td>' +
      '<td class="mono" style="max-width:160px;overflow:hidden;text-overflow:ellipsis">'+r.path+'</td>' +
      '<td class="mono" style="max-width:180px;overflow:hidden;text-overflow:ellipsis">'+(r.model||'—')+'</td>' +
      '<td>'+(r.provider||'—')+'</td>' +
      '<td class="muted">'+(r.upstream||'—')+'</td>' +
      '<td class="'+clsFor(r.status||0)+'">'+(r.status||'—')+'</td>' +
      '<td>'+fmtMs(r.latencyMs)+'</td>' +
      '<td>'+tok+'</td>' +
      '<td>'+(r.bytes||0)+'</td>' +
      '<td>'+( (r.cacheReadTokens? '<span class="status-2">R'+r.cacheReadTokens+'</span>':'') + (r.cacheWriteTokens? ' W'+r.cacheWriteTokens:'') + (r.promptCacheInjected? ' ⤵':'') || '—' )+'</td>' +
      '<td class="muted" style="max-width:120px;overflow:hidden;text-overflow:ellipsis">'+(r.sessionId||'—')+'</td>' +
      '<td class="status-5" style="max-width:200px;overflow:hidden;text-overflow:ellipsis">'+(r.error||'')+'</td>' +
    '</tr>';
  }).join('') || '<tr><td colspan="14" class="muted">no requests yet</td></tr>';
  document.getElementById('req-count').textContent = '(' + s.requests.length + ' shown, ' + c.total + ' total)';

  const logs = document.getElementById('logs');
  logs.innerHTML = s.logs.map(l => {
    const ts = new Date(l.ts).toLocaleTimeString();
    const data = l.data ? ' '+JSON.stringify(l.data) : '';
    return '<div class="logline lvl-'+l.level+'"><span class="muted">'+ts+'</span> '+l.level.toUpperCase().padEnd(5)+' '+l.msg+(data? ' <span class="muted">'+esc(data)+'</span>' : '')+'</div>';
  }).join('') || '<div class="muted">no logs yet</div>';
}
function esc(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;'); }

async function poll() {
  try {
    const r = await fetch('/__status');
    if (r.ok) render(await r.json());
  } catch {}
}
poll(); setInterval(() => { if (!paused) poll(); }, 2000);
</script>
</body>
</html>`;

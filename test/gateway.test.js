// Integration test: spin up a mock OpenAI-compatible upstream and verify the
// gateway reverse-proxies requests, streams responses, and aggregates models.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { loadConfig } from '../src/config.js';
import { createGateway } from '../src/server.js';
import { audit } from '../src/auditlog.js';
import { fetch } from 'undici';

/** Build a mock OpenAI-compatible upstream.
 *  `opts.calls` (optional) is incremented per proxied request.
 */
function mockUpstream(port, opts = {}) {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-test', object: 'model' }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      opts.calls = (opts.calls || 0) + 1;
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        let j = {};
        try { j = JSON.parse(body); } catch {}
        opts.lastBody = j;
        opts.bodies = opts.bodies || [];
        opts.bodies.push(j);
        // Track which upstream (by listen port) served the call for sticky tests.
        opts.port = server.address().port;
        if (j.stream) {
          const chunks = ['data: {"choices":[{"delta":{"content":"Hel"}}]}', 'data: {"choices":[{"delta":{"content":"lo"}}]}', 'data: [DONE]'];
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            'transfer-encoding': 'chunked',
          });
          (async () => {
            for (const c of chunks) {
              res.write(c + '\n\n');
              await new Promise((r) => setTimeout(r, 5));
            }
            res.end();
          })();
          return;
        }
        // Buffered JSON response for non-streaming requests.
        const out = {
          id: 'gen-test-' + (opts.calls || 0),
          object: 'chat.completion',
          model: j.model || 'gpt-test',
          choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        };
        // Simulate a provider prompt-cache hit on the second call.
        if (opts.calls >= 2) {
          out.usage.prompt_tokens_details = { cached_tokens: 4 };
        }
        const buf = Buffer.from(JSON.stringify(out));
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': buf.length,
        });
        res.end(buf);
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  return new Promise((resolve) =>
    server.listen(port, () => resolve({ server, port: server.address().port, opts }))
  );
}

async function withGateway(t, upstreams, handler, env = {}) {
  process.env.UPSTREAMS = upstreams.map((u) => `http://127.0.0.1:${u.port}/v1`).join(',');
  process.env.UPSTREAM_API_KEYS = '';
  process.env.MAX_CONCURRENCY_PER_UPSTREAM = '4';
  process.env.MAX_CONCURRENCY_TOTAL = '8';
  process.env.MODELS_CACHE_TTL_MS = '1000';
  process.env.UPSTREAM_REQUEST_TIMEOUT_MS = '5000';
  delete process.env.GATEWAY_CONFIG;
  // Reset optional env to defaults so tests don't leak settings into each other.
  for (const k of ['MODEL_PROVIDERS', 'MODEL_PROVIDER_ALLOW_FALLBACK', 'PROMPT_CACHE_INJECT', 'PROMPT_CACHE_TTL', 'PROMPT_CACHE_STICKY', 'VARIANTS_ENABLED', 'VARIANT_BASES', 'VARIANT_EFFORTS']) {
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }

  const config = loadConfig();
  const { server, pool } = createGateway(config);
  audit.reset();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const gatewayPort = server.address().port;
  t.after(async () => {
    server.close();
    pool.upstreams.forEach((u) => u.agent.close());
  });
  await handler(gatewayPort);
}

test('aggregates model list from gateway /v1/models', async (t) => {
  const up = await mockUpstream(0);
  t.after(() => new Promise((r) => up.server.close(r)));
  await withGateway(t, [up], async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.object, 'list');
    assert.equal(json.data.length, 1);
    assert.equal(json.data[0].id, 'gpt-test');
  });
});

test('reverse-proxies and streams an SSE chat completion', async (t) => {
  const up = await mockUpstream(0);
  t.after(() => new Promise((r) => up.server.close(r)));
  await withGateway(t, [up], async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-test', stream: true }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const text = await res.text();
    assert.match(text, /Hel/);
    assert.match(text, /lo/);
    assert.match(text, /\[DONE\]/);
  });
});

test('handles many concurrent requests (multi-concurrency)', async (t) => {
  const up = await mockUpstream(0);
  t.after(() => new Promise((r) => up.server.close(r)));
  await withGateway(t, [up], async (port) => {
    const N = 40;
    const start = Date.now();
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ stream: true }),
        }).then((r) => r.status)
      )
    );
    const elapsed = Date.now() - start;
    assert.equal(results.length, N);
    assert.ok(results.every((s) => s === 200), 'all requests succeeded');
    t.diagnostic(`40 concurrent streaming requests in ${elapsed}ms`);
  });
});

test('returns 502 when all upstreams fail', async (t) => {
  await withGateway(t, [{ port: 1 }], async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 502);
    const json = await res.json();
    assert.match(json.error.message, /All upstreams failed/);
  });
});

test('healthz returns ok', async (t) => {
  await withGateway(t, [{ port: 1 }], async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.status, 'ok');
  });
});

test('serves HTML status dashboard at GET /', async (t) => {
  const up = await mockUpstream(0);
  t.after(() => new Promise((r) => up.server.close(r)));
  await withGateway(t, [up], async (port) => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.match(html, /API Gateway/);
    assert.match(html, /__status/);
  });
});

test('__status JSON records proxied requests with model/provider/status', async (t) => {
  const up = await mockUpstream(0);
  t.after(() => new Promise((r) => up.server.close(r)));
  await withGateway(t, [up], async (port) => {
    // Fire a proxied chat request and consume the full body so the audit
    // record (written after the stream ends) is present.
    const cr = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-test', stream: true }),
    });
    await cr.text();

    const res = await fetch(`http://127.0.0.1:${port}/__status`);
    assert.equal(res.status, 200);
    const s = await res.json();
    assert.equal(s.counters.total, 1);
    assert.equal(s.counters.success, 1);
    assert.equal(s.counters.streaming, 1);
    assert.equal(s.requests.length, 1);
    const r = s.requests[0];
    assert.equal(r.model, 'gpt-test');
    assert.equal(r.status, 200);
    assert.equal(r.ok, true);
    assert.equal(r.stream, true);
    assert.ok(r.latencyMs >= 0);
    assert.ok(r.bytes > 0);
    assert.equal(r.attempts.length, 1);
    assert.equal(r.attempts[0].upstream, 'upstream-1');
    assert.equal(r.attempts[0].ok, true);
  });
});

test('injects top-level cache_control for anthropic models', async (t) => {
  const up = await mockUpstream(0);
  t.after(() => new Promise((r) => up.server.close(r)));
  await withGateway(t, [up], async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'anthropic/claude-sonnet-5', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-gateway-prompt-cache'), 'injected');
    await r.text();
    // The upstream should have received the injected cache_control.
    assert.deepEqual(up.opts.lastBody.cache_control, { type: 'ephemeral' });
  });
});

test('does not inject cache_control for non-anthropic models', async (t) => {
  const up = await mockUpstream(0);
  t.after(() => new Promise((r) => up.server.close(r)));
  await withGateway(t, [up], async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'openai/gpt-4o-mini', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }),
    });
    await r.text();
    assert.equal(r.headers.get('x-gateway-prompt-cache'), null);
    assert.equal(up.opts.lastBody.cache_control, undefined);
  });
});

test('respects client-provided cache_control (no re-injection)', async (t) => {
  const up = await mockUpstream(0);
  t.after(() => new Promise((r) => up.server.close(r)));
  await withGateway(t, [up], async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-5',
        cache_control: { type: 'ephemeral', ttl: '1h' },
        max_tokens: 5, messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    await r.text();
    assert.equal(r.headers.get('x-gateway-prompt-cache'), null);
    assert.deepEqual(up.opts.lastBody.cache_control, { type: 'ephemeral', ttl: '1h' });
  });
});

test('captures provider cache-read metrics from response usage', async (t) => {
  const up = await mockUpstream(0);
  t.after(() => new Promise((r) => up.server.close(r)));
  await withGateway(t, [up], async (port) => {
    const payload = { model: 'anthropic/claude-sonnet-5', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] };
    // First call: no cached_tokens (provider cache miss / write).
    await (await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    })).text();
    // Second call: mock returns cached_tokens=4.
    await (await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    })).text();

    const s = await (await fetch(`http://127.0.0.1:${port}/__status`)).json();
    assert.equal(s.counters.cacheReadTokens, 4, 'cache read tokens aggregated');
    assert.equal(s.counters.cacheHits, 1, 'one cache-hit request counted');
    assert.equal(s.counters.cacheInjected, 2, 'both requests had cache_control injected');
    const hitRec = s.requests.find((r) => r.cacheReadTokens > 0);
    assert.ok(hitRec);
    assert.equal(hitRec.cacheReadTokens, 4);
  });
});

test('sticky upstream routing by session_id pins a conversation', async (t) => {
  const up1 = await mockUpstream(0);
  const up2 = await mockUpstream(0);
  t.after(() => new Promise((r) => up1.server.close(r)));
  t.after(() => new Promise((r) => up2.server.close(r)));
  await withGateway(t, [up1, up2], async (port) => {
    const sid = 'agent-session-abc';
    const fire = () =>
      fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-id': sid },
        body: JSON.stringify({ model: 'anthropic/claude-sonnet-5', max_tokens: 5, messages: [{ role: 'user', content: 'x' }] }),
      }).then((r) => r.text());
    // Fire several requests in the same session.
    await Promise.all([fire(), fire(), fire(), fire(), fire()]);
    const one = up1.opts.calls || 0;
    const two = up2.opts.calls || 0;
    // All same-session requests must land on exactly one upstream.
    assert.ok(one === 0 || two === 0, `session pinned to one upstream (up1=${one}, up2=${two})`);
    assert.equal(one + two, 5);
  });
});

test('session_id from body takes precedence over header', async (t) => {
  const up1 = await mockUpstream(0);
  const up2 = await mockUpstream(0);
  t.after(() => new Promise((r) => up1.server.close(r)));
  t.after(() => new Promise((r) => up2.server.close(r)));
  await withGateway(t, [up1, up2], async (port) => {
    const fire = (sid) =>
      fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-id': 'from-header' },
        body: JSON.stringify({ model: 'anthropic/claude-sonnet-5', session_id: sid, max_tokens: 5, messages: [{ role: 'user', content: 'x' }] }),
      }).then((r) => r.text());
    // 'A' and 'B' sessions should hash to (possibly) different upstreams.
    await Promise.all([fire('A'), fire('A'), fire('B'), fire('B')]);
    const s = await (await fetch(`http://127.0.0.1:${port}/__status`)).json();
    // Each request recorded with its body session_id (not header).
    const sids = s.requests.map((r) => r.sessionId).sort();
    assert.deepEqual(sids, ['A', 'A', 'B', 'B']);
  });
});

test('per-model provider pinning injects provider.order', async (t) => {
  const up = await mockUpstream(0);
  t.after(() => new Promise((r) => up.server.close(r)));
  await withGateway(t, [up], async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'z-ai/glm-5.2', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-gateway-provider'), 'siliconflow/fp8');
    await r.text();
    assert.deepEqual(up.opts.lastBody.provider, { order: ['siliconflow/fp8'], allow_fallbacks: false });
  }, { MODEL_PROVIDERS: 'z-ai/glm-5.2=siliconflow/fp8,deepseek/deepseek-v4-pro=streamlake/fp8' });
});

test('provider pinning is recorded in the audit log', async (t) => {
  const up = await mockUpstream(0);
  t.after(() => new Promise((r) => up.server.close(r)));
  await withGateway(t, [up], async (port) => {
    await (await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek/deepseek-v4-pro', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }),
    })).text();
    const s = await (await fetch(`http://127.0.0.1:${port}/__status`)).json();
    const rec = s.requests[0];
    assert.equal(rec.providerPin, 'streamlake/fp8');
    assert.deepEqual(up.opts.lastBody.provider, { order: ['streamlake/fp8'], allow_fallbacks: false });
  }, { MODEL_PROVIDERS: 'z-ai/glm-5.2=siliconflow/fp8,deepseek/deepseek-v4-pro=streamlake/fp8' });
});

test('client-provided provider object is not overridden', async (t) => {
  const up = await mockUpstream(0);
  t.after(() => new Promise((r) => up.server.close(r)));
  await withGateway(t, [up], async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'z-ai/glm-5.2',
        provider: { order: ['novita/fp8'], allow_fallbacks: true },
        max_tokens: 5, messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    await r.text();
    assert.deepEqual(up.opts.lastBody.provider, { order: ['novita/fp8'], allow_fallbacks: true });
    assert.equal(r.headers.get('x-gateway-provider'), null, 'no pin header when client set provider');
  }, { MODEL_PROVIDERS: 'z-ai/glm-5.2=siliconflow/fp8' });
});

test('models without a configured provider are not pinned', async (t) => {
  const up = await mockUpstream(0);
  t.after(() => new Promise((r) => up.server.close(r)));
  await withGateway(t, [up], async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'openai/gpt-4o-mini', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }),
    });
    await r.text();
    assert.equal(up.opts.lastBody.provider, undefined);
    assert.equal(r.headers.get('x-gateway-provider'), null);
  }, { MODEL_PROVIDERS: 'z-ai/glm-5.2=siliconflow/fp8' });
});

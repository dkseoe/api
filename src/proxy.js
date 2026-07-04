// Reverse-proxy handler: forwards an incoming request to an upstream and
// streams the response back. Supports SSE streaming (chat/completions, etc.)
// and failover across upstreams on transient failures.
//
// Prompt-caching support:
//   - Sticky upstream routing by session_id (body or x-session-id header) so
//     provider-side prompt caches stay warm across the gateway.
//   - Optional auto-injection of Anthropic top-level `cache_control` so
//     clients benefit from prompt caching without changing their code.
//   - Captures provider cache metrics (cached_tokens / cache_write_tokens)
//     from the response `usage` object into the audit log.
//
// Each request is recorded in the audit log with model, provider, upstream,
// status, latency, tokens and any errors.

import { fetch } from 'undici';
import { log } from './logger.js';
import { sendJson } from './util.js';
import { audit } from './auditlog.js';
import { loadVariantConfig, applyVariant } from './variants.js';

// Hop-by-hop headers that must not be forwarded by a proxy (RFC 7230 §6.1).
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length', // undici re-computes from the body we send
  'content-encoding', // we auto-decompress upstream; don't forward a stale one
]);

function forwardHeaders(req) {
  const out = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

/** Parse the JSON request body and extract caching-relevant metadata. */
function parseRequestMeta(body, req) {
  if (!body || body.length === 0) return {};
  try {
    const j = JSON.parse(body.toString('utf8'));
    const sessionFromHeader = req.headers['x-session-id'];
    return {
      model: j.model,
      stream: !!j.stream,
      body: j,
      sessionId: j.session_id || (Array.isArray(sessionFromHeader) ? sessionFromHeader[0] : sessionFromHeader) || '',
    };
  } catch {
    const sessionFromHeader = req.headers['x-session-id'];
    return {
      sessionId: (Array.isArray(sessionFromHeader) ? sessionFromHeader[0] : sessionFromHeader) || '',
    };
  }
}

/** Derive a human-friendly provider name from a model id / upstream host. */
function providerOf(model, upstream) {
  if (model && model.includes('/')) return model.split('/')[0];
  if (model) return model;
  try {
    return new URL(upstream.baseUrl).host.split('.')[0];
  } catch {
    return upstream.id;
  }
}

/** Is this an Anthropic model (OpenRouter `anthropic/*` or `~anthropic/*`)? */
function isAnthropicModel(model) {
  const m = (model || '').toLowerCase();
  return m.startsWith('anthropic/') || m.startsWith('~anthropic/');
}

/**
 * Optionally inject top-level `cache_control` into the request body to enable
 * Anthropic automatic prompt caching. Only injected for Anthropic models when
 * not already present, and never for streaming `/v1/messages` requests where
 * the client manages breakpoints.
 *
 * @returns {{body:Buffer, injected:boolean}}
 */
function maybeInjectCacheControl(body, parsedBody, model, path, config) {
  if (!body || !parsedBody) return { body, injected: false };
  const inject = config.promptCacheInject;
  if (inject === 'off') return { body, injected: false };
  const wantsAnthropic = inject === 'anthropic' || inject === 'all';
  if (!wantsAnthropic) return { body, injected: false };
  // Only Anthropic supports top-level cache_control; for `all` we still only
  // inject on anthropic models (other providers ignore/400 on it).
  if (!isAnthropicModel(model)) return { body, injected: false };
  if (parsedBody.cache_control) return { body, injected: false }; // client set it

  const clone = { ...parsedBody };
  clone.cache_control = { type: 'ephemeral' };
  if (config.promptCacheTtl === '1h') clone.cache_control.ttl = '1h';
  return { body: Buffer.from(JSON.stringify(clone), 'utf8'), injected: true };
}

/**
 * Extract provider prompt-cache metrics from a parsed response.
 * OpenAI-compat: usage.prompt_tokens_details.{cached_tokens, cache_write_tokens}
 * Anthropic-native: usage.cache_read_input_tokens / cache_creation_input_tokens
 * OpenRouter also exposes usage.prompt_tokens_details on chat completions.
 */
function extractCacheMetrics(parsed) {
  const u = parsed?.usage;
  if (!u) return null;
  const details = u.prompt_tokens_details || {};
  let cached = details.cached_tokens ?? 0;
  let written = details.cache_write_tokens ?? 0;
  // Anthropic-native fields (when proxied through /v1/messages).
  if (u.cache_read_input_tokens) cached = Math.max(cached, u.cache_read_input_tokens);
  if (u.cache_creation_input_tokens) written = Math.max(written, u.cache_creation_input_tokens);
  if (!cached && !written) return null;
  return { cachedTokens: cached, writeTokens: written };
}

/**
 * Attempt to proxy a single request to one upstream.
 * @returns {Promise<{res:import('undici').Response, upstreamId:string, latencyMs:number}>}
 * Throws on network/abort/HTTP 5xx so the caller can fail over.
 */
async function proxyOnce(upstream, req, body, pool) {
  const url = pool.urlFor(upstream, req.url);
  const headers = forwardHeaders(req);
  if (upstream.apiKey) headers.authorization = `Bearer ${upstream.apiKey}`;

  const ctrl = new AbortController();
  const timer = pool.upstreamRequestTimeoutMs
    ? setTimeout(() => ctrl.abort(), pool.upstreamRequestTimeoutMs)
    : null;

  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
      dispatcher: upstream.agent,
      signal: ctrl.signal,
      compress: true, // undici auto-decompresses; we strip content-encoding below
    });

    // Retry on 5xx — likely a transient upstream issue.
    if (res.status >= 500) {
      const text = await res.text().catch(() => '');
      const err = new Error(`upstream ${res.status} ${res.statusText}`);
      err.status = res.status;
      err.body = text;
      throw err;
    }
    return { res, upstreamId: upstream.id, latencyMs: Date.now() - start };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Proxy an incoming request, attempting failover across upstreams.
 * Writes the response directly to the Node ServerResponse and records the
 * full request lifecycle to the audit log.
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {import('./upstreams.js').UpstreamPool} pool
 * @param {object} config
 */
export async function proxyRequest(req, res, pool, config) {
  // Buffer the request body once so we can replay it across failover attempts.
  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = Buffer.concat(chunks);
  }

  const meta = parseRequestMeta(body, req);
  let { model, stream, body: parsedBody, sessionId } = meta;
  const startedAt = Date.now();
  const rec = audit.beginRequest();
  rec.method = req.method;
  rec.path = req.url;
  rec.model = model;
  rec.stream = !!stream;
  rec.sessionId = sessionId || undefined;
  rec.attempts = [];
  rec.bytes = 0;
  rec.status = 0;
  rec.ok = false;

  // Thinking-effort variant rewrite: swap the virtual variant model id for
  // its base and inject verbosity + reasoning effort. Runs before prompt-cache
  // injection so the latter sees the real (base) model.
  let variantApplied = null;
  if (parsedBody) {
    const { parsed, variant } = applyVariant(parsedBody, loadVariantConfig());
    if (variant) {
      parsedBody = parsed;
      body = Buffer.from(JSON.stringify(parsed), 'utf8');
      model = parsed.model;
      variantApplied = variant;
      rec.variantOf = `${variant.base} (${variant.effort})`;
      rec.model = `${model}-${variant.effort}`; // display the requested variant
      res.setHeader('x-gateway-variant', `${variant.base}:${variant.effort}`);
    }
  }

  // Optional auto-injection of Anthropic prompt-caching cache_control.
  let injected = false;
  if (body && parsedBody) {
    const r = maybeInjectCacheControl(body, parsedBody, model, req.url, config);
    body = r.body;
    injected = r.injected;
    if (injected) res.setHeader('x-gateway-prompt-cache', 'injected');
  }

  // Per-model provider pinning (OpenRouter provider object). Applies to the
  // final (post-variant) model id so it works for both direct and variant
  // requests. Skipped if the client already set a `provider` object.
  //
  // Pin values:
  //   "price"           => inject {sort:"price"}; OpenRouter picks the
  //                        cheapest usable provider and falls back
  //                        automatically if the cheapest is unavailable.
  //   "slug" / [..]     => inject {order:[...], allow_fallbacks}; explicit
  //                        provider preference (pipe-separated for a list).
  if (parsedBody && config.modelProviders && !parsedBody.provider) {
    const pin = config.modelProviders[model];
    if (pin) {
      if (pin === 'price') {
        parsedBody.provider = { sort: 'price' };
        rec.providerPin = 'price';
        res.setHeader('x-gateway-provider', 'price');
      } else {
        const order = Array.isArray(pin) ? pin : [pin];
        parsedBody.provider = { order, allow_fallbacks: config.modelProviderAllowFallback };
        rec.providerPin = order.join('|');
        res.setHeader('x-gateway-provider', order.join('|'));
      }
      if (body) body = Buffer.from(JSON.stringify(parsedBody), 'utf8');
      log.debug('provider pinned', { model, pin: rec.providerPin });
    }
  }

  const upstreams = pool.all();
  const useSticky = config.promptCacheSticky && upstreams.length > 1 && sessionId;
  const attempted = new Set();

  for (let attempt = 0; attempt < upstreams.length; attempt++) {
    // First attempt honors sticky routing by session id; failover attempts
    // walk the rest of the pool via round-robin.
    const primary =
      attempt === 0 && useSticky
        ? pool.pick(sessionId)
        : pool.pick();
    const ordered = [primary, ...upstreams.filter((u) => u !== primary)];
    const upstream = ordered.find((u) => !attempted.has(u.id));
    if (!upstream) break;
    attempted.add(upstream.id);

    const attemptStart = Date.now();
    try {
      const result = await upstream.semaphore.run(() => proxyOnce(upstream, req, body, pool));
      const { res: upstreamRes, upstreamId } = result;
      rec.upstream = upstreamId;
      rec.provider = providerOf(model, upstream);
      rec.upstreamStatus = upstreamRes.status;
      rec.promptCacheInjected = injected || undefined;

      const ct = upstreamRes.headers.get('content-type') || '';
      const isStream = stream || ct.includes('text/event-stream');

      if (isStream) {
        // Stream the upstream body straight to the client.
        res.writeHead(upstreamRes.status, sanitizeHeaders(upstreamRes.headers));
        try {
          for await (const chunk of upstreamRes.body) {
            rec.bytes += chunk.length;
            if (!res.write(chunk)) {
              await new Promise((r) => res.once('drain', r));
            }
          }
        } finally {
          await upstreamRes.body?.cancel?.().catch(() => {});
          res.end();
        }
        rec.status = upstreamRes.status;
        rec.ok = upstreamRes.status < 400;
        rec.latencyMs = Date.now() - startedAt;
        rec.attempts.push({ upstream: upstreamId, ok: true, status: upstreamRes.status, latencyMs: Date.now() - attemptStart });
        audit.recordRequest(rec);
        log.debug('proxied', { method: req.method, url: req.url, upstream: upstreamId, status: upstreamRes.status, model, stream: true, bytes: rec.bytes });
        return;
      }

      // Buffered JSON response — parse usage + cache metrics, then send.
      const bufChunks = [];
      for await (const chunk of upstreamRes.body) bufChunks.push(chunk);
      const buf = Buffer.concat(bufChunks);
      rec.bytes = buf.length;

      let parsed;
      try { parsed = JSON.parse(buf.toString('utf8')); } catch { parsed = null; }
      if (parsed?.usage) {
        rec.tokens = {
          prompt: parsed.usage.prompt_tokens ?? 0,
          completion: parsed.usage.completion_tokens ?? 0,
          total: parsed.usage.total_tokens ?? 0,
        };
      }
      const cm = extractCacheMetrics(parsed);
      if (cm) {
        rec.cacheReadTokens = cm.cachedTokens;
        rec.cacheWriteTokens = cm.writeTokens;
      }
      if (parsed?.model && !rec.model) rec.model = parsed.model;

      res.writeHead(upstreamRes.status, sanitizeHeaders(upstreamRes.headers));
      res.end(buf);

      rec.status = upstreamRes.status;
      rec.ok = upstreamRes.status < 400;
      rec.latencyMs = Date.now() - startedAt;
      rec.attempts.push({ upstream: upstreamId, ok: true, status: upstreamRes.status, latencyMs: Date.now() - attemptStart });
      audit.recordRequest(rec);
      log.debug('proxied', {
        method: req.method, url: req.url, upstream: upstreamId, status: upstreamRes.status, model,
        tokens: rec.tokens, cacheRead: rec.cacheReadTokens, cacheWrite: rec.cacheWriteTokens,
      });
      return;
    } catch (err) {
      const errMsg = err.name === 'AbortError' ? 'timeout' : err.message;
      rec.attempts.push({ upstream: upstream.id, ok: false, status: err.status, error: errMsg, latencyMs: Date.now() - attemptStart });
      log.warn('upstream attempt failed', {
        upstream: upstream.id, url: req.url, method: req.method, model, err: errMsg,
      });
      // continue to next upstream
    }
  }

  // All upstreams exhausted.
  rec.status = 502;
  rec.ok = false;
  rec.latencyMs = Date.now() - startedAt;
  rec.error = 'All upstreams failed';
  audit.recordRequest(rec);

  sendJson(res, 502, {
    error: {
      message: 'All upstreams failed to serve the request.',
      type: 'gateway_upstream_error',
      attempted: [...attempted],
    },
  });
}

function sanitizeHeaders(headers) {
  const out = {};
  for (const [key, value] of headers.entries()) {
    const lk = key.toLowerCase();
    if (HOP_BY_HOP.has(lk)) continue;
    out[key] = value;
  }
  return out;
}

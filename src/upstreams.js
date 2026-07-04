// Upstream pool: connection-pooled HTTP clients, round-robin selection,
// and concurrent model-list aggregation with caching.
//
// Uses undici's Agent (bundled with Node) for HTTP/1.1 keep-alive connection
// pooling so many concurrent proxy requests reuse warm connections.

import { Agent, fetch } from 'undici';
import { Semaphore } from './concurrency.js';
import { log } from './logger.js';
import { generateVariantModels, loadVariantConfig } from './variants.js';

export class UpstreamPool {
  /**
   * @param {object} opts
   * @param {Array<{id:string,baseUrl:string,apiKey:string}>} opts.upstreams
   * @param {number} opts.maxConcurrencyPerUpstream
   * @param {number} opts.upstreamRequestTimeoutMs
   * @param {number} opts.modelsCacheTtlMs
   * @param {string} opts.modelsPath Path appended to baseUrl to fetch models (default '/models').
   */
  constructor(opts) {
    this.upstreams = opts.upstreams.map((u) => ({
      ...u,
      agent: new Agent({
        keepAliveTimeout: 30_000,
        keepAliveMaxTimeout: 60_000,
        // Allow many concurrent connections per upstream for high throughput.
        connections: 64,
        pipelining: 1,
      }),
      semaphore: new Semaphore(opts.maxConcurrencyPerUpstream),
    }));
    this.upstreamRequestTimeoutMs = opts.upstreamRequestTimeoutMs;
    this.modelsCacheTtlMs = opts.modelsCacheTtlMs;
    this.modelsPath = opts.modelsPath || '/models';

    // Aggregated model-list cache.
    this._modelsCache = null; // { data: [...], at: ms }
    this._modelsInflight = null; // shared promise to dedupe concurrent refreshes

    // Global round-robin counter for selecting upstreams.
    this._rr = 0;
  }

  /**
   * Pick the next upstream via round-robin, skipping any with no available
   * concurrency slots when possible.
   *
   * When `sessionKey` is provided (non-empty), selection is sticky: the same
   * key always maps to the same upstream so provider-side prompt caches stay
   * warm across the gateway. Saturation still falls back to round-robin.
   * @param {string} [sessionKey]
   * @returns {{id:string,baseUrl:string,apiKey:string,agent:Agent,semaphore:Semaphore}}
   */
  pick(sessionKey) {
    const list = this.upstreams;
    if (list.length === 1) return list[0];

    // Sticky routing by session key keeps the provider prompt cache warm.
    if (sessionKey) {
      let h = 0;
      for (let i = 0; i < sessionKey.length; i++) h = (h * 31 + sessionKey.charCodeAt(i)) | 0;
      const sticky = list[Math.abs(h) % list.length];
      if (sticky.semaphore.available > 0) return sticky;
      // sticky upstream saturated — fall through to round-robin for this request.
      // (The provider cache will be re-warmed on the next available sticky pick.)
    }

    for (let i = 0; i < list.length; i++) {
      const u = list[(this._rr + i) % list.length];
      if (u.semaphore.available > 0) {
        this._rr = (this._rr + i + 1) % list.length;
        return u;
      }
    }
    // All saturated — fall back to plain round-robin; request will queue.
    const u = list[this._rr % list.length];
    this._rr = (this._rr + 1) % list.length;
    return u;
  }

  /** @returns {Array} all upstreams (for failover iteration). */
  all() {
    return this.upstreams;
  }

  /**
   * Build an absolute upstream URL for a given incoming path.
   * The gateway exposes an OpenAI-compatible /v1/* namespace. A leading /v1
   * on the incoming path is stripped so the request maps cleanly onto the
   * upstream base URL — whether the upstream uses /v1 (standard OpenAI) or
   * /api/v1 (Runloop) as its base path.
   * e.g. base `https://gateway.runloop.ai/api/v1` + incoming `/v1/chat/completions`
   * -> `https://gateway.runloop.ai/api/v1/chat/completions`.
   */
  urlFor(upstream, incomingPath) {
    let path = incomingPath || '/';
    if (path === '/v1' || path.startsWith('/v1/')) {
      path = path.slice(3) || '/';
    }
    const base = upstream.baseUrl;
    const basePath = new URL(base).pathname.replace(/\/+$/, '');
    return new URL(basePath + path, base).toString();
  }

  /**
   * Fetch the model list from one upstream.
   * @returns {Promise<Array<{id:string,object:string,owned_by?:string,upstream:string}>>}
   */
  async #fetchModelsFrom(upstream) {
    const url = this.urlFor(upstream, this.modelsPath);
    const headers = { Accept: 'application/json' };
    if (upstream.apiKey) headers.Authorization = `Bearer ${upstream.apiKey}`;

    const ctrl = new AbortController();
    const timer = this.upstreamRequestTimeoutMs
      ? setTimeout(() => ctrl.abort(), this.upstreamRequestTimeoutMs)
      : null;

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers,
        dispatcher: upstream.agent,
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 200)}` : ''}`);
      }
      const json = await res.json();
      const list = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
      return list
        .filter((m) => m && (m.id || m.name))
        .map((m) => ({
          id: m.id || m.name,
          object: m.object || 'model',
          owned_by: m.owned_by || m.owned_by || upstream.id,
          upstream: upstream.id,
        }));
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Concurrently pull model lists from all upstreams and aggregate them.
   * Results are cached for `modelsCacheTtlMs`; concurrent callers share a
   * single refresh to avoid thundering-herd.
   * @returns {Promise<{object:'list',data:Array}>>}
   */
  async getModels() {
    const now = Date.now();
    if (this._modelsCache && now - this._modelsCache.at < this.modelsCacheTtlMs) {
      return this._modelsCache.value;
    }
    if (this._modelsInflight) return this._modelsInflight;

    this._modelsInflight = (async () => {
      const results = await Promise.allSettled(
        this.upstreams.map((u) =>
          u.semaphore.run(() => this.#fetchModelsFrom(u)).catch((err) => {
            log.warn('models fetch failed', { upstream: u.id, err });
            throw err;
          })
        )
      );

      const seen = new Set();
      const data = [];
      let ok = 0;
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') {
          ok++;
          for (const m of r.value) {
            const key = `${m.upstream}/${m.id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            data.push(m);
          }
        }
      });

      if (ok === 0) {
        // All upstreams failed — don't poison the cache; let callers retry.
        this._modelsCache = null;
        const errs = results
          .map((r) => (r.status === 'rejected' ? r.reason?.message : null))
          .filter(Boolean);
        throw new Error(`All upstreams failed to return models: ${errs.join(' | ')}`);
      }

      // Append gateway-injected thinking-effort variants for the configured
      // base models, but only for bases that actually exist upstream.
      const vcfg = loadVariantConfig();
      if (vcfg.enabled) {
        const known = new Set(data.map((m) => m.id));
        const variants = generateVariantModels(vcfg).filter((v) => known.has(v.base_model));
        for (const v of variants) {
          if (!seen.has(v.id)) {
            seen.add(v.id);
            data.push(v);
          }
        }
        if (variants.length) log.info('variants added', { count: variants.length });
      }

      const value = { object: 'list', data };
      this._modelsCache = { value, at: Date.now() };
      log.info('models refreshed', { count: data.length, upstreams_ok: ok, total: this.upstreams.length });
      return value;
    })();

    try {
      return await this._modelsInflight;
    } finally {
      this._modelsInflight = null;
    }
  }
}

// In-memory audit log: ring buffers of recent proxy requests and structured
// log lines, plus rolling counters. Powers the /status dashboard.
//
// This is a singleton shared across all request handlers in the process.

/** @typedef {{
 *   id:number, ts:string, method:string, path:string, model?:string,
 *   provider?:string, upstream?:string, status:number, upstreamStatus?:number,
 *   latencyMs:number, stream:boolean, tokens?:{prompt:number,completion:number,total:number},
 *   bytes:number, ok:boolean, error?:string, attempts:Array<{upstream:string,ok:boolean,status?:number,error?:string,latencyMs:number}>
 * }} RequestRecord
 */

let nextId = 1;

class AuditLog {
  /**
   * @param {{maxRequests?:number, maxLogs?:number}} [opts]
   */
  constructor(opts = {}) {
    this.maxRequests = opts.maxRequests ?? 500;
    this.maxLogs = opts.maxLogs ?? 300;
    /** @type {RequestRecord[]} newest-first */
    this.requests = [];
    /** @type {Array<{ts:string,level:string,msg:string,data?:unknown}>} newest-first */
    this.logs = [];
    this.startedAt = Date.now();
    this.counters = {
      total: 0,
      success: 0, // 2xx
      clientError: 0, // 4xx
      serverError: 0, // 5xx
      streaming: 0,
      byProvider: {}, // provider -> {total, ok, error}
      byUpstream: {}, // upstream id -> {total, ok, error}
      // Provider-side prompt caching metrics.
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheInjected: 0, // requests where we injected cache_control
      cacheHits: 0, // requests with cacheReadTokens > 0
    };
  }

  /** @returns {RequestRecord} */
  beginRequest() {
    return { id: nextId++ };
  }

  /**
   * @param {RequestRecord} rec
   */
  recordRequest(rec) {
    rec.ts = rec.ts || new Date().toISOString();
    this.requests.unshift(rec);
    if (this.requests.length > this.maxRequests) this.requests.length = this.maxRequests;

    this.counters.total++;
    const cls = rec.status < 400 ? 'success' : rec.status < 500 ? 'clientError' : 'serverError';
    this.counters[cls]++;
    if (rec.stream) this.counters.streaming++;
    if (rec.promptCacheInjected) this.counters.cacheInjected++;
    if (rec.cacheReadTokens && rec.cacheReadTokens > 0) this.counters.cacheHits++;
    this.counters.cacheReadTokens += rec.cacheReadTokens || 0;
    this.counters.cacheWriteTokens += rec.cacheWriteTokens || 0;

    const bump = (bucket, key, ok) => {
      const b = (this.counters[bucket] ||= {});
      const e = (b[key] ||= { total: 0, ok: 0, error: 0 });
      e.total++;
      if (ok) e.ok++;
      else e.error++;
    };
    if (rec.provider) bump('byProvider', rec.provider, rec.ok);
    if (rec.upstream) bump('byUpstream', rec.upstream, rec.ok);
  }

  /**
   * @param {{level:string,msg:string,data?:unknown}} entry
   */
  addLog(entry) {
    this.logs.unshift({ ts: new Date().toISOString(), ...entry });
    if (this.logs.length > this.maxLogs) this.logs.length = this.maxLogs;
  }

  /**
   * @param {{upstreams?:Array<{id:string,baseUrl:string}>, models?:number, promptCache?:object}} [extra]
   * @returns {object}
   */
  snapshot(extra = {}) {
    return {
      startedAt: new Date(this.startedAt).toISOString(),
      uptimeMs: Date.now() - this.startedAt,
      counters: this.counters,
      requests: this.requests,
      logs: this.logs,
      upstreams: extra.upstreams ?? [],
      models: extra.models ?? null,
      promptCache: extra.promptCache ?? null,
    };
  }

  /** Reset all buffers and counters (mainly for tests). */
  reset() {
    this.requests.length = 0;
    this.logs.length = 0;
    this.startedAt = Date.now();
    this.counters = {
      total: 0, success: 0, clientError: 0, serverError: 0, streaming: 0,
      byProvider: {}, byUpstream: {},
      cacheReadTokens: 0, cacheWriteTokens: 0, cacheInjected: 0, cacheHits: 0,
    };
  }
}

export const audit = new AuditLog();

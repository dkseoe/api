// Centralized structured logging with level filtering.
// Keeps zero dependencies and avoids blocking the event loop on large payloads.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/** @type {keyof typeof LEVELS | undefined} */
let configuredLevel;

/** @returns {number} */
function threshold() {
  if (configuredLevel === undefined) {
    const env = (process.env.LOG_LEVEL || 'info').toLowerCase();
    configuredLevel = Object.prototype.hasOwnProperty.call(LEVELS, env) ? env : 'info';
  }
  return LEVELS[configuredLevel];
}

function fmtErr(value) {
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  return value;
}

function emit(level, msg, extra) {
  if (LEVELS[level] < threshold()) return;
  const rec = { t: new Date().toISOString(), level, msg };
  if (extra !== undefined) {
    if (extra instanceof Error) rec.err = fmtErr(extra);
    else if (typeof extra === 'object' && extra !== null) Object.assign(rec, extra);
    else rec.data = extra;
  }
  // Errors get printed to stderr for visibility.
  const stream = level === 'error' ? process.stderr : process.stdout;
  stream.write(JSON.stringify(rec) + '\n');
  for (const s of sinks) {
    try { s({ level, msg, data: rec.err ?? rec.data }); } catch {}
  }
}

export const log = {
  debug: (msg, extra) => emit('debug', msg, extra),
  info: (msg, extra) => emit('info', msg, extra),
  warn: (msg, extra) => emit('warn', msg, extra),
  error: (msg, extra) => emit('error', msg, extra),
};

/** @type {Array<(e:{level:string,msg:string,data?:unknown})=>void>} */
const sinks = [];
/** Attach a sink that receives every emitted log entry (post-threshold). */
export function addSink(fn) {
  sinks.push(fn);
}

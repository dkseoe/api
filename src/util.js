// Small response helpers shared across handlers.

/** @returns {boolean} */
export function wantsPretty(req) {
  if (req?.headers?.accept?.includes('text/html')) return true;
  if (req?.url && /\?pretty=1\b/.test(req.url)) return true;
  return false;
}

/**
 * Send a JSON response, optionally pretty-printed.
 * @param {import('http').ServerResponse} res
 * @param {number} status
 * @param {*} obj
 * @param {boolean} [pretty]
 */
export function sendJson(res, status, obj, pretty = false) {
  const body = pretty ? JSON.stringify(obj, null, 2) : JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

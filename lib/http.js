/**
 * Bounded JSON body helpers for the /api/dsh-cronops route family.
 *
 * The family reads only small control payloads (panel edits, id arrays, one
 * environment variable, one task), so a 64 KiB ceiling is generous. Responses
 * are always JSON: the browser half never parses HTML.
 */

/** Default body cap: 64 KiB. */
const DEFAULT_BODY_MAX_BYTES = 64 * 1024

/** Family-default JSON response headers. */
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
}

/**
 * Read one bounded request body and parse it as JSON.
 * @param {import('node:http').IncomingMessage} req - the incoming request.
 * @param {{ maxBytes?: number, objectOnly?: boolean }} [opts] - byte ceiling and object-only narrowing.
 * @returns {Promise<unknown | null>} the parsed value, or null for an empty/invalid/oversized body.
 */
export async function readJsonBody(req, opts = {}) {
  const maxBytes = opts.maxBytes ?? DEFAULT_BODY_MAX_BYTES
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) {
      req.destroy()
      return null
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return null
  try {
    const parsed = JSON.parse(text)
    if (opts.objectOnly === true && !isJsonObject(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

/** Whether a value is a JSON object: typeof object, not null, not an array. */
export function isJsonObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Narrow a value to a JSON object, or undefined when it is not one. */
export function asJsonObject(value) {
  return isJsonObject(value) ? value : undefined
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res - the response to write.
 * @param {number} status - HTTP status code.
 * @param {unknown} body - JSON payload.
 * @param {Record<string, unknown>} [headers] - extra headers, overriding the family defaults.
 */
export function writeJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { ...JSON_HEADERS, ...headers })
  res.end(payload)
}

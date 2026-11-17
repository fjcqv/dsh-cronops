/**
 * Loopback trust fence for the /api/dsh-cronops route family.
 *
 * These endpoints read and mutate a remote panel with stored application
 * credentials, so a LAN-exposed dsh web deployment must not serve them. The
 * fence matches the SSH plugin family's: a loopback socket address, a loopback
 * Host header, no forwarding header, and same-origin browser markers.
 * `allowProxiedRequests` (plugin config, default off) admits a forwarded
 * request that still landed on this machine's loopback upstream.
 */

/** IPv4 127/8 predicate. */
export function isIPv4Loopback(v4) {
  const parts = v4.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Whether a socket remote address names the loopback range. */
export function isLoopbackAddress(address) {
  if (address === undefined) return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
  return isIPv4Loopback(normalized)
}

/** Whether a URL hostname names the loopback authority. */
export function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/** Whether a forwarding header was stamped by an intermediate proxy. */
export function isProxiedRequest(request) {
  return request.headers['cf-connecting-ip'] !== undefined
    || request.headers['x-forwarded-for'] !== undefined
}

/**
 * Direct-connection fence: loopback socket, loopback Host, no forwarding hop,
 * and same-origin browser markers.
 * @param {import('node:http').IncomingMessage} request - node HTTP request.
 * @returns {boolean} true when the request may reach the route family.
 */
export function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket.remoteAddress)) return false
  if (isProxiedRequest(request)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL('http://' + host)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/**
 * Relaxed fence for an operator-owned reverse proxy: a forwarding header, a
 * loopback socket, and a loopback Host header all hold.
 * @param {import('node:http').IncomingMessage} request - node HTTP request.
 * @returns {boolean} true when the forwarded request landed on this machine.
 */
export function isForwardedLoopbackRequest(request) {
  if (!isProxiedRequest(request)) return false
  if (!isLoopbackAddress(request.socket.remoteAddress)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  try {
    return isLoopbackHostname(new URL('http://' + host).hostname)
  } catch {
    return false
  }
}

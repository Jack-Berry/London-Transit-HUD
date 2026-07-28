import { createServer, type ServerResponse } from 'node:http'

const UPSTREAM_ORIGIN = 'https://api.tfl.gov.uk'
const GEOCODE_ORIGIN = 'https://photon.komoot.io'
const UPSTREAM_TIMEOUT_MS = 15_000
const DEFAULT_PORT = 8100
const ALLOWED_PATH_PREFIXES = [
  'Journey/JourneyResults/',
  'Line/Mode/',
  'StopPoint/Search/',
] as const

const appKey = readAppKey()
const port = parsePort(process.env.PORT)

function readAppKey(): string {
  const value = process.env.TFL_APP_KEY
  if (!value) {
    console.error('Required TfL API key is not configured')
    process.exit(1)
  }

  return value
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === '') {
    return DEFAULT_PORT
  }

  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    console.error('PORT must be an integer between 1 and 65535')
    process.exit(1)
  }

  return parsed
}

function setCorsHeaders(response: ServerResponse): void {
  response.setHeader('Access-Control-Allow-Origin', '*')
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  setCorsHeaders(response)
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.end(JSON.stringify(body))
}

function logRequest(method: string, path: string, status: number): void {
  console.log(`${method} ${path} ${status}`)
}

function isAllowedPath(path: string): boolean {
  return ALLOWED_PATH_PREFIXES.some(prefix => path.startsWith(prefix))
}

function redactKey(body: string): string {
  return body.replaceAll(appKey, '[redacted]')
}

async function forwardJson(
  response: ServerResponse,
  method: string,
  path: string,
  upstreamUrl: URL,
): Promise<void> {
  const abortController = new AbortController()
  const timeout = setTimeout(() => abortController.abort(), UPSTREAM_TIMEOUT_MS)

  try {
    const upstreamResponse = await fetch(upstreamUrl, {
      method: 'GET',
      signal: abortController.signal,
    })
    const upstreamBody = redactKey(await upstreamResponse.text())

    setCorsHeaders(response)
    response.statusCode = upstreamResponse.status

    const contentType = upstreamResponse.headers.get('content-type')
    if (contentType !== null) {
      response.setHeader('content-type', contentType)
    }

    response.end(upstreamBody)
    logRequest(method, path, upstreamResponse.status)
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      sendJson(response, 504, { error: 'Upstream timeout' })
      logRequest(method, path, 504)
    } else {
      sendJson(response, 502, { error: 'Upstream unavailable' })
      logRequest(method, path, 502)
    }
  } finally {
    clearTimeout(timeout)
  }
}

const server = createServer(async (request, response) => {
  const method = request.method ?? 'GET'
  let requestUrl: URL

  try {
    requestUrl = new URL(request.url ?? '/', 'http://localhost')
  } catch {
    sendJson(response, 400, { error: 'Bad request' })
    logRequest(method, '/', 400)
    return
  }

  const path = requestUrl.pathname

  if (method === 'OPTIONS') {
    setCorsHeaders(response)
    response.setHeader('Access-Control-Allow-Methods', 'GET')
    response.setHeader('Access-Control-Allow-Headers', '*')
    response.statusCode = 204
    response.end()
    logRequest(method, path, 204)
    return
  }

  if (method !== 'GET') {
    sendJson(response, 405, { error: 'Method not allowed' })
    logRequest(method, path, 405)
    return
  }

  if (path === '/healthz') {
    sendJson(response, 200, { ok: true })
    logRequest(method, path, 200)
    return
  }

  if (path === '/geocode') {
    const query = requestUrl.searchParams.get('q')?.trim()
    if (!query) {
      sendJson(response, 400, { error: 'Search query is required' })
      logRequest(method, path, 400)
      return
    }

    const geocodeUrl = new URL('/api/', GEOCODE_ORIGIN)
    geocodeUrl.searchParams.set('q', query)
    geocodeUrl.searchParams.set('limit', '6')
    geocodeUrl.searchParams.set('lat', '51.5074')
    geocodeUrl.searchParams.set('lon', '-0.1278')
    await forwardJson(response, method, path, geocodeUrl)
    return
  }

  if (!path.startsWith('/tfl/')) {
    sendJson(response, 404, { error: 'Not found' })
    logRequest(method, path, 404)
    return
  }

  const upstreamPath = path.slice('/tfl/'.length)
  if (!isAllowedPath(upstreamPath)) {
    sendJson(response, 404, { error: 'Not found' })
    logRequest(method, path, 404)
    return
  }

  const upstreamUrl = new URL(upstreamPath, `${UPSTREAM_ORIGIN}/`)
  requestUrl.searchParams.forEach((value, key) => {
    if (key !== 'app_key') {
      upstreamUrl.searchParams.append(key, value)
    }
  })
  upstreamUrl.searchParams.set('app_key', appKey)

  await forwardJson(response, method, path, upstreamUrl)
})

server.listen(port, () => {
  console.log(`Transit proxy listening on port ${port}`)
})

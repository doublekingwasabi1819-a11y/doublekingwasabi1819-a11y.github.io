import {createServer} from 'node:http';
import {createMcpHandler, hostHeaderValidationResponse} from '@modelcontextprotocol/server';
import {createControllerMcp} from './mcp-adapter.mjs';

const methods = new Set(['initialize', 'notifications/initialized', 'ping',
  'server/discover', 'tools/list', 'tools/call']);
const loopback = new Set(['127.0.0.1', 'localhost', '::1']);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const authenticationMessages = {AUTH_REQUIRED: 'Authentication is required.',
  FORBIDDEN: 'This connection is not authorized.'};

/** Trusted authenticators may distinguish an absent credential from denied scope. */
export class HttpAuthenticationError extends Error {
  constructor(code = 'AUTH_REQUIRED') {
    super(authenticationMessages[code] || authenticationMessages.AUTH_REQUIRED);
    this.code = code === 'FORBIDDEN' ? code : 'AUTH_REQUIRED';
  }
}

const rejected = (status, message, headers = {}) => new Response(JSON.stringify({error: message}), {
  status, headers: {'content-type': 'application/json', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'", ...headers}
});
const integer = (value, minimum, maximum) => Number.isInteger(value) && value >= minimum && value <= maximum;
function secureResponse(response) {
  const headers = new Headers(response.headers);
  headers.set('cache-control', 'no-store'); headers.set('x-content-type-options', 'nosniff');
  if (!headers.has('content-security-policy')) headers.set('content-security-policy',
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  return new Response(response.body, {status: response.status, headers});
}

/**
 * Opt-in, stateless Streamable HTTP host. Nothing listens at import time.
 * authenticate(Request) must verify each request and return a server-derived
 * {principalId, requestContext}. requestContext is a stable, authority-free host
 * object: controller.authorize must resolve current authority on every action.
 * Never use a credential snapshot or model-provided identity as that context.
 * Each principal gets fresh MCP instances but shares the caller-owned controller.
 * Closing HTTP transports never shuts down another principal's browser session.
 * Trusted authenticate/route/tool hooks must implement their own deadlines and
 * cancellation. maxRequests bounds concurrency; close awaits in-flight hooks,
 * so it cannot promise bounded shutdown for an indefinitely hung host callback.
 */
export function createControllerHttp({controller, authenticate, serverFactory,
  allowedHostnames = ['127.0.0.1', 'localhost', '[::1]'], allowedOrigins = [],
  endpoint = '/mcp', maxBodyBytes = 65536, maxContexts = 32, maxRequests = 16,
  contextTTL = 60000, now = Date.now, routes = {}, publicRoutes = {}} = {}) {
  if (typeof authenticate !== 'function' ||
      (serverFactory !== undefined && typeof serverFactory !== 'function') ||
      (!serverFactory && (!controller || typeof controller.callTool !== 'function')) ||
      typeof now !== 'function' || !integer(maxBodyBytes, 256, 1048576) ||
      !integer(maxContexts, 1, 1024) || !integer(maxRequests, 1, 128) ||
      !integer(contextTTL, 1000, 3600000) || !/^\/[A-Za-z0-9_/-]{1,100}$/.test(endpoint) ||
      !Array.isArray(allowedHostnames) || !allowedHostnames.length ||
      allowedHostnames.some(name => typeof name !== 'string' || !/^(?:[A-Za-z0-9.-]+|\[::1\])$/.test(name)) ||
      !plain(routes) || Object.entries(routes).some(([path, route]) =>
        !/^\/[A-Za-z0-9_/-]{1,100}$/.test(path) || path === endpoint || !plain(route) ||
        typeof route.handler !== 'function' || !Array.isArray(route.methods) || !route.methods.length ||
        route.methods.some(method => !['GET', 'POST'].includes(method))) ||
      !plain(publicRoutes) || Object.entries(publicRoutes).some(([path, route]) =>
        !/^\/[A-Za-z0-9_/-]{1,100}$/.test(path) || path === endpoint || Object.hasOwn(routes, path) ||
        !plain(route) || Object.keys(route).some(key => !['body', 'contentType', 'headers'].includes(key)) ||
        typeof route.body !== 'string' || Buffer.byteLength(route.body) > 262144 ||
        route.contentType !== 'text/html' || (route.headers !== undefined && (!plain(route.headers) ||
          Object.keys(route.headers).some(key => key !== 'content-security-policy') ||
          Object.values(route.headers).some(value => typeof value !== 'string' || /[\r\n]/.test(value))))) ||
      !Array.isArray(allowedOrigins) || allowedOrigins.some(origin => {
        try {const url = new URL(origin); return !['http:', 'https:'].includes(url.protocol) || url.origin !== origin;}
        catch {return true;}
      })) throw new TypeError('An explicit authenticator, server factory and valid HTTP limits are required.');

  const hostnames = [...allowedHostnames], origins = new Set(allowedOrigins), contexts = new Map();
  const extraRoutes = new Map(Object.entries(routes).map(([path, route]) =>
    [path, {methods: new Set(route.methods), handler: route.handler}]));
  // An explicitly public route can only contain bounded static HTML. It never
  // receives credentials, an authenticated context, or a private route callback.
  const staticRoutes = new Map(Object.entries(publicRoutes).map(([path, route]) =>
    [path, {body: route.body, contentType: route.contentType, headers: {...route.headers}}]));
  const factory = serverFactory || (requestContext => createControllerMcp({controller, requestContext}));
  let closed = false, active = 0, nodeServer, cancelStartup;
  const inFlight = new Set();

  async function expire() {
    const expired = [...contexts.entries()].filter(([, entry]) => !entry.active &&
      (now() - entry.lastUsed > contextTTL || now() < entry.lastUsed));
    for (const [principal, entry] of expired) {
      if (contexts.get(principal) !== entry || entry.active) continue;
      contexts.delete(principal); await entry.handler.close();
    }
  }

  async function serve(request) {
    if (closed) return rejected(503, 'This endpoint is unavailable.');
    let url;
    try {url = new URL(request.url);} catch {return rejected(400, 'Invalid request.');}
    const route = extraRoutes.get(url.pathname), staticRoute = staticRoutes.get(url.pathname);
    if ((!route && !staticRoute && url.pathname !== endpoint) || url.search || url.hash) return rejected(404, 'Endpoint unavailable.');
    if (hostHeaderValidationResponse(request, hostnames) ||
        !hostnames.includes(url.hostname)) return rejected(403, 'Request host is not allowed.');
    const origin = request.headers.get('origin');
    if (origin !== null && !origins.has(origin)) return rejected(403, 'Request origin is not allowed.');
    const allowedMethods = route?.methods || new Set([staticRoute ? 'GET' : 'POST']);
    if (!allowedMethods.has(request.method)) return rejected(405, 'This HTTP method is not supported.',
      {allow: [...allowedMethods].join(', ')});
    if (request.method === 'POST' && !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') || '')) {
      return rejected(415, 'A JSON request is required.');
    }
    const length = request.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBodyBytes)) {
      return rejected(413, 'Request body exceeds the limit.');
    }
    if (request.method === 'GET' && ((length !== null && Number(length) !== 0) ||
        request.headers.has('transfer-encoding'))) return rejected(400, 'A GET request cannot contain a body.');
    if (active >= maxRequests) return rejected(429, 'Concurrent request limit reached.');
    active++;
    let entry, entered = false;
    try {
      if (staticRoute) return secureResponse(new Response(staticRoute.body,
        {headers: {'content-type': staticRoute.contentType, ...staticRoute.headers}}));
      let identity;
      try {identity = await authenticate(request);}
      catch (error) {
        const forbidden = error instanceof HttpAuthenticationError && error.code === 'FORBIDDEN';
        return rejected(forbidden ? 403 : 401,
          forbidden ? authenticationMessages.FORBIDDEN : authenticationMessages.AUTH_REQUIRED);
      }
      if (!plain(identity) || typeof identity.principalId !== 'string' ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(identity.principalId) || !plain(identity.requestContext)) {
        return rejected(401, authenticationMessages.AUTH_REQUIRED);
      }
      const reader = request.body?.getReader();
      const chunks = []; let bytes = 0;
      if (reader) {
        try {
          while (true) {
            const {done, value} = await reader.read(); if (done) break;
            bytes += value.byteLength;
            if (bytes > maxBodyBytes) {await reader.cancel(); return rejected(413, 'Request body exceeds the limit.');}
            chunks.push(value);
          }
        } finally {reader.releaseLock();}
      }
      const rawBody = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)));
      let body;
      if (request.method === 'POST') {
        try {body = JSON.parse(rawBody.toString('utf8'));}
        catch {return rejected(400, 'Invalid JSON request.');}
      } else if (bytes) return rejected(400, 'A GET request cannot contain a body.');
      // No subscriptions, batches or arbitrary JSON-RPC methods can hold streams
      // open or expand the host beyond this advertised tool surface.
      if (!route && (!plain(body) || !methods.has(body.method))) return rejected(400, 'Unsupported MCP request.');
      await expire();
      entry = contexts.get(identity.principalId);
      if (!entry) {
        if (contexts.size >= maxContexts) return rejected(429, 'Authenticated connection limit reached.');
        const context = identity.requestContext;
        entry = {context, active: 0, lastUsed: now(), handler: createMcpHandler(
          () => factory(context), {legacy: 'stateless', responseMode: 'json',
            maxRequestBodySize: maxBodyBytes, maxSubscriptions: 1, keepAliveMs: 0,
            onerror() { /* SDK errors may contain private details; do not log them. */ }}
        )};
        contexts.set(identity.principalId, entry);
      } else if (entry.context !== identity.requestContext) {
        // A principal ID must never silently inherit a different run/context.
        return rejected(403, 'The host authentication context changed.');
      }
      entry.active++; entered = true; entry.lastUsed = now();
      let response;
      try {
        response = route ? await route.handler(new Request(request, request.method === 'POST' ?
          {body: rawBody} : {}), entry.context) : await entry.handler.fetch(request, {parsedBody: body});
        if (!(response instanceof Response)) throw new TypeError('Invalid trusted route response.');
      }
      catch {return rejected(500, 'The MCP request could not be completed.');}
      return secureResponse(response);
    } catch {return rejected(500, 'The MCP request could not be completed.');}
    finally {active--; if (entered) {entry.active--; entry.lastUsed = now();}}
  }

  function fetch(request) {
    const operation = serve(request); inFlight.add(operation);
    operation.finally(() => inFlight.delete(operation)); return operation;
  }

  async function listen({host = '127.0.0.1', port = 0} = {}) {
    if (closed || nodeServer || !loopback.has(host) || !integer(port, 0, 65535)) {
      throw new TypeError('Explicit loopback HTTP configuration is required.');
    }
    const server = createServer({maxHeaderSize: 8192}, async (req, res) => {
      const authority = req.headers.host || '';
      try {
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) if (value !== undefined) {
          headers.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
        const request = new Request(`http://${authority}${req.url}`, {method: req.method, headers,
          ...(req.method === 'POST' ? {body: req, duplex: 'half'} : {})});
        const response = await fetch(request);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        // This surface excludes listen streams; JSON exchanges have bounded
        // input and the controller bounds image/output data separately.
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch {
        if (!res.headersSent) res.writeHead(400, {'content-type': 'application/json', 'cache-control': 'no-store'});
        res.end('{"error":"Invalid request."}');
      }
    });
    nodeServer = server;
    server.headersTimeout = 10000; server.requestTimeout = 15000;
    server.keepAliveTimeout = 1000;
    // Runtime server errors must not become uncaught exceptions or log private
    // details. Startup errors also reach the bounded listener below.
    server.on('error', () => {});
    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        const finish = error => {
          if (settled) return;
          settled = true;
          server.off('error', onError); server.off('listening', onListening);
          if (cancelStartup === cancel) cancelStartup = undefined;
          error ? reject(error) : resolve();
        };
        const onError = error => finish(error), onListening = () => finish();
        const cancel = () => finish(new TypeError('The HTTP host closed during startup.'));
        cancelStartup = cancel;
        server.once('error', onError); server.once('listening', onListening);
        try {server.listen(port, host);} catch (error) {finish(error);}
      });
      if (closed) throw new TypeError('The HTTP host closed during startup.');
    } catch (error) {
      // A failed candidate cannot hold the listener slot or erase a newer one.
      if (nodeServer === server) nodeServer = undefined;
      throw error;
    }
    const address = server.address();
    const url = `http://${host === '::1' ? '[::1]' : host}:${address.port}${endpoint}`;
    // Browser POSTs to our own loopback viewer include Origin. Admit only the
    // exact listening origin, including its actual port; unrelated localhost
    // services and cross-origin websites remain denied.
    origins.add(new URL(url).origin);
    return {url};
  }

  async function close() {
    closed = true;
    const server = nodeServer;
    // Closing a not-yet-listening Node server can cancel its bind without
    // emitting listening/error. Explicitly settle the caller's startup first.
    cancelStartup?.();
    const shutdown = server ? new Promise(resolve => {
      server.close(resolve); server.closeIdleConnections();
    }) : Promise.resolve();
    await Promise.all([...contexts.values()].map(entry => entry.handler.close()));
    await Promise.allSettled([...inFlight]);
    contexts.clear(); await shutdown;
  }
  return Object.freeze({fetch, listen, close});
}

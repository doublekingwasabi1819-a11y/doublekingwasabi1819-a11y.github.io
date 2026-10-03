import {createHash} from 'node:crypto';
import {getOAuthProtectedResourceMetadataUrl} from '@modelcontextprotocol/server';
import {HttpAuthenticationError} from './http-server.mjs';

const plain = value => value && typeof value === 'object' &&
  Object.getPrototypeOf(value) === Object.prototype;
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const scopeName = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_./-]{0,127}$/.test(value);
const sha = value => createHash('sha256').update(value).digest('hex');
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const denied = () => new HttpAuthenticationError();
const headers = {'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"};
const jsonResponse = (status, value, extra = {}) => new Response(JSON.stringify(value), {
  status, headers: {...headers, 'content-type': 'application/json', ...extra}
});

function httpsIdentifier(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new TypeError('Canonical HTTPS OAuth configuration is required.');
  let url;
  try {url = new URL(value);} catch {throw new TypeError('Canonical HTTPS OAuth configuration is required.');}
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search ||
      !(url.href === value || (url.pathname === '/' && url.href === `${value}/`))) {
    throw new TypeError('Canonical HTTPS OAuth configuration is required.');
  }
  return url;
}

function scopes(value) {
  if (typeof value !== 'string' || value.length > 4096) throw denied();
  const entries = value ? value.split(' ') : [];
  if (entries.length > 32 || entries.some(entry => !scopeName(entry)) || new Set(entries).size !== entries.length) throw denied();
  return entries.sort();
}

/**
 * OAuth RESOURCE-server seam only. This module does not issue tokens, codes,
 * signing keys, client registrations, authorization endpoints or AS discovery.
 * A real provider must publish discovery, S256 PKCE and a supported client
 * registration method (CIMD/DCR/predefined client) before ChatGPT linking works.
 *
 * verifyAccessToken(token, {signal, resource, issuers}) MUST cryptographically
 * validate the provider token or securely introspect it on EVERY request. A JWT
 * decode or caller-supplied claims are not verification. The hook returns
 * {claims, principalId, requestContext}; claims are the VERIFIED iss/sub/aud/
 * exp/nbf/scope/jti identity, principalId is a unique server-owned OAuth lease,
 * and requestContext is its stable frozen authority-free {grantId} reference.
 * These are OAuth identity references, not private browser grants. A verifier
 * used by oauth-bridge MUST NOT mint browser grants or resolve Relay credentials;
 * bridge mapping happens only after the verified claims and request scopes pass.
 * Relay credentials are resolved separately by that host grant, never forwarded
 * from an incoming OAuth token. Browser permission still needs live host checks.
 * Any downstream host mapping must intersect VERIFIED scopes with the host's
 * allowed browser/Relay permissions. A browser-only OAuth scope must never map
 * to a global/full-write Relay reference. This file does not automatically wire
 * OAuth into an existing private host or make scope-to-grant decisions for it.
 *
 * The bounded hash-only cache supports onRevoke for a previously verified token
 * rejected on a later request. Host lifecycle must ALSO schedule grant expiry
 * and provider revocation when no subsequent request arrives. onRevoke is an
 * external lifecycle callback: never await it from inside a controller queue.
 * Provider/lifecycle hooks must honor cancellation and have bounded deadlines.
 */
export function createOAuthResource({resource, issuers, scopesSupported = ['browser:control'],
  requiredScopes = ['browser:control'], verifyAccessToken, onRevoke,
  allowedOrigins = [], verificationTimeout = 5000, maxVerifiedTokens = 64, now = Date.now} = {}) {
  const resourceUrl = httpsIdentifier(resource);
  if (!Array.isArray(issuers) || !issuers.length || issuers.length > 8 ||
      new Set(issuers).size !== issuers.length) throw new TypeError('Explicit OAuth issuers are required.');
  for (const issuer of issuers) httpsIdentifier(issuer);
  if (typeof verifyAccessToken !== 'function' || (onRevoke !== undefined && typeof onRevoke !== 'function') ||
      typeof now !== 'function' || !integer(verificationTimeout, 10, 30000) ||
      !integer(maxVerifiedTokens, 1, 1024) ||
      !Array.isArray(scopesSupported) || !scopesSupported.length || scopesSupported.length > 32 ||
      scopesSupported.some(value => !scopeName(value)) || new Set(scopesSupported).size !== scopesSupported.length ||
      !Array.isArray(requiredScopes) || !requiredScopes.length || requiredScopes.length > 32 ||
      requiredScopes.some(value => !scopesSupported.includes(value)) || new Set(requiredScopes).size !== requiredScopes.length ||
      !Array.isArray(allowedOrigins) || allowedOrigins.some(value => {
        try {return httpsIdentifier(value).origin !== value;} catch {return true;}
      })) throw new TypeError('A trusted OAuth verifier and bounded resource policy are required.');

  const issuerSet = new Set(issuers), supported = [...scopesSupported], required = [...requiredScopes];
  const origins = new Set([resourceUrl.origin, ...allowedOrigins]);
  const metadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl);
  const metadataPath = new URL(metadataUrl).pathname;
  const metadata = Object.freeze({resource, authorization_servers: Object.freeze([...issuers]),
    scopes_supported: Object.freeze(supported), bearer_methods_supported: Object.freeze(['header'])});
  const toolSecuritySchemes = Object.freeze([Object.freeze({type: 'oauth2', scopes: Object.freeze(required)})]);
  const verified = new Map(), contextGrants = new WeakMap(), retiredContexts = new WeakSet();

  function requestGate(request) {
    let url;
    try {url = new URL(request.url);} catch {return jsonResponse(400, {error: 'Invalid request.'});}
    // URL origin must be supplied by a trusted HTTPS runtime/front end. Never
    // infer it from X-Forwarded-* headers sent by an arbitrary HTTP client.
    if (url.protocol !== 'https:' || url.origin !== resourceUrl.origin ||
        request.headers.get('host') !== resourceUrl.host || url.username || url.password) {
      return jsonResponse(403, {error: 'Request host is not allowed.'});
    }
    const origin = request.headers.get('origin');
    if (origin !== null && !origins.has(origin)) return jsonResponse(403, {error: 'Request origin is not allowed.'});
    return undefined;
  }

  function challenge(code = 'AUTH_REQUIRED') {
    const insufficient = code === 'FORBIDDEN';
    return `Bearer resource_metadata="${metadataUrl}", scope="${required.join(' ')}", ` +
      `error="${insufficient ? 'insufficient_scope' : 'invalid_token'}", ` +
      `error_description="${insufficient ? 'Required permission is missing.' : 'A valid access token is required.'}"`;
  }

  async function retire(tokenHash) {
    const prior = verified.get(tokenHash); if (!prior) return;
    prior.revoked = true;
    // A stable grant context is terminal once retired. Outstanding verifier
    // calls cannot resurrect it after successful cleanup removed the token
    // entry, even if another successful request had refreshed that entry.
    // Reconnection/renewal requires a fresh, independently authorized context.
    retiredContexts.add(prior.requestContext);
    if (prior.retiring) return prior.retiring;
    prior.retiring = (async () => {
      if (onRevoke) {
        try {if ((await onRevoke(prior.requestContext))?.isError === true) return;} catch {return;}
      }
      if (verified.get(tokenHash) === prior) verified.delete(tokenHash);
    })();
    try {await prior.retiring;} finally {prior.retiring = null;}
  }

  async function provider(token) {
    const abort = new AbortController(); let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => verifyAccessToken(token, {
          signal: abort.signal, resource, issuers: Object.freeze([...issuerSet])
        })),
        new Promise((_, reject) => {timer = setTimeout(() => {abort.abort(); reject(denied());}, verificationTimeout);})
      ]);
    } finally {clearTimeout(timer);}
  }

  function identityFor(value) {
    if (!plain(value) || !plain(value.claims) || !opaque(value.principalId) ||
        !plain(value.requestContext) || !Object.isFrozen(value.requestContext) ||
        Object.keys(value.requestContext).length !== 1 || !Object.hasOwn(value.requestContext, 'grantId') ||
        !opaque(value.requestContext.grantId) || retiredContexts.has(value.requestContext)) throw denied();
    const claims = value.claims;
    const timestamp = now();
    if (Object.keys(claims).length > 32 || Buffer.byteLength(JSON.stringify(claims)) > 8192 ||
        !integer(timestamp, 0, Number.MAX_SAFE_INTEGER) ||
        !issuerSet.has(claims.iss) || typeof claims.sub !== 'string' || !claims.sub.length || claims.sub.length > 256 ||
        !integer(claims.exp, 1, Math.floor(Number.MAX_SAFE_INTEGER / 1000)) || claims.exp <= timestamp / 1000 ||
        (claims.active !== undefined && claims.active !== true) ||
        (claims.nbf !== undefined && (!integer(claims.nbf, 0, Number.MAX_SAFE_INTEGER) ||
          claims.nbf > timestamp / 1000 || claims.nbf >= claims.exp)) ||
        (claims.jti !== undefined && (typeof claims.jti !== 'string' || !claims.jti.length || claims.jti.length > 256))) throw denied();
    const audiences = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
    if (!Array.isArray(audiences) || !audiences.length || audiences.length > 8 ||
        audiences.some(audience => typeof audience !== 'string' || !audience.length || audience.length > 2048) ||
        !audiences.includes(resource) || new Set(audiences).size !== audiences.length) throw denied();
    const grantedScopes = scopes(claims.scope);
    if (required.some(scope => !grantedScopes.includes(scope))) throw new HttpAuthenticationError('FORBIDDEN');
    const principalId = sha(JSON.stringify([claims.iss, claims.sub, value.principalId,
      value.requestContext.grantId, claims.exp, claims.jti || null, grantedScopes]));
    const previous = contextGrants.get(value.requestContext);
    if (previous && previous !== principalId) throw denied();
    return {principalId, requestContext: value.requestContext, expiresAt: claims.exp * 1000,
      scopes: Object.freeze([...grantedScopes])};
  }

  async function authenticateGrant(request) {
    if (requestGate(request)) throw new HttpAuthenticationError('FORBIDDEN');
    const raw = request.headers.get('authorization') || '';
    const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(raw);
    if (!match || match[1].length > 8192) throw denied();
    const token = match[1], tokenHash = sha(token);
    if (verified.get(tokenHash)?.revoked) {await retire(tokenHash); throw denied();}
    try {
      const identity = identityFor(await provider(token));
      const previous = verified.get(tokenHash);
      if (previous && (previous.revoked || previous.principalId !== identity.principalId ||
          previous.requestContext !== identity.requestContext)) throw denied();
      for (const [hash, prior] of verified) if (prior.expiresAt <= now()) await retire(hash);
      const latest = verified.get(tokenHash);
      if (retiredContexts.has(identity.requestContext) || identity.expiresAt <= now() || (latest && (latest.revoked ||
          latest.principalId !== identity.principalId || latest.requestContext !== identity.requestContext))) throw denied();
      if (!verified.has(tokenHash) && verified.size >= maxVerifiedTokens) throw denied();
      // Expired-token cleanup above can yield while another request pins this
      // context. Recheck immediately before committing, with no intervening await.
      const pinnedPrincipal = contextGrants.get(identity.requestContext);
      if (pinnedPrincipal && pinnedPrincipal !== identity.principalId) throw denied();
      contextGrants.set(identity.requestContext, identity.principalId);
      if (!latest) verified.set(tokenHash, identity);
      return Object.freeze({principalId: identity.principalId, requestContext: identity.requestContext,
        scopes: identity.scopes, expiresAt: identity.expiresAt});
    } catch (error) {
      await retire(tokenHash);
      throw error instanceof HttpAuthenticationError && error.code === 'FORBIDDEN' ?
        new HttpAuthenticationError('FORBIDDEN') : denied();
    }
  }

  // Trusted resource composition only. Scopes and expiry are returned after
  // full provider/claim policy checks; the public request context stays opaque.
  async function authenticate(request) {
    const {principalId, requestContext} = await authenticateGrant(request);
    return {principalId, requestContext};
  }

  function wrapFetch(next) {
    if (typeof next !== 'function') throw new TypeError('A trusted downstream fetch handler is required.');
    return async request => {
      const rejected = requestGate(request); if (rejected) return rejected;
      const url = new URL(request.url);
      if (url.pathname === metadataPath) {
        if (url.search || url.hash) return jsonResponse(400, {error: 'Invalid metadata request.'});
        if (request.method !== 'GET') return jsonResponse(405, {error: 'Only GET is supported.'}, {allow: 'GET'});
        if (request.headers.has('transfer-encoding') ||
            (request.headers.has('content-length') && request.headers.get('content-length') !== '0') || request.body) {
          return jsonResponse(400, {error: 'Metadata requests cannot contain a body.'});
        }
        return jsonResponse(200, metadata);
      }
      let response;
      try {response = await next(request); if (!(response instanceof Response)) throw new Error();}
      catch {return jsonResponse(500, {error: 'The resource request could not be completed.'});}
      const responseHeaders = new Headers(response.headers);
      for (const [name, value] of Object.entries(headers)) {
        if (name !== 'content-security-policy' || !responseHeaders.has(name)) responseHeaders.set(name, value);
      }
      if ([401, 403].includes(response.status)) responseHeaders.set('www-authenticate',
        challenge(response.status === 403 ? 'FORBIDDEN' : 'AUTH_REQUIRED'));
      return new Response(response.body, {status: response.status, headers: responseHeaders});
    };
  }

  function toolAuthError(code = 'AUTH_REQUIRED') {
    const forbidden = code === 'FORBIDDEN', message = forbidden ? 'Required permission is missing.' : 'Authentication is required.';
    return {isError: true, structuredContent: {error: {code: forbidden ? 'FORBIDDEN' : 'AUTH_REQUIRED', message}},
      content: [{type: 'text', text: message}], _meta: {'mcp/www_authenticate': [challenge(code)]}};
  }
  return Object.freeze({authenticate, authenticateGrant, wrapFetch, metadataUrl, toolSecuritySchemes, toolAuthError});
}

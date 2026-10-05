import {createOAuthResource} from './oauth-resource.mjs';

const permissions = Object.freeze({browser_open:'browser:control', browser_observe:'browser:control',
  browser_click:'browser:control', browser_screenshot:'browser:control', browser_close:'browser:control',
  relay_fast_identity:'relay:read', relay_fast_inbox:'relay:read', relay_fast_thread:'relay:read',
  relay_fast_send:'relay:write', relay_fast_mark_read:'relay:write'});
const scopeNames = Object.freeze(['browser:control','relay:read','relay:write']);
const methods = new Set(['initialize','notifications/initialized','ping','server/discover','tools/list','tools/call']);
const plain = value => value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const integer = (value,min,max) => Number.isSafeInteger(value) && value>=min && value<=max;
const failure = (code='AUTH_REQUIRED') => Object.assign(new Error('The OAuth browser connection is unavailable.'),{code});
const headers = {'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff',
  'content-security-policy':"default-src 'none'; frame-ancestors 'none'; base-uri 'none'"};
const reply = (status,error,extra={}) => new Response(JSON.stringify({error}),{status,headers:{...headers,...extra}});
function bounded(operation,timeout,signalCallback){
  const abort=new AbortController();let timer;
  return Promise.race([Promise.resolve().then(()=>operation(abort.signal)),new Promise((_,reject)=>{
    timer=setTimeout(()=>{abort.abort();signalCallback?.();reject(failure('TIMEOUT'));},timeout);
  })]).finally(()=>clearTimeout(timer));
}
function jsonTree(value,depth=0,state={nodes:0}){
  if(depth>16||++state.nodes>2048)return false;
  if(value===null||['string','boolean'].includes(typeof value))return true;
  if(typeof value==='number')return Number.isFinite(value);
  if(!Array.isArray(value)&&!plain(value))return false;
  return Object.values(value).every(child=>jsonTree(child,depth+1,state));
}

/** Source-only OAuth-to-private-host composition. Import/factory never listens,
 * signs in, delegates an account, issues OAuth tokens or activates a plugin.
 * verifyAccessToken has the createOAuthResource contract and MUST NOT map Relay
 * credentials or mint browser grants. resolveHostReference runs only after
 * verified claims AND this exact request's scopes pass. It returns a frozen,
 * plain, permanently scope-limited server reference to the same worker/run.
 * The private host's live resolvers must enforce that permanent reference and
 * intersect these OAuth scopes with its own delegated permissions on every use.
 *
 * Internal opaque bearers necessarily remain in bounded process memory while
 * forwarding; only createBrowserGrants stores their digests. They are never
 * logged, persisted, returned, derived from OAuth or sent to Relay. The supplied
 * reviewed host must enforce its existing body/result/authority limits and use
 * the exact HTTPS front-end origin/Host. No forwarded-header trust is added.
 * The bridge serves MCP and resource metadata ONLY. The separate private viewer
 * retains its own opaque authentication; this module is not an OAuth viewer UI.
 *
 * Host/provider hooks must honor cancellation and bounded shutdown. A timeout
 * denies access and quarantines cleanup; it cannot kill a hung browser process.
 * Shared grants for one worker/run still share the existing worker browser.
 */
export function createOAuthGrantBridge({host,resource,issuers,verifyAccessToken,resolveHostReference,
  now=Date.now,maxGrants=32,maxRequests=16,maxBodyBytes=65536,maxGrantTTL=3600000,
  mapTimeout=5000,cleanupTimeout=5000,forwardTimeout=30000,verificationTimeout=5000}={}){
  if(!host||['fetch','issueGrant','revokeGrant','close'].some(key=>typeof host[key]!=='function')||
    typeof resolveHostReference!=='function'||typeof now!=='function'||!integer(maxGrants,1,32)||
    !integer(maxRequests,1,128)||!integer(maxBodyBytes,256,65536)||!integer(maxGrantTTL,1000,3600000)||
    [mapTimeout,cleanupTimeout,forwardTimeout].some(value=>!integer(value,10,30000)))throw new TypeError('Explicit reviewed host capabilities and bounded OAuth bridge hooks are required.');
  const source=Object.fromEntries(['fetch','issueGrant','revokeGrant','close'].map(key=>[key,host[key].bind(host)]));
  const records=new Map(),retired=new WeakSet(),inFlight=new Set();let closed=false,active=0;
  const oauth=createOAuthResource({resource,issuers,verifyAccessToken,now,verificationTimeout,
    scopesSupported:scopeNames,requiredScopes:['browser:control'],maxVerifiedTokens:maxGrants,
    onRevoke:context=>revokeContext(context)});
  const url=new URL(resource),metadataPath=new URL(oauth.metadataUrl).pathname;
  if(url.pathname==='/'||url.search||url.hash)throw new TypeError('An explicit HTTPS MCP endpoint is required.');
  const metadataFetch=oauth.wrapFetch(async()=>reply(404,'Endpoint unavailable.'));
  function challenge(scope,code='AUTH_REQUIRED'){
    const required=[...new Set(['browser:control',scope])];
    return `Bearer resource_metadata="${oauth.metadataUrl}", scope="${required.join(' ')}", error="${code==='FORBIDDEN'?'insufficient_scope':'invalid_token'}", error_description="${code==='FORBIDDEN'?'Required permission is missing.':'A valid access token is required.'}"`;
  }
  function authReply(scope,code='AUTH_REQUIRED'){return reply(code==='FORBIDDEN'?403:401,
    code==='FORBIDDEN'?'Required permission is missing.':'Authentication is required.',{'www-authenticate':challenge(scope,code)});}
  function toolDenied(body,scope){
    const message='Required permission is missing.';
    return new Response(JSON.stringify({jsonrpc:'2.0',id:body.id,result:{resultType:'complete',isError:true,
      structuredContent:{error:{code:'FORBIDDEN',message}},content:[{type:'text',text:message}],
      _meta:{'mcp/www_authenticate':[challenge(scope,'FORBIDDEN')]}}}),{status:200,headers});
  }
  function gate(request){
    const incoming=new URL(request.url);
    if(incoming.protocol!=='https:'||incoming.origin!==url.origin||request.headers.get('host')!==url.host||
      incoming.username||incoming.password)return reply(403,'Request host is not allowed.');
    const origin=request.headers.get('origin');if(origin!==null&&origin!==url.origin)return reply(403,'Request origin is not allowed.');
    if(incoming.search||incoming.hash)return reply(404,'Endpoint unavailable.');
    if(![url.pathname,metadataPath].includes(incoming.pathname))return reply(404,'Endpoint unavailable.');
  }
  async function retire(record){
    record.active=false;record.token=null;clearTimeout(record.timer);retired.add(record.context);
    if(record.cleaned)return;
    if(!record.grantId){if(records.get(record.context)===record)records.delete(record.context);return;}
    if(!record.cleanup){
      const cleanup=Promise.resolve().then(()=>source.revokeGrant(record.grantId)).then(result=>{
        if(result?.isError===true)throw new Error('Browser cleanup failed.');
        record.cleaned=true;
        if(records.get(record.context)===record)records.delete(record.context);
      });record.cleanup=cleanup;
      cleanup.then(()=>{if(record.cleanup===cleanup)record.cleanup=null;},()=>{if(record.cleanup===cleanup)record.cleanup=null;});
    }
    const pending=record.cleanup;await bounded(()=>pending,cleanupTimeout);
  }
  async function revokeContext(context){
    if(!context||typeof context!=='object')return {closed:false};
    retired.add(context);const record=records.get(context);if(!record)return {closed:false};
    try{await retire(record);return {closed:true};}catch{return {isError:true,closed:false};}
  }
  function current(record){if(closed||!record.active||retired.has(record.context)||!Number.isSafeInteger(now())||now()>=record.expiresAt)throw failure();}
  async function lease(identity){
    const context=identity.requestContext;
    if(closed||retired.has(context))throw failure();
    let record=records.get(context);
    if(record){
      if(record.principalId!==identity.principalId||record.oauthExpiry!==identity.expiresAt||
        JSON.stringify(record.scopes)!==JSON.stringify(identity.scopes))throw failure();
      try{current(record);}catch(error){await retire(record).catch(()=>{});throw error;}
      return record.mapping;
    }
    if(identity.expiresAt-now()<2000)throw failure();
    if(records.size>=maxGrants)throw failure('LIMIT');
    record={context,principalId:identity.principalId,scopes:identity.scopes,oauthExpiry:identity.expiresAt,
      expiresAt:Math.min(identity.expiresAt,now()+maxGrantTTL),active:true,token:null,grantId:null,timer:null,cleanup:null};
    records.set(context,record);
    record.mapping=(async()=>{
      try{
        const reference=await bounded(signal=>resolveHostReference(Object.freeze({...identity}),{signal}),mapTimeout);
        current(record);
        if(!plain(reference)||!Object.isFrozen(reference))throw failure();
        // The private grant API has a 1s minimum. Leave a 1s clock/issuance
        // margin, then reject if less than another full second remains.
        const ttlMs=Math.min(maxGrantTTL,Math.floor(identity.expiresAt-now()-1000));
        if(ttlMs<1000)throw failure();
        const grant=source.issueGrant({requestContext:reference,ttlMs});
        if(plain(grant)&&opaque(grant.grantId))record.grantId=grant.grantId;
        if(!plain(grant)||!opaque(grant.grantId)||typeof grant.token!=='string'||
          !/^[A-Za-z0-9_-]{32,128}$/.test(grant.token)||!integer(grant.expiresAt,1,Number.MAX_SAFE_INTEGER))throw failure('INTERNAL');
        record.token=grant.token;
        if(grant.expiresAt>identity.expiresAt||grant.expiresAt>now()+maxGrantTTL||grant.expiresAt<=now())throw failure();
        record.expiresAt=grant.expiresAt;current(record);
        record.timer=setTimeout(()=>{void retire(record).catch(()=>{});},Math.max(1,record.expiresAt-now()));record.timer.unref();
        return record;
      }catch(error){await retire(record).catch(()=>{});throw error?.code==='LIMIT'?error:failure();}
    })();
    return record.mapping;
  }
  async function readBody(request,signal){
    const length=request.headers.get('content-length');
    if(length!==null&&(!/^\d+$/.test(length)||Number(length)>maxBodyBytes))throw failure('BODY');
    const reader=request.body?.getReader(),parts=[];let bytes=0;
    const abort=()=>{void reader?.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
    if(reader)try{while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;
      if(bytes>maxBodyBytes){await reader.cancel();throw failure('BODY');}parts.push(Buffer.from(chunk.value));}}finally{signal.removeEventListener('abort',abort);reader.releaseLock();}
    if(signal.aborted)throw failure('BODY');
    return Buffer.concat(parts);
  }
  async function serve(request){
    if(closed)return reply(503,'This endpoint is unavailable.');
    const rejected=gate(request);if(rejected)return rejected;
    if(active>=maxRequests)return reply(429,'Concurrent request limit reached.');active++;
    let record,scope='browser:control';
    try{
      if(new URL(request.url).pathname===metadataPath)return await metadataFetch(request);
      if(request.method!=='POST')return reply(405,'Only POST is supported.',{allow:'POST'});
      if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type')||''))return reply(415,'A JSON request is required.');
      let bytes,body;
      try{bytes=await bounded(signal=>readBody(request,signal),mapTimeout);body=JSON.parse(bytes.toString('utf8'));}catch(error){return reply(error?.code==='TIMEOUT'?408:error?.code==='BODY'?413:400,'Invalid or oversized JSON request.');}
      if(!plain(body)||body.jsonrpc!=='2.0'||!methods.has(body.method)||!jsonTree(body)||
        Object.keys(body).some(key=>!['jsonrpc','id','method','params'].includes(key))||
        (body.params!==undefined&&!plain(body.params))||
        (body.method==='notifications/initialized'?Object.hasOwn(body,'id'):
          !(integer(body.id,0,Number.MAX_SAFE_INTEGER)||(typeof body.id==='string'&&body.id.length>0&&body.id.length<=128))))return reply(400,'Unsupported MCP request.');
      if(body.method==='tools/call'){
        if(!plain(body.params)||!Object.hasOwn(permissions,body.params.name)||
          Object.keys(body.params).some(key=>!['name','arguments','_meta'].includes(key)))return reply(400,'Unsupported MCP tool.');
        scope=permissions[body.params.name];
      }
      let identity;
      try{identity=await oauth.authenticateGrant(request);}catch(error){return authReply(scope,error?.code==='FORBIDDEN'?'FORBIDDEN':'AUTH_REQUIRED');}
      if(!identity.scopes.includes(scope))return body.method==='tools/call'?toolDenied(body,scope):authReply(scope,'FORBIDDEN');
      const scopedIdentity=Object.freeze({...identity,scopes:Object.freeze(identity.scopes.filter(value=>scopeNames.includes(value)))});
      record=await lease(scopedIdentity);current(record);
      const forwardedHeaders=new Headers(request.headers);forwardedHeaders.set('authorization',`Bearer ${record.token}`);
      const forwarded=new Request(request.url,{method:'POST',headers:forwardedHeaders,body:bytes});
      const response=await bounded(()=>source.fetch(forwarded),forwardTimeout,()=>{void retire(record).catch(()=>{});});
      current(record);if(!(response instanceof Response))throw failure('INTERNAL');
      const safe=new Headers(response.headers);safe.set('cache-control','no-store');safe.set('x-content-type-options','nosniff');
      if([401,403].includes(response.status))safe.set('www-authenticate',challenge(scope,response.status===403?'FORBIDDEN':'AUTH_REQUIRED'));
      return new Response(response.body,{status:response.status,headers:safe});
    }catch(error){
      if(record&&(!record.active||now()>=record.expiresAt))await retire(record).catch(()=>{});
      if(error?.code==='LIMIT')return reply(429,'Authenticated connection limit reached.');
      if(error?.code==='TIMEOUT')return reply(503,'The resource request could not be completed.');
      return authReply(scope);
    }finally{active--;}
  }
  function fetch(request){const operation=serve(request);inFlight.add(operation);operation.finally(()=>inFlight.delete(operation));return operation;}
  async function close(){
    closed=true;const results=await Promise.allSettled([...records.values()].map(retire));
    const shutdown=await Promise.allSettled([bounded(()=>source.close(),cleanupTimeout),
      bounded(()=>Promise.allSettled([...inFlight]),cleanupTimeout)]);
    if([...results,...shutdown].some(result=>result.status==='rejected'))throw new Error('OAuth browser bridge cleanup failed.');
  }
  return Object.freeze({fetch,revokeContext,close,metadataUrl:oauth.metadataUrl});
}

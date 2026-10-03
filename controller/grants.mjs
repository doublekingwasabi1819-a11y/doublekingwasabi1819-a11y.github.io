import {randomBytes,randomUUID,createHash,timingSafeEqual} from 'node:crypto';

const opaque=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const digest=value=>createHash('sha256').update(value).digest();
const plain=x=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
const denied=()=>{const error=new Error('Browser authentication is required.');error.code='AUTH_REQUIRED';return error;};
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x);
function canonical(value){if(!plain(value)||!opaque(value.workspaceId)||!uuid(value.accountId)||!uuid(value.agentId)||!opaque(value.runId))throw denied();return Object.freeze({workspaceId:value.workspaceId,accountId:value.accountId.toLowerCase(),agentId:value.agentId.toLowerCase(),runId:value.runId});}

/** Host-only, in-memory MCP grants. These are a separate credential audience
 * from Relay worker tokens. This is not an OAuth/discovery provider. */
export function createBrowserGrants({resolveBinding,onRevoke,now=Date.now,maxGrants=32,maxIssuances=1024}={}){
 if(typeof resolveBinding!=='function'||typeof onRevoke!=='function'||typeof now!=='function'||!Number.isInteger(maxGrants)||maxGrants<1||maxGrants>64||!Number.isInteger(maxIssuances)||maxIssuances<maxGrants||maxIssuances>65536)throw new TypeError('Trusted grant hooks and limits are required.');
 const records=new Map(),contexts=new WeakMap(),usedDigests=new Set();let closed=false;
 async function resolveRecord(record){const binding=canonical(await resolveBinding(record.requestContext));if(record.binding&&JSON.stringify(record.binding)!==JSON.stringify(binding))throw denied();record.binding=binding;return binding;}
 async function retire(record){
  if(record.retiring)return record.retiring;
  record.active=false;clearTimeout(record.timer);
  const cleanup=(async()=>{try{await onRevoke(record.context);records.delete(record.id);}catch{throw new Error('Browser grant cleanup failed.');}})();record.retiring=cleanup;
  try{return await cleanup;}catch{if(record.retiring===cleanup)record.retiring=null;throw new Error('Browser grant cleanup failed.');}
 }
 async function live(context,{waitForCleanup=false}={}){
  const record=context&&typeof context==='object'?contexts.get(context):undefined;
  if(closed||!record?.active)throw denied();
  if(now()>=record.expiresAt){const cleanup=retire(record);if(waitForCleanup)await cleanup;else void cleanup.catch(()=>{});throw denied();}
  return record;
 }
 return Object.freeze({
  issue({requestContext,ttlMs=3600000,token}={}){
   if(closed||!plain(requestContext)||!Number.isInteger(ttlMs)||ttlMs<1000||ttlMs>86400000||records.size>=maxGrants||usedDigests.size>=maxIssuances||(token!==undefined&&(typeof token!=='string'||!/^[A-Za-z0-9_-]{32,128}$/.test(token))))throw new TypeError('A bounded trusted MCP grant is required.');
   const credential=token||randomBytes(32).toString('base64url'),tokenDigest=digest(credential);
   const fingerprint=tokenDigest.toString('hex');if(usedDigests.has(fingerprint))throw new TypeError('A distinct MCP grant is required.');usedDigests.add(fingerprint);
   const id=randomUUID(),context=Object.freeze({grantId:id});
   const record={id,context,requestContext,tokenDigest,expiresAt:now()+ttlMs,active:true,timer:null,retiring:null};
   records.set(id,record);contexts.set(context,record);
   record.timer=setTimeout(()=>{void retire(record).catch(()=>{});},ttlMs);record.timer.unref();
   return Object.freeze({grantId:id,token:credential,expiresAt:record.expiresAt});
  },
  async authenticate(request){
   const header=request.headers.get('authorization')||'';
   if(!/^Bearer [A-Za-z0-9_-]{32,128}$/.test(header))throw denied();
   const wanted=digest(header.slice(7));let record;
   for(const candidate of records.values())if(timingSafeEqual(candidate.tokenDigest,wanted))record=candidate;
   if(!record)throw denied();await live(record.context,{waitForCleanup:true});
   // A token's possession alone cannot keep a revoked downstream binding live.
   try{await resolveRecord(record);}catch{await retire(record);throw denied();}
   await live(record.context,{waitForCleanup:true});
   return {principalId:record.id,requestContext:record.context};
  },
  async authorize(context){const record=await live(context);try{const binding=await resolveRecord(record);await live(context);return binding;}catch(error){void retire(record).catch(()=>{});throw denied();}},
  async withContext(context,callback){const record=await live(context);const result=await callback(record.requestContext);await live(context);return result;},
  async revoke(grantId){if(!opaque(grantId))throw new TypeError('A trusted grant identifier is required.');const record=records.get(grantId);if(record)await retire(record);},
  async close(){closed=true;const results=await Promise.allSettled([...records.values()].map(retire));if(results.some(r=>r.status==='rejected'))throw new Error('Browser grant cleanup failed.');}
 });
}

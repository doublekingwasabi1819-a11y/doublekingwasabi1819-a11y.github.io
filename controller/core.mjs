import {randomUUID} from 'node:crypto';

const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const opaque={type:'string',minLength:1,maxLength:128,pattern:'^[A-Za-z0-9_-]+$'};
const object=(properties={},required=[])=>({type:'object',properties,required,additionalProperties:false});
const session={session_id:opaque},observed={...session,observation_id:opaque};
const rows=[
  ['browser_open','Open this worker’s server-approved browser workspace. Website, identity and profile configuration come from the trusted host.',object(),false,false,false],
  ['browser_observe','Read a fresh bounded observation of this worker’s server-approved browser workspace.',object(session,['session_id']),true,true,false],
  ['browser_click','Click one target from the current observation; returns a new observation. Never retry an uncertain click automatically.',object({...observed,target_id:opaque},['session_id','observation_id','target_id']),false,false,true],
  ['browser_fill','Fill one host-permitted non-secret textbox from the current observation. Do not pass credentials.',object({...observed,target_id:opaque,text:{type:'string',maxLength:4000}},['session_id','observation_id','target_id','text']),false,false,true],
  ['browser_screenshot','Capture a masked workspace image using a current observation.',object(observed,['session_id','observation_id']),true,true,false],
  ['browser_close','Close this worker’s server-approved browser session.',object(session,['session_id']),false,true,false]
];
export const browserTools=rows.map(([name,description,inputSchema,readOnlyHint,idempotentHint,destructiveHint])=>({
  name,description,inputSchema:structuredClone(inputSchema),
  annotations:{readOnlyHint,idempotentHint,destructiveHint,openWorldHint:false}
}));
const messages={VALIDATION:'Invalid browser tool arguments.',UNKNOWN_TOOL:'Unknown browser tool.',AUTH_REQUIRED:'Browser authentication is required.',FORBIDDEN:'This connection cannot access that browser operation.',STALE_SESSION:'The worker run changed. Open a new browser session.',STALE_OBSERVATION:'Observe again before acting; this observation is no longer current.',NOT_FOUND:'The browser session is unavailable.',LIMIT:'The browser session limit was reached.',INTERNAL:'The browser could not complete this operation.'};
export class BrowserControllerError extends Error {constructor(code){super(messages[code]||messages.INTERNAL);this.name='BrowserControllerError';this.code=code;}}
const fail=code=>{throw new BrowserControllerError(code);};
const plain=x=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const safe=error=>new BrowserControllerError(Object.hasOwn(messages,error?.code)?error.code:'INTERNAL');
const result=value=>({structuredContent:value,content:[{type:'text',text:JSON.stringify(value)}]});
function imageResult(image,metadata){if(!plain(image)||image.mimeType!=='image/png'||typeof image.data!=='string'||!image.data.length||image.data.length>8000000||!/^[A-Za-z0-9+/]+={0,2}$/.test(image.data))fail('INTERNAL');return {structuredContent:metadata,content:[{type:'image',mimeType:'image/png',data:image.data}]};}
function errorResult(error){const e=safe(error);return {isError:true,structuredContent:{error:{code:e.code,message:e.message}},content:[{type:'text',text:e.message}]};}
const key=b=>JSON.stringify([b.workspaceId,b.accountId]);
const same=(a,b)=>a.workspaceId===b.workspaceId&&a.accountId===b.accountId&&a.agentId===b.agentId&&a.runId===b.runId;

function argumentsFor(invocation) {
  if(!plain(invocation)||Object.keys(invocation).some(k=>!['name','arguments'].includes(k)))fail('VALIDATION');
  const row=rows.find(x=>x[0]===invocation.name);if(!row)fail('UNKNOWN_TOOL');
  const args=invocation.arguments===undefined?{}:invocation.arguments;if(!plain(args))fail('VALIDATION');
  const schema=row[2];
  if(Object.keys(args).some(k=>!Object.hasOwn(schema.properties,k))||schema.required.some(k=>!Object.hasOwn(args,k)))fail('VALIDATION');
  for(const [k,v] of Object.entries(args)) {
    if(k==='text'){if(typeof v!=='string'||[...v].length>4000||Buffer.byteLength(v)>16000)fail('VALIDATION');}
    else if(!id(v))fail('VALIDATION');
  }
  return {name:row[0],args:structuredClone(args),mutates:!row[3]};
}
function bindingFor(b) {
  if(!plain(b)||typeof b.workspaceId!=='string'||!id(b.workspaceId)||typeof b.accountId!=='string'||!UUID.test(b.accountId)||typeof b.agentId!=='string'||!UUID.test(b.agentId)||!id(b.runId))fail('AUTH_REQUIRED');
  return Object.freeze({workspaceId:b.workspaceId,accountId:b.accountId.toLowerCase(),agentId:b.agentId.toLowerCase(),runId:b.runId});
}
function observationFor(value,observationId,at) {
  if(!plain(value)||typeof value.title!=='string'||value.title.length>200||typeof value.status!=='string'||value.status.length>1000||!Array.isArray(value.targets)||value.targets.length>200)fail('INTERNAL');
  const targets=value.targets.map(t=>{
    if(!plain(t)||!id(t.id)||!['button','textbox','link'].includes(t.role)||typeof t.name!=='string'||t.name.length>200)fail('INTERNAL');
    return {id:t.id,role:t.role,name:t.name};
  });
  if(new Set(targets.map(t=>t.id)).size!==targets.length)fail('INTERNAL');
  return {public:{id:observationId,title:value.title,status:value.status,targets},at};
}

/** Trusted host hooks choose an approved workspace; tool inputs cannot select websites or profiles. */
export function createBrowserController({authorize,authorizeAction,createDriver,now=Date.now,uuid=randomUUID,maxSessions=8,observationTTL=60000}={}) {
  if(typeof authorize!=='function'||typeof createDriver!=='function'||(authorizeAction!==undefined&&typeof authorizeAction!=='function')||typeof now!=='function'||typeof uuid!=='function'||!Number.isInteger(maxSessions)||maxSessions<1||maxSessions>64||!Number.isFinite(observationTTL)||observationTTL<=0||observationTTL>600000)throw new TypeError('Valid trusted controller hooks and limits are required.');
  const sessions=new Map(),owners=new Map(),queues=new Map(),knownContexts=new WeakMap(),quarantined=new Set();
  let reservations=0,closed=false;
  async function auth(context){try{return bindingFor(await authorize(context));}catch(e){if(e instanceof BrowserControllerError)throw safe(e);if(e?.code==='STALE_SESSION')fail('STALE_SESSION');if(e?.code==='FORBIDDEN')fail('FORBIDDEN');fail('AUTH_REQUIRED');}}
  function enqueue(owner,operation){const prior=queues.get(owner)||Promise.resolve();const run=prior.catch(()=>{}).then(operation);const tail=run.catch(()=>{});queues.set(owner,tail);tail.finally(()=>{if(queues.get(owner)===tail)queues.delete(owner);});return run;}
  async function dispose(s){if(s.disposed)return true;s.observation=null;s.quarantined=true;try{await s.driver.close();}catch{if(sessions.get(s.id)!==s)quarantined.add(s);return false;}s.disposed=true;if(sessions.get(s.id)===s)sessions.delete(s.id);if(owners.get(key(s.binding))===s.id)owners.delete(key(s.binding));quarantined.delete(s);return true;}
  async function recheck(initial,context,s){let current;try{current=await auth(context);}catch(error){if(s&&same(s.binding,initial))await dispose(s);throw error;}if(!same(initial,current)){if(s&&same(s.binding,initial))await dispose(s);fail('STALE_SESSION');}return current;}
  async function driverOperation(s,operation){try{return await operation();}catch(error){if(['AUTH_REQUIRED','FORBIDDEN','STALE_SESSION'].includes(error?.code))await dispose(s);throw error;}}
  async function observe(s){s.observation=null;const next=observationFor(await driverOperation(s,()=>s.driver.observe()),uuid(),now());if(!id(next.public.id))fail('INTERNAL');s.observation=next;return structuredClone(next.public);}
  function currentObservation(s,args){const o=s.observation;if(!o||o.public.id!==args.observation_id||now()-o.at>observationTTL||now()<o.at)fail('STALE_OBSERVATION');return o.public;}
  async function actionPermission(name,args,binding,context){if(!authorizeAction)fail('FORBIDDEN');const permitted=await authorizeAction({name,arguments:structuredClone(args),binding},context);if(permitted!==true)fail('FORBIDDEN');}
  async function requestIdentity(context){
    try{const b=await auth(context);if(context&&typeof context==='object')knownContexts.set(context,b);return b;}
    catch(error){const known=context&&typeof context==='object'?knownContexts.get(context):undefined;if(known)await enqueue(key(known),async()=>{const s=sessions.get(owners.get(key(known)));if(s&&same(s.binding,known))await dispose(s);});throw error;}
  }
  return {
    async callTool(invocation,requestContext) {
      try {
        if(closed)fail('NOT_FOUND');
        const {name,args,mutates}=argumentsFor(invocation);
        // Teardown uses a previously verified HOST context, never a model ID.
        const initial=await requestIdentity(requestContext);
        const owner=key(initial);
        if(args.session_id){const candidate=sessions.get(args.session_id);if(!candidate)fail('NOT_FOUND');if(key(candidate.binding)!==owner)fail('FORBIDDEN');}
        return await enqueue(owner,async()=>{
          if(closed)fail('NOT_FOUND');
          let s=args.session_id?sessions.get(args.session_id):sessions.get(owners.get(owner));
          const binding=await recheck(initial,requestContext,s);
          if(s&&!same(s.binding,binding)){await dispose(s);fail('STALE_SESSION');}
          if(args.session_id&&!s)fail('NOT_FOUND');
          if(s?.quarantined&&name!=='browser_close')fail('INTERNAL');
          if(mutates)await actionPermission(name,args,binding,requestContext);
          await recheck(binding,requestContext,s);
          if(name==='browser_open') {
            if(!s){
              if(sessions.size+quarantined.size+reservations>=maxSessions)fail('LIMIT');reservations++;
              try {
                const driver=await createDriver({binding});
                if(!driver||['observe','click','fill','screenshot','close'].some(k=>typeof driver[k]!=='function')){if(driver)await dispose({id:null,binding,driver,observation:null});fail('INTERNAL');}
                const sessionId=uuid();
                if(!id(sessionId)||sessions.has(sessionId)){await dispose({id:null,binding,driver,observation:null});fail('INTERNAL');}
                s={id:sessionId,binding,driver,observation:null};
                // A revoke during slow startup cannot create an accessible browser.
                await recheck(binding,requestContext,s);sessions.set(s.id,s);owners.set(owner,s.id);
              }finally{reservations--;}
            }
            let observation;try{observation=await observe(s);await recheck(binding,requestContext,s);}catch(e){await dispose(s);throw e;}
            return result({sessionId:s.id,observation});
          }
          if(name==='browser_close'){if(!await dispose(s))fail('INTERNAL');return result({closed:true});}
          if(name==='browser_observe'){const observation=await observe(s);await recheck(binding,requestContext,s);return result({sessionId:s.id,observation});}
          const observation=currentObservation(s,args);
          if(name==='browser_screenshot') {
            const image=await driverOperation(s,()=>s.driver.screenshot());await recheck(binding,requestContext,s);
            return imageResult(image,{sessionId:s.id,observationId:observation.id});
          }
          const target=observation.targets.find(t=>t.id===args.target_id);if(!target)fail('STALE_OBSERVATION');
          if(name==='browser_fill'&&target.role!=='textbox')fail('VALIDATION');
          // Unknown outcome must not leave an old handle reusable.
          s.observation=null;
          if(name==='browser_click')await driverOperation(s,()=>s.driver.click(args.target_id));else await driverOperation(s,()=>s.driver.fill(args.target_id,args.text));
          const next=await observe(s);await recheck(binding,requestContext,s);
          return result({sessionId:s.id,observation:next});
        });
      }catch(error){return errorResult(error);}
    },
    /** Trusted viewer-only read. No target IDs and no refresh that invalidates
     * an agent's current observation; the same live worker auth/queue applies. */
    async snapshot(requestContext){
      try{
        if(closed)fail('NOT_FOUND');
        const initial=await requestIdentity(requestContext),owner=key(initial);
        return await enqueue(owner,async()=>{
          if(closed)fail('NOT_FOUND');
          const s=sessions.get(owners.get(owner));if(!s)fail('NOT_FOUND');
          const b=await recheck(initial,requestContext,s);
          if(!same(s.binding,b)){await dispose(s);fail('STALE_SESSION');}
          if(s.quarantined)fail('INTERNAL');
          const image=await driverOperation(s,()=>s.driver.screenshot());await recheck(b,requestContext,s);
          return imageResult(image,{state:'open'});
        });
      }catch(error){return errorResult(error);}
    },
    /** Trusted lifecycle hook only, deliberately absent from MCP tools. A host
     * can retire an expired/revoked grant without requiring that grant to auth.
     * Exact last-verified binding prevents old grants closing a newer run.
     * Invoke outside authorize/action/driver callbacks: this hook uses the same
     * owner queue and must never be awaited from an operation holding it. */
    async revokeContext(requestContext){
      try{
        const known=requestContext&&typeof requestContext==='object'?knownContexts.get(requestContext):undefined;
        if(!known)return result({closed:false});
        return await enqueue(key(known),async()=>{
          const s=sessions.get(owners.get(key(known)));
          if(!s||!same(s.binding,known)){knownContexts.delete(requestContext);return result({closed:false});}
          if(!await dispose(s))fail('INTERNAL');
          knownContexts.delete(requestContext);return result({closed:true});
        });
      }catch(error){return errorResult(error);}
    },
    async shutdown(){closed=true;await Promise.all([...queues.values()]);const outcomes=await Promise.all([...sessions.values(),...quarantined].map(dispose));if(outcomes.some(x=>x===false))throw new BrowserControllerError('INTERNAL');}
  };
}

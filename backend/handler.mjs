import {emptyState,applyOperation,HubError} from '../engine.mjs';

const PUBLIC_ACTIONS=new Set(['status','setup','login','recovery.reset']);
const MANAGER_ACTIONS=new Set(['workers.create','workers.update','workers.reset','workers.delete','password.change','recovery.rotate','workspace.delete']);
const ACTIONS=new Set([...PUBLIC_ACTIONS,...MANAGER_ACTIONS,'logout','context','room.read','room.save','operation','dm.inbox','dm.thread','dm.send','dm.read']);
const OPERATIONS=new Set(['project.update','agent.session','agent.checkpoint','task.add','task.claim','task.release','task.progress','task.review','message.add','request.add','request.resolve','memory.save','build.add']);
const MANAGER_OPERATIONS=new Set(['project.update','agent.session','task.release','request.resolve','memory.save']);
const STATUS={UNAUTHORIZED:401,SESSION:401,STALE_SESSION:401,FORBIDDEN:403,NOT_FOUND:404,CONFLICT:409,CLAIMED:409,DELETED:410,RATE_LIMIT:429,NETWORK:503};
const allowedFields={
  status:[],setup:['setupCode','name','username','password'],login:['role','username','password'],
  'recovery.reset':['username','recoveryCode','newPassword'],logout:[],context:[],
  'workers.create':['name','username','password','workRole','model','capabilities'],
  'workers.update':['workerId','name','workRole','enabled'],
  'workers.reset':['workerId','currentPassword','newPassword'],
  'workers.delete':['workerId','currentPassword','confirmation'],
  'password.change':['currentPassword','newPassword'],'recovery.rotate':['currentPassword'],
  'workspace.delete':['currentPassword','confirmation'],'room.read':['accountId'],
  'room.save':['body','expectedVersion','accountId'],operation:['op'],
  'dm.inbox':[], 'dm.thread':['participantA','participantB','beforeId'],
  'dm.send':['recipientId','body','clientId'], 'dm.read':['messageIds']
};
const pick=(action,data)=>Object.fromEntries(allowedFields[action].filter(k=>Object.hasOwn(data,k)).map(k=>[k,data[k]]));
const error=(message,code='VALIDATION',status=400)=>Object.assign(new HubError(message,code),{status});
const sha=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');

/** SQL RPC is privileged and not reachable with a public Supabase key. */
export function createDatabaseRPC({url,serviceKey,fetcher=fetch}){
  if(!url||!serviceKey)throw new Error('Backend database configuration is missing.');
  return async(action,token,data={})=>{
    let response;
    try{response=await fetcher(url.replace(/\/$/,'')+'/rest/v1/rpc/'+(action.startsWith('dm.')?'relay_dm_rpc':'relay_rpc'),{method:'POST',headers:{'Content-Type':'application/json',apikey:serviceKey,Authorization:`Bearer ${serviceKey}`},body:JSON.stringify({p_action:action,p_token:token||'',p_data:data})});}
    catch{throw error('The database could not be reached. Please retry.','NETWORK',503);}
    if(!response.ok)throw error('Relay could not complete the database request.','DATABASE',503);
    const result=await response.json();
    if(result?.error)throw error(result.error.message,result.error.code,result.error.status||STATUS[result.error.code]||400);
    return result;
  };
}

export function createHandler({rpc,allowedOrigins=['https://doublekingwasabi1819-a11y.github.io']}){
  return async request=>{
    const origin=request.headers.get('Origin');
    const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Vary':'Origin'};
    if(origin&&allowedOrigins.includes(origin)){
      headers['Access-Control-Allow-Origin']=origin;
      headers['Access-Control-Allow-Headers']='Content-Type, Authorization';
      headers['Access-Control-Allow-Methods']='POST, OPTIONS';
    }
    const send=(value,status=200)=>new Response(JSON.stringify(value),{status,headers});
    if(origin&&!allowedOrigins.includes(origin))return send({error:{code:'ORIGIN',message:'This website is not allowed to use this Relay backend.'}},403);
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers});
    if(request.method!=='POST')return send({error:{code:'METHOD',message:'Use POST for the Relay API.'}},405);
    try{
      if(!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json'))throw error('Send JSON data.');
      if(Number(request.headers.get('Content-Length'))>65536)throw error('This request is too large.','CAPACITY',413);
      // Bound the actual streamed body too; Content-Length is not trusted.
      const reader=request.body?.getReader();let total=0;const chunks=[];
      if(reader)while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>65536){await reader.cancel();throw error('This request is too large.','CAPACITY',413);}chunks.push(value);}
      const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
      let body;try{body=JSON.parse(new TextDecoder().decode(bytes));}catch{throw error('The request is not valid JSON.');}
      const {action}=body||{};
      if(!ACTIONS.has(action))throw error('Unknown Relay action.','NOT_FOUND',404);
      if(body.data!==undefined&&(!body.data||typeof body.data!=='object'||Array.isArray(body.data)))throw error('Action data must be an object.');
      const data=pick(action,body.data||{});
      const authorization=request.headers.get('Authorization')||'';
      const token=authorization.startsWith('Bearer ')?authorization.slice(7):'';
      if(token.length>512)throw error('Sign in again.','SESSION',401);
      if(!PUBLIC_ACTIONS.has(action)&&!token)throw error('Sign in to continue.','SESSION',401);
      // This is defense in depth; SQL independently rechecks the live session.
      if(MANAGER_ACTIONS.has(action)){
        const context=await rpc('context',token,{});
        if(context.user?.role!=='manager')throw error('Only the manager can do this.','FORBIDDEN',403);
      }
      if(action==='setup')data.state=emptyState('My game studio');
      // Account throttles are always enforced in SQL; this adds a coarse bucket
      // from the gateway's connection header without storing raw IP addresses.
      if(['setup','login','recovery.reset'].includes(action))data.rateKey=await sha((request.headers.get('x-forwarded-for')||'unknown').split(',').at(-1).trim());
      if(action==='context'){const context=await rpc('context',token,data);context.notifications=await rpc('dm.notifications',token,{});return send(context);}
      if(action!=='operation')return send(await rpc(action,token,data));
      const op=data.op;
      if(!op||typeof op!=='object'||Array.isArray(op)||typeof op.id!=='string'||!/^[\w.:-]{1,128}$/.test(op.id)||!OPERATIONS.has(op.type))throw error('Invalid board operation.');
      if(op.payload!==undefined&&(!op.payload||typeof op.payload!=='object'||Array.isArray(op.payload)))throw error('Invalid operation payload.');
      const operation={id:op.id,type:op.type,payload:op.payload||{}};
      for(let attempt=0;attempt<5;attempt++){
        const context=await rpc('context',token,{});
        if(MANAGER_OPERATIONS.has(operation.type)&&context.user?.role!=='manager')throw error('Only the manager can do this.','FORBIDDEN',403);
        const next=applyOperation(context.state,operation,context.actor);
        if(next===context.state)return send({state:context.state});
        try{const result=await rpc('board.commit',token,{expectedRevision:context.state.revision,state:next});return send({state:result.state||next});}
        catch(err){if(!['CONFLICT','NETWORK'].includes(err.code)||attempt===4)throw err;}
      }
    }catch(err){
      const known=err instanceof HubError;
      return send({error:{code:known?err.code:'INTERNAL',message:known?err.message:'Relay could not complete this request. Please retry.'}},known?(err.status||STATUS[err.code]||400):500);
    }
  };
}

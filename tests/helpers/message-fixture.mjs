// Reusable in-memory SQL + real Edge handler fixture. No network or live credentials.
import {readFileSync} from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {emptyState,HubError} from '../../engine.mjs';
import {createHandler} from '../../backend/handler.mjs';

export async function createMessageFixture({packageRoot=process.env.RELAY_PGLITE_ROOT}={}) {
  if(!packageRoot?.startsWith('/tmp/'))throw Error('Use the pinned local /tmp PGlite package; no remote database URL is accepted.');
  if(JSON.parse(readFileSync(packageRoot+'/package.json','utf8')).version!=='0.5.8')throw Error('Use the pinned @electric-sql/pglite@0.5.8 fixture package.');
  const {PGlite}=await import(pathToFileURL(packageRoot+'/dist/index.js'));
  const {pgcrypto}=await import(pathToFileURL(packageRoot+'/dist/contrib/pgcrypto.js'));
  const db=new PGlite({extensions:{pgcrypto}});
  const sql=(query,params=[])=>db.query(query,params);
  const callRPC=async(action,token='',data={})=>{
    await db.exec('set role service_role');
    try{
      const name=action.startsWith('messages.')?'relay_message_rpc':action.startsWith('dm.')?'relay_dm_rpc':'relay_rpc';
      return (await sql(`select public.${name}($1,$2,$3::jsonb) as value`,[action,token,JSON.stringify(data)])).rows[0].value;
    }finally{await db.exec('reset role');}
  };
  // A PGlite fixture has one session. Keep role changes and calls together.
  let queue=Promise.resolve();
  const rawRPC=(...args)=>{const result=queue.then(()=>callRPC(...args));queue=result.catch(()=>{});return result;};
  const rpc=async(...args)=>{const result=await rawRPC(...args);if(result.error)throw Object.assign(new HubError(result.error.message,result.error.code),{status:result.error.status});return result;};
  const handler=createHandler({rpc});
  const request=async(action,token,data={})=>{
    const response=await handler(new Request('https://fixture.invalid',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token||''}`},body:JSON.stringify({action,data})}));
    return {status:response.status,body:await response.json()};
  };
  try{
    await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
    await db.exec(readFileSync(new URL('../../backend/schema.sql',import.meta.url),'utf8'));
    await db.exec(readFileSync(new URL('../../backend/message-contract-rollout.sql',import.meta.url),'utf8'));
    const setupCode=randomBytes(32).toString('hex'),password='Test-only! '+randomBytes(16).toString('hex');
    await sql('update relay_private.studio set setup_hash=$1',[createHash('sha256').update(setupCode).digest('hex')]);
    const login=await rpc('setup','',{setupCode,name:'Manager',username:'manager',password,state:emptyState()});
    const mc=await rpc('context',login.token),manager={...mc.user,token:login.token,runId:null};
    const users=[];
    for(const name of ['alpha','beta','charlie']){
      const user=await rpc('workers.create',manager.token,{name,username:name,password});
      const session=await rpc('login','',{role:'worker',username:name,password});
      const context=await rpc('context',session.token);
      users.push({...user,token:session.token,runId:context.actor.session});
    }
    const capabilities=await rpc('messages.capabilities',users[0].token);
    return {db,sql,rawRPC,rpc,handler,request,password,manager,users,a:users[0],b:users[1],c:users[2],capabilities,close:()=>db.close()};
  }catch(error){await db.close();throw error;}
}

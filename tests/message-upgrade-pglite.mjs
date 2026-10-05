// Local-only upgrade from the exact current task-controls/branding schema.
// No network, deployed database, credentials, or privileged remote operations.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {emptyState, applyOperation, HubError} from '../engine.mjs';
import {createHandler} from '../backend/handler.mjs';

const root=process.env.RELAY_PGLITE_ROOT;
if(!root?.startsWith('/tmp/'))throw Error('Use a local /tmp PGlite package; remote databases are not supported.');
assert.equal(JSON.parse(readFileSync(root+'/package.json','utf8')).version,'0.5.8');
const {PGlite}=await import(pathToFileURL(root+'/dist/index.js'));
const {pgcrypto}=await import(pathToFileURL(root+'/dist/contrib/pgcrypto.js'));
const db=new PGlite({extensions:{pgcrypto}}),sql=(query,params=[])=>db.query(query,params);
const baseline=readFileSync(new URL('../backend/schema.sql',import.meta.url),'utf8');
assert.equal(createHash('sha256').update(baseline).digest('hex'),'f3cbfd16b8b390e3490f4ef89e98737a600c38dcd20bd698f5e83a0e9edc6198');
const rollout=readFileSync(new URL('../backend/message-contract-rollout.sql',import.meta.url),'utf8');
const rpc=async(action,token='',data={})=>{
 await db.exec('set role service_role');try{
  const name=action.startsWith('messages.')?'relay_message_rpc':action.startsWith('dm.')?'relay_dm_rpc':'relay_rpc';
  const value=(await sql(`select public.${name}($1,$2,$3::jsonb) as value`,[action,token,JSON.stringify(data)])).rows[0].value;
  if(value.error)throw Object.assign(new HubError(value.error.message,value.error.code),{status:value.error.status});
  return value;
 }finally{await db.exec('reset role');}
};
const handler=createHandler({rpc});
const operation=async(token,type,payload,id=randomUUID())=>{
 const response=await handler(new Request('https://local-fixture.invalid',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({action:'operation',data:{op:{id,type,payload}}})}));
 const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;
};
const definition=async signature=>(await sql('select pg_get_functiondef($1::regprocedure) as value',[signature])).rows[0].value;
const core=['public.relay_rpc(text,text,jsonb)','relay_private.update_task_worker(jsonb,text,text,timestamptz)','public.relay_dm_rpc(text,text,jsonb)'];
const definitions=async()=>Promise.all(core.map(definition));
const snapshot=async()=>{
 const result={};
 for(const name of ['accounts','sessions','rooms','throttle','direct_messages'])result[name]=(await sql(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) as rows from relay_private.${name} t`)).rows[0].rows;
 result.studio=(await sql('select to_jsonb(s)-\'workspace_id\'-\'message_room_id\' as row from relay_private.studio s')).rows[0].row;
 return result;
};
const noContract=async()=>{
 assert.equal((await sql("select to_regclass('relay_private.message_records') as value")).rows[0].value,null);
 assert.equal((await sql("select count(*)::integer n from information_schema.columns where table_schema='relay_private' and table_name='studio' and column_name in ('workspace_id','message_room_id')")).rows[0].n,0);
};
const rejected=async(pattern)=>{const before=await snapshot();await assert.rejects(db.exec(rollout),pattern);await db.exec('rollback');assert.deepEqual(await snapshot(),before);await noContract();};
let checks=0;const check=async(name,fn)=>{await fn();checks++;console.log('PASS '+name);};
try{
 await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
 await db.exec(baseline);
 const password='Test-only! '+randomBytes(16).toString('hex'),setupCode=randomBytes(32).toString('hex');
 await sql('update relay_private.studio set setup_hash=$1',[createHash('sha256').update(setupCode).digest('hex')]);
 const manager=await rpc('setup','',{setupCode,name:'Mara Relay',username:'manager',password,state:emptyState()});
 const users=[];for(const name of ['alpha','beta']){
  const user=await rpc('workers.create',manager.token,{name,username:name,password});
  users.push({...user,...await rpc('login','',{role:'worker',username:name,password})});
 }
 const [a,b]=users;
 await operation(manager.token,'task.add',{title:'Keep multi-assignee task',acceptance:'Preserve exact state',agentIds:[a.agentId,b.agentId]},'shared-task');
 const task=(await rpc('context',manager.token)).state.tasks[0];
 await operation(a.token,'task.progress',{taskId:task.id,expectedVersion:task.version,status:'review',checkpoint:'Retain evidence',evidence:'Original verified work'});
 const toDelete=(await rpc('context',manager.token)).state.tasks[0];
 await operation(manager.token,'task.delete',{taskId:toDelete.id,expectedVersion:toDelete.version});
 const context=await rpc('context',manager.token);
 const legacy=applyOperation(context.state,{id:'pre-upgrade-post',type:'message.add',payload:{body:'Original public history'}},context.actor);
 await rpc('board.commit',manager.token,{expectedRevision:context.state.revision,state:legacy});
 const dm=await rpc('dm.send',a.token,{clientId:randomUUID(),recipientId:b.id,body:'Original private history'});
 await rpc('dm.read',b.token,{messageIds:[dm.message.id]});
 let coreBefore,rowsBefore;
 await check('pristine current schema retains verified account/helper sources and populated task/history fixtures',async()=>{
  coreBefore=await definitions();rowsBefore=await snapshot();await noContract();
  assert.equal((await sql("select md5(prosrc) as hash from pg_proc where oid='public.relay_rpc(text,text,jsonb)'::regprocedure")).rows[0].hash,'a1828d6823d03c92c15e96e5460f6ee0');
  assert.equal((await sql("select md5(prosrc) as hash from pg_proc where oid='relay_private.update_task_worker(jsonb,text,text,timestamptz)'::regprocedure")).rows[0].hash,'0a35847000b1587329990102943670df');
  assert.equal(rowsBefore.studio.state.tasks[0].assignees.length,2);assert.ok(rowsBefore.studio.state.tasks[0].deletedAt);
 });
 await check('guard rejects account/helper/DM definition drift before adding tables or changing rows',async()=>{
  for(const signature of [...core,'relay_private.dm_action(relay_private.accounts,text,jsonb)']){
   const original=await definition(signature);await db.exec(original.replace(/declare/i,'declare\n/* Deliberate drift */\n'));
   await rejected(/Unexpected definition/);await db.exec(original);
  }
 });
 await check('guard rejects unsafe invoker attributes and public or missing service execution',async()=>{
  const helper=core[1];
  for(const [change,restore] of [
   [`alter function ${helper} security definer`,`alter function ${helper} security invoker`],
   [`alter function ${helper} set search_path=public`,`alter function ${helper} set search_path=pg_catalog`],
   [`grant execute on function ${helper} to anon`,`revoke execute on function ${helper} from anon`],
   [`revoke execute on function ${helper} from service_role`,`grant execute on function ${helper} to service_role`],
  ]){await db.exec(change);await rejected(/Unexpected (definition|privileges)/);await db.exec(restore);}
 });
 await check('guard rejects table/RLS/schema exposure without normalizing unexpected permissions',async()=>{
  for(const [change,restore] of [
   ['grant usage on schema relay_private to authenticated','revoke usage on schema relay_private from authenticated'],
   ['grant select on relay_private.direct_messages to anon','revoke select on relay_private.direct_messages from anon'],
   ['alter table relay_private.direct_messages disable row level security','alter table relay_private.direct_messages enable row level security'],
   ['revoke update on relay_private.accounts from service_role','grant update on relay_private.accounts to service_role'],
  ]){await db.exec(change);await rejected(/Unexpected|unsafe/);await db.exec(restore);}
 });
 await check('guard rejects unknown partial messaging installs without overwriting them',async()=>{
  await db.exec('alter table relay_private.studio add column workspace_id uuid');
  await assert.rejects(db.exec(rollout),/Partial or unexpected/);await db.exec('rollback');
  assert.equal((await sql("select count(*)::integer n from information_schema.columns where table_schema='relay_private' and table_name='studio' and column_name='workspace_id'")).rows[0].n,1);
  await db.exec('alter table relay_private.studio drop column workspace_id');await noContract();
 });
 await check('message-only rollout preserves exact accounts/sessions/tasks/board/DMs and imports legacy private history without alerts',async()=>{
  await db.exec(rollout);assert.deepEqual(await snapshot(),rowsBefore);assert.deepEqual(await definitions(),coreBefore);
  assert.equal((await rpc('messages.get',a.token,{messageId:dm.message.id})).message.body,dm.message.body);
  assert.equal((await rpc('dm.thread',b.token,{participantA:a.id,participantB:b.id})).messages[0].readAt,rowsBefore.direct_messages[0].read_at);
  for(const token of [a.token,b.token,manager.token])assert.equal((await rpc('messages.notifications',token)).notifications.length,0);
  assert.equal((await sql('select count(*)::integer n from relay_private.message_records')).rows[0].n,1);
 });
 await check('guarded rollout is repeatable and preserves all generated identities, receipts and canonical history',async()=>{
  const capability=await rpc('messages.capabilities',a.token);
  const post=await operation(a.token,'message.add',{body:'After upgrade',to:b.agentId},'new-message');
  const before=await snapshot();const notice=(await rpc('messages.notifications',b.token)).notifications[0];
  for(let i=0;i<2;i++)await db.exec(rollout);
  assert.deepEqual(await snapshot(),before);assert.deepEqual(await definitions(),coreBefore);
  assert.deepEqual(await rpc('messages.capabilities',a.token),capability);
  assert.equal((await rpc('messages.get',a.token,{messageId:post.message.id})).message.body,'After upgrade');
  assert.deepEqual((await rpc('messages.notifications',b.token)).notifications,[notice]);
 });
 await check('guard refuses modified installed messaging functions and table privileges rather than overwriting',async()=>{
  const signature='relay_private.message_rejected(text)',original=await definition(signature);
  const before=await snapshot();await db.exec(original.replace("select jsonb_build_object", "select /* drift */ jsonb_build_object"));
  await assert.rejects(db.exec(rollout),/Unexpected definition/);await db.exec('rollback');await db.exec(original);
  await db.exec('grant select on relay_private.message_records to authenticated');
  await assert.rejects(db.exec(rollout),/Unexpected Relay table privileges/);await db.exec('rollback');
  assert.equal((await sql("select has_table_privilege('authenticated','relay_private.message_records','SELECT') as permitted")).rows[0].permitted,true);
  await db.exec('revoke select on relay_private.message_records from authenticated');assert.deepEqual(await snapshot(),before);
 });
 await check('guard refuses disabled or changed message cleanup triggers',async()=>{
  const before=await snapshot();
  await db.exec('alter table relay_private.studio disable trigger relay_message_workspace_deleted');
  await assert.rejects(db.exec(rollout),/Unexpected message trigger definition/);await db.exec('rollback');
  await db.exec('alter table relay_private.studio enable trigger relay_message_workspace_deleted');
  assert.deepEqual(await snapshot(),before);
 });
 await check('latest task restore/edit/multi-assignee progress and manager capability work after upgrade',async()=>{
  let current=(await rpc('context',manager.token)).state.tasks[0];
  await operation(manager.token,'task.restore',{taskId:current.id,expectedVersion:current.version});
  current=(await rpc('context',manager.token)).state.tasks[0];
  await operation(manager.token,'task.edit',{taskId:current.id,expectedVersion:current.version,title:'Edited after messaging upgrade',acceptance:current.acceptance,description:current.description,priority:current.priority});
  current=(await rpc('context',manager.token)).state.tasks[0];
  await operation(b.token,'task.progress',{taskId:current.id,expectedVersion:current.version,status:'working',checkpoint:'Secondary worker after upgrade'});
  const after=await rpc('context',manager.token);assert.deepEqual(after.manager,{name:'Mara Relay'});assert.equal(after.capabilities.taskLifecycleV1,true);
  assert.equal(after.state.tasks[0].assignees.length,2);assert.equal(after.state.tasks[0].deletedAt,undefined);
  assert.ok(after.state.messages.some(m=>m.body==='Original public history'));
 });
 console.log(`${checks} guarded local messaging-upgrade checks passed. No live deployment or independent-session concurrency validation.`);
}finally{await db.close();}

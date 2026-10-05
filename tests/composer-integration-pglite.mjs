// Functional integration only: actual Edge handler, canonical SQL, local PGlite.
// Does not replace the blocked independent security/deployment review.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createHandler} from '../backend/handler.mjs';
import {HubError} from '../engine.mjs';
import {createMessageFixture} from './helpers/message-fixture.mjs';
const f=await createMessageFixture();
const {a,b,c,manager,rpc,request,sql}=f;
const post=(payload,id=randomUUID(),user=a)=>request('operation',user.token,{op:{id,type:'message.add',payload}});
const count=async table=>Number((await sql(`select count(*) n from relay_private.${table}`)).rows[0].n);
let checks=0;async function check(name,fn){await fn();console.log('PASS '+name);checks++;}
try{
 let publicMessage,privateMessage;
 await check('directed web send atomically creates shared canonical history, correct sender, one intended outbox and board projection',async()=>{
  const payload={body:'Web message',to:b.agentId,from:'owner',senderId:manager.id,visibility:'private'};
  const response=await post(payload,'web-directed');assert.equal(response.status,200,JSON.stringify(response));
  publicMessage=response.body.message;
  assert.equal(publicMessage.senderId,a.id);assert.equal(publicMessage.visibility,'public');
  assert.deepEqual(publicMessage.notificationRecipientIds,[b.id]);
  const board=response.body.state.messages.find(m=>m.id===publicMessage.id);
  assert.equal(board.from,a.agentId);assert.equal(board.to,b.agentId);assert.equal(board.operationId,'web-directed');
  for(const user of [a,b,c,manager]){
   assert.equal((await rpc('messages.get',user.token,{messageId:publicMessage.id})).message.body,payload.body);
   assert.ok((await rpc('messages.history',user.token)).messages.some(m=>m.id===publicMessage.id));
  }
  assert.equal(await count('message_records'),1);assert.equal(await count('message_outbox'),1);
  assert.equal((await rpc('messages.notifications',manager.token)).notifications.length,0);
 });
 await check('repeated and parallel same-ID sends are durable once; changed target/body/reply conflicts',async()=>{
  const payload={body:'Web message',to:b.agentId};
  const results=await Promise.all([post(payload,'web-directed'),post(payload,'web-directed')]);
  assert.ok(results.every(r=>r.body.message.id===publicMessage.id));
  for(const changed of [{body:'Changed',to:b.agentId},{...payload,to:c.agentId},{...payload,replyToMessageId:publicMessage.id}])assert.equal((await post(changed,'web-directed')).status,409);
  assert.equal(await count('message_records'),1);assert.equal(await count('message_outbox'),1);
 });
 await check('lost composer acknowledgement retries the same durable message without duplicating its outbox',async()=>{
  const records=await count('message_records'),outbox=await count('message_outbox');let attempts=0;
  const handler=createHandler({rpc:async(action,token,data)=>{
   const result=await rpc(action,token,data);
   if(action==='messages.composer.send'&&++attempts===1)throw new HubError('Simulated lost acknowledgement','NETWORK');
   return result;
  }});
  const result=await handler(new Request('https://fixture.invalid',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${a.token}`},body:JSON.stringify({action:'operation',data:{op:{id:'lost-composer-ack',type:'message.add',payload:{body:'Saved exactly once',to:b.agentId}}}})}));
  assert.equal(result.status,200);const saved=(await result.json()).message;
  assert.equal(attempts,2);assert.equal(await count('message_records'),records+1);assert.equal(await count('message_outbox'),outbox+1);
  assert.equal((await post({body:'Saved exactly once',to:b.agentId},'lost-composer-ack')).body.message.id,saved.id);
  assert.equal(await count('message_records'),records+1);assert.equal(await count('message_outbox'),outbox+1);
 });
 await check('general and task public sends keep scope/link without automatically pinging manager or broadcasting alerts',async()=>{
  const before=await count('message_outbox');
  const taskId=randomUUID();const task=await request('operation',manager.token,{op:{id:taskId,type:'task.add',payload:{title:'Task fixture',acceptance:'Test'}}});assert.equal(task.status,200);
  const general=await post({body:'General message'});assert.equal(general.status,200);assert.deepEqual(general.body.message.notificationRecipientIds,[]);
  const taskMessage=await post({body:'Task message',taskId},'task-message');assert.equal(taskMessage.status,200);
  assert.equal(taskMessage.body.state.messages.find(m=>m.id===taskMessage.body.message.id).taskId,taskId);
  assert.equal((await post({body:'Task message'},'task-message')).status,409);
  assert.equal(await count('message_outbox'),before);
 });
 await check('public composer replies and agent replies share canonical IDs and reply metadata',async()=>{
  const reply=await post({body:'Web reply',replyToMessageId:publicMessage.id});assert.equal(reply.status,200);
  assert.equal(reply.body.message.replyToMessageId,publicMessage.id);
  const command={...reply.body.message,clientId:randomUUID(),senderId:b.id,body:'Agent reply',replyToMessageId:reply.body.message.id};
  delete command.id;delete command.createdAt;
  const agentReply=await rpc('messages.send',b.token,{command});assert.equal(agentReply.status,'persisted');
  assert.equal((await rpc('context',a.token)).state.messages.find(m=>m.id===agentReply.message.id).replyToMessageId,reply.body.message.id);
 });
 await check('private composer continues canonical participant history and recipient-only notifications',async()=>{
  const result=await request('dm.send',a.token,{clientId:randomUUID(),recipientId:b.id,body:'Private web message'});assert.equal(result.status,200);
  privateMessage=(await rpc('messages.get',a.token,{messageId:result.body.message.id})).message;
  assert.equal(privateMessage.visibility,'private');assert.deepEqual(privateMessage.participantIds,[a.id,b.id].sort());
  assert.equal((await rpc('messages.get',manager.token,{messageId:privateMessage.id})).message.body,'Private web message');
  assert.equal((await rpc('messages.notifications',manager.token)).notifications.length,0);
  const rows=(await sql('select recipient_id from relay_private.message_outbox where message_id=$1',[privateMessage.id])).rows;
  assert.deepEqual(rows.map(r=>r.recipient_id),[b.id]);
 });
 await check('bad task, recipient, body or cross-audience reply never creates partial history/outbox',async()=>{
  const records=await count('message_records'),outbox=await count('message_outbox');
  for(const payload of [{body:'Bad task',taskId:'missing'},{body:'Bad recipient',to:'missing'},{body:' '},{body:'Wrong reply',replyToMessageId:privateMessage.id},{body:'Invalid reply',replyToMessageId:7}]){
   const result=await post(payload);assert.ok(result.status>=400,JSON.stringify(result));
  }
  assert.equal(await count('message_records'),records);assert.equal(await count('message_outbox'),outbox);
 });
 await check('manager channel alerts manager only when explicitly addressed',async()=>{
  const result=await post({body:'For the manager',to:'owner'});assert.equal(result.status,200);
  assert.deepEqual(result.body.message.notificationRecipientIds,[manager.id]);
  assert.equal((await rpc('messages.notifications',manager.token)).notifications.length,1);
 });
 await check('explicit general beam notifies enabled workers except sender, with no manager alert or task-note broadcast',async()=>{
  const before=(await rpc('messages.notifications',manager.token)).notifications.length;
  const result=await post({body:'Explicit workspace beam',notifyWorkspace:true},'broadcast');assert.equal(result.status,200);
  assert.deepEqual(result.body.message.notificationRecipientIds,[b.id,c.id].sort());
  assert.equal((await rpc('messages.notifications',manager.token)).notifications.length,before);
  assert.equal((await post({body:'Explicit workspace beam',notifyWorkspace:false},'broadcast')).status,409);
  assert.equal((await post({body:'Invalid beam',notifyWorkspace:true,taskId:'task'})).status,400);
  assert.equal((await post({body:'Invalid beam',notifyWorkspace:true,to:b.agentId})).status,400);
 });
 await check('projection capacity failure rolls back canonical message and intended outbox together',async()=>{
  const command={clientId:randomUUID(),workspaceId:f.capabilities.workspaceId,roomId:f.capabilities.roomId,visibility:'public',senderId:a.id,
   recipientIds:[],participantIds:[],notificationRecipientIds:[b.id],body:'Cap',replyToMessageId:null};
  const size=async()=>Number((await sql('select octet_length(state::text) n from relay_private.studio')).rows[0].n);
  const initial=await size();await f.db.exec('begin');await rpc('messages.send',a.token,{command});const growth=(await size())-initial;await f.db.exec('rollback');
  const original=(await rpc('context',a.token)).state;
  await f.db.exec('begin');try{
   await sql("update relay_private.studio set state=jsonb_set(state,'{project,rules}',to_jsonb(repeat('x',$1)))",[900000-growth-20-initial+original.project.rules.length]);
   const records=await count('message_records'),outbox=await count('message_outbox'),before=await size();
   const result=await post({body:'Cap',to:b.agentId});assert.equal(result.body.error?.code,'CAPACITY',JSON.stringify(result));
   assert.equal(await count('message_records'),records);assert.equal(await count('message_outbox'),outbox);assert.equal(await size(),before);
  }finally{await f.db.exec('rollback');}
 });
 await check('reinstall keeps composer dedup records and sends no repeat notifications',async()=>{
  const records=await count('message_records'),outbox=await count('message_outbox');
  await f.db.exec(readFileSync(new URL('../backend/private-messages.sql',import.meta.url),'utf8'));
  const result=await post({body:'Web message',to:b.agentId},'web-directed');assert.equal(result.status,200);
  assert.equal(result.body.message.id,publicMessage.id);assert.equal(await count('message_records'),records);assert.equal(await count('message_outbox'),outbox);
 });
 console.log(`${checks} composer functional checks passed (single-session PGlite; no live deployment).`);
}finally{await f.close();}

import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createMessageFixture} from './helpers/message-fixture.mjs';
import {mountReceiptApp,apiURL,until,tick} from './helpers/receipt-app-fixture.mjs';

const sqlFixture=await createMessageFixture();
const {a,b,manager,capabilities,rpc}=sqlFixture;
const command=(visibility,body)=>({clientId:randomUUID(),workspaceId:capabilities.workspaceId,roomId:capabilities.roomId,visibility,senderId:a.id,
  recipientIds:visibility==='private'?[b.id]:[],participantIds:visibility==='private'?[a.id,b.id].sort():[],notificationRecipientIds:visibility==='private'?[b.id]:[],body,replyToMessageId:null});
const pub=(await rpc('messages.send',a.token,{command:command('public','Actual shared history fixture')})).message;
const dm=(await rpc('messages.send',a.token,{command:command('private','Actual private history fixture')})).message;
const receiptURL='https://relay.fixture.invalid/manager-receipts';
let receiptCalls=0;
function receipt(messageId){return {messageId,visibility:messageId===dm.id?'private':'public',receiptState:'available',recipients:[{recipientId:b.id,agentId:b.agentId,
  queuedAt:'2026-10-05T03:00:00Z',pingSentAt:'2026-10-05T03:00:01Z',serviceAcceptedAt:'2026-10-05T03:00:02Z',messageFetchedAt:null,agentAcknowledgedAt:null,attempts:[{eventId:'fixture-attempt'}]}]};}
async function backend(url,options){
  if(url===apiURL)return sqlFixture.handler(new Request(url,options));
  assert.equal(url,receiptURL);receiptCalls++;
  const token=options.headers.Authorization?.slice(7),context=await sqlFixture.rawRPC('context',token);
  if(context.error)return Response.json({error:'unauthorized'},{status:401});
  if(context.user.role!=='manager')return Response.json({error:'forbidden'},{status:403});
  const {messageId}=JSON.parse(options.body),source=await rpc('messages.get',token,{messageId});
  if(!source.message)return Response.json({error:'not found'},{status:404});
  return Response.json(receipt(messageId));
}
test.after(async()=>sqlFixture.close());

test('actual app Public history mounts receipt control and reads only authorized fixture endpoint',async()=>{
  const app=await mountReceiptApp({token:manager.token,backend});try{
    await until(()=>app.document.querySelector(`[data-receipt-message="${pub.id}"]`));
    const storage=app.window.sessionStorage.getItem('relay-account-session-v2');
    const control=app.document.querySelector(`[data-receipt-message="${pub.id}"]`);control.querySelector('button').click();
    await until(()=>control.querySelector('[data-receipt-stage]'));
    assert.equal(control.querySelector('[data-receipt-stage="messageFetchedAt"]').textContent,'Not reported');
    assert.equal(control.querySelector('[data-receipt-stage="agentAcknowledgedAt"]').textContent,'Not reported');
    assert.equal(app.window.sessionStorage.getItem('relay-account-session-v2'),storage);assert.equal(app.window.localStorage.length,0);assert.equal(app.logs.length,0);
    assert.equal(app.calls.filter(c=>c.url===receiptURL).length,1);
  }finally{app.close();}
});
test('actual app Private inbox mounts manager audit receipts without read or ping actions',async()=>{
  const app=await mountReceiptApp({token:manager.token,backend,hash:'inbox'});try{
    await until(()=>app.document.querySelector('[data-dm-thread]'));app.document.querySelector('[data-dm-thread]').click();
    await until(()=>app.document.querySelector(`[data-receipt-message="${dm.id}"]`));
    const prior=app.calls.length,control=app.document.querySelector(`[data-receipt-message="${dm.id}"]`);control.querySelector('button').click();
    await until(()=>control.querySelector('[data-receipt-stage]'));assert.equal(control.dataset.receiptVisibility,'private');
    const calls=app.calls.slice(prior);assert.equal(calls.filter(c=>c.url===receiptURL).length,1);
    assert.ok(calls.every(c=>c.url===receiptURL||!['dm.read','messages.send','messages.notifications.ack'].includes(JSON.parse(c.options.body).action)));
    assert.equal((await rpc('dm.thread',b.token,{participantA:a.id,participantB:b.id})).messages.find(m=>m.id===dm.id).readAt,null);
    assert.equal(app.logs.length,0);
  }finally{app.close();}
});
test('actual worker app and default-unconfigured manager app never mount active receipt controls',async()=>{
  for(const options of [{token:a.token,endpoint:'/manager-receipts'},{token:manager.token,endpoint:''},{token:manager.token,endpoint:'https://lightsail.fixture.invalid/receipts'}]){
    const app=await mountReceiptApp({...options,backend});try{await until(()=>app.document.querySelector(`#relay-message-${pub.id}`));
      assert.equal(app.document.querySelector('[data-receipt-toggle]'),null);assert.equal(app.calls.filter(c=>c.url===receiptURL).length,0);
      if(options.token===manager.token)assert.match(app.document.querySelector(`#relay-message-${pub.id}`).textContent,/Delivery receipts unavailable/);
    }finally{app.close();}
  }
});
test('actual app navigation and logout remove late receipt results',async()=>{
  for(const action of ['navigate','logout']){
    let resolve;const pending=new Promise(r=>resolve=r);
    const app=await mountReceiptApp({token:manager.token,backend:(url,options)=>url===receiptURL?pending:backend(url,options)});
    try{await until(()=>app.document.querySelector('[data-receipt-toggle]'));app.document.querySelector('[data-receipt-toggle]').click();
      if(action==='navigate'){app.window.location.hash='tasks';await until(()=>app.document.querySelector('#task-search'));}
      else{app.document.querySelector('#account-button').click();await until(()=>app.document.querySelector('#auth-form'));}
      resolve(Response.json(receipt(pub.id)));await tick();await tick();assert.equal(app.document.querySelector('[data-receipt-stage]'),null);
    }finally{app.close();}
  }
});

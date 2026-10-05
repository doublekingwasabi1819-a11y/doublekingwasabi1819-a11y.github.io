// Actual app composer -> actual Edge -> disposable SQL. jsdom, not Chromium.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createMessageFixture} from './helpers/message-fixture.mjs';
import {mountReceiptApp,apiURL,until} from './helpers/receipt-app-fixture.mjs';
const f=await createMessageFixture();
test.after(()=>f.close());
const backend=(url,options)=>{assert.equal(url,apiURL);return f.handler(new Request(url,options));};
function fill(app,text){const textarea=app.document.querySelector('#compose textarea');textarea.value=text;textarea.dispatchEvent(new app.window.Event('input',{bubbles:true}));return app.document.querySelector('#compose');}
function submit(app,form){form.dispatchEvent(new app.window.Event('submit',{bubbles:true,cancelable:true}));}
const rows=()=>f.sql('select id,request from relay_private.message_records order by created_at,id');

test('actual public composer saves canonical shared history with the selected recipient and quiet manager receipts',async()=>{
 const app=await mountReceiptApp({token:f.a.token,backend});try{
  await until(()=>app.document.querySelector('#compose'));
  assert.equal(app.document.querySelector('#project-name').textContent,f.manager.name);
  assert.equal(app.document.querySelector('#project-initial').textContent,f.manager.name[0]);
  app.document.querySelector(`[data-action="channel"][data-id="${f.b.agentId}"]`).click();
  await until(()=>app.document.querySelector('.channel-button.active')?.dataset.id===f.b.agentId);
  submit(app,fill(app,'Directed from actual browser composer'));
  await until(()=>app.document.querySelector('.message p')?.textContent==='Directed from actual browser composer');
  const all=await rows(),message=all.rows.find(r=>r.request.body==='Directed from actual browser composer');assert.ok(message);
  assert.equal(message.request.senderId,f.a.id);assert.equal(message.request.visibility,'public');assert.deepEqual(message.request.notificationRecipientIds,[f.b.id]);
  assert.equal((await f.rpc('messages.notifications',f.manager.token)).notifications.length,0);
  assert.equal(app.document.querySelector('#compose textarea').value,'');assert.equal(app.logs.length,0);
 }finally{app.close();}
});

test('lost HTTP acknowledgement retains the draft and operation ID across navigation and manual retry',async()=>{
 let lose=true;
 const app=await mountReceiptApp({token:f.a.token,backend:async(url,options)=>{
  const response=await backend(url,options);
  if(JSON.parse(options.body).action==='operation'&&lose){lose=false;throw Error('Lost response after commit');}
  return response;
 }});try{
  await until(()=>app.document.querySelector('#compose'));
  submit(app,fill(app,'Save once despite response loss'));
  await until(()=>app.document.querySelector('#compose .form-error').textContent);
  assert.equal(app.document.querySelector('#compose textarea').value,'Save once despite response loss');
  app.document.querySelector(`[data-action="channel"][data-id="${f.b.agentId}"]`).click();
  await until(()=>app.document.querySelector('.channel-button.active')?.dataset.id===f.b.agentId);
  app.document.querySelector('[data-action="channel"][data-id="general"]').click();
  await until(()=>app.document.querySelector('.channel-button.active')?.dataset.id==='general');
  assert.equal(app.document.querySelector('#compose textarea').value,'Save once despite response loss');
  submit(app,app.document.querySelector('#compose'));
  await until(()=>app.document.querySelector('#compose textarea').value==='');
  const calls=app.calls.map(c=>JSON.parse(c.options.body)).filter(c=>c.action==='operation');
  assert.equal(calls.length,2);assert.equal(calls[0].data.op.id,calls[1].data.op.id);
  const sent=(await rows()).rows.filter(r=>r.request.body==='Save once despite response loss');
  assert.equal(sent.length,1);assert.deepEqual(sent[0].request.notificationRecipientIds,[f.b.id,f.c.id].sort());
  assert.equal((await f.rpc('messages.notifications',f.manager.token)).notifications.length,0);
  assert.match(app.document.querySelector('#compose .checkbox-caption').textContent,/Queues notifications for enabled workers except you; manager stays quiet/);
  assert.match(app.document.querySelector('#compose .checkbox-caption').textContent,/Active delivery is not connected/);
  assert.equal(app.document.querySelector('#compose button[type=submit]').textContent,'Post message');
 }finally{app.close();}
});

test('repeated submit events while saving share one durable operation',async()=>{
 const app=await mountReceiptApp({token:f.a.token,backend});try{
  await until(()=>app.document.querySelector('#compose'));
  const form=fill(app,'Double click should save once');submit(app,form);submit(app,form);
  await until(()=>app.document.querySelector('#compose textarea').value==='');
  const calls=app.calls.map(c=>JSON.parse(c.options.body)).filter(c=>c.action==='operation');
  assert.equal(calls.length,2);assert.equal(calls[0].data.op.id,calls[1].data.op.id);
  assert.equal((await rows()).rows.filter(r=>r.request.body==='Double click should save once').length,1);
 }finally{app.close();}
});

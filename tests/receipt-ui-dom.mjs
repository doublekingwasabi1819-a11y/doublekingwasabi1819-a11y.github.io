import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {createMessageReceipts,receiptEndpoint,checkedReceipt} from '../receipt-ui.mjs';
const packageRoot=process.env.RELAY_RECEIPT_JSDOM_ROOT;
if(!packageRoot?.startsWith('/tmp/'))throw Error('Set RELAY_RECEIPT_JSDOM_ROOT to the pinned local jsdom package.');
const {JSDOM}=await import(pathToFileURL(packageRoot+'/lib/api.js'));
const messageId='11111111-1111-4111-8111-111111111111',recipientId='22222222-2222-4222-8222-222222222222',agentId='33333333-3333-4333-8333-333333333333';
const record=(visibility='public',changes={})=>({messageId,visibility,receiptState:'available',recipients:[{recipientId,agentId,queuedAt:'2026-10-05T03:00:00Z',pingSentAt:null,serviceAcceptedAt:'2026-10-05T03:00:02Z',messageFetchedAt:null,agentAcknowledgedAt:null,attempts:[]}],...changes});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const settle=async()=>{for(let i=0;i<5;i++)await tick();};
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture({endpoint='/manager-receipts',visibility='public',timeoutMs=15000,fetcher=async()=>Response.json(record(visibility))}={}){
  const dom=new JSDOM('<main id="content"></main>',{url:'https://web.example/'});
  const root=dom.window.document.querySelector('#content'),calls=[];
  const api={base:'https://relay.example/relay',token:'synthetic-manager-session'};
  let user={id:'manager',role:'manager'},live=true,view='messages',sessionErrors=0;
  const ui=createMessageReceipts({api,getUser:()=>user,isLive:()=>live,getViewKey:()=>view,endpoint,timeoutMs,fetcher:async(...args)=>{calls.push(args);return fetcher(...args);},onSessionError:()=>{sessionErrors++;}});
  root.innerHTML=ui.renderControl(messageId,visibility);ui.mount(root);
  return {dom,root,api,calls,ui,get sessionErrors(){return sessionErrors;},setUser:value=>user=value,setLive:value=>live=value,setView:value=>view=value,
    toggle:()=>root.querySelector('[data-receipt-toggle]')?.click(),refresh:()=>root.querySelector('[data-receipt-refresh]')?.click(),
    close:()=>{ui.destroy();dom.window.close();}};
}
test('receipt endpoint is opt-in, same-origin and excludes URL credentials/redirect destinations',()=>{
  const base='https://relay.example/relay';
  assert.equal(receiptEndpoint('/receipts',base),'https://relay.example/receipts');
  for(const endpoint of ['',null,'https://elsewhere.example/receipts','https://user:pass@relay.example/receipts','/receipts?token=x','/receipts#token'])assert.equal(receiptEndpoint(endpoint,base),null);
  assert.equal(receiptEndpoint('/receipts',''),null);
  assert.equal(receiptEndpoint('/receipts','http://remote.example/relay'),null);
  assert.equal(receiptEndpoint('/receipts','http://localhost:9000/relay'),'http://localhost:9000/receipts');
});
test('default disabled configuration is honest and cannot send even after DOM tampering',async()=>{
  const f=fixture({endpoint:''});try{assert.match(f.root.textContent,/Delivery receipts unavailable/);assert.equal(f.root.querySelector('button'),null);
    f.root.innerHTML=`<section data-receipt-message="${messageId}" data-receipt-visibility="public"><button data-receipt-toggle>open</button><div data-receipt-panel hidden></div></section>`;
    f.toggle();await settle();assert.equal(f.calls.length,0);
  }finally{f.close();}
});
test('workers and demo users receive no control and cannot fetch through a stale manager control',async()=>{
  const f=fixture();try{f.setUser({id:'worker',role:'worker'});assert.equal(f.ui.renderControl(messageId,'public'),'');f.toggle();await settle();assert.equal(f.calls.length,0);
    f.setUser({id:'manager',role:'manager'});f.setLive(false);assert.equal(f.ui.renderControl(messageId,'private'),'');
  }finally{f.close();}
});
test('manager receipt fetch is one authorized read-only POST, with no read/ping side effects or persistence',async()=>{
  const f=fixture();try{let documentClicks=0;f.dom.window.document.addEventListener('click',()=>documentClicks++);
    f.toggle();await settle();assert.equal(f.calls.length,1);const [url,options]=f.calls[0];assert.equal(url,'https://relay.example/manager-receipts');
    assert.equal(options.method,'POST');assert.deepEqual(JSON.parse(options.body),{messageId});assert.equal(options.headers.Authorization,'Bearer synthetic-manager-session');
    assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');assert.equal(options.referrerPolicy,'no-referrer');assert.equal(documentClicks,0);
    assert.equal(f.dom.window.sessionStorage.length,0);assert.equal(f.dom.window.localStorage.length,0);
    assert.equal(f.root.querySelector('[data-receipt-stage="messageFetchedAt"]').textContent,'Not reported');
    assert.equal(f.root.querySelector('[data-receipt-stage="agentAcknowledgedAt"]').textContent,'Not reported');
    assert.match(f.root.querySelector('[data-receipt-stage="serviceAcceptedAt"]').textContent,/03:00:02/);assert.doesNotMatch(f.root.textContent,/synthetic-manager-session/);
  }finally{f.close();}
});
test('private receipt uses the same inspector, preserves independent stages and displays no message body',async()=>{
  const f=fixture({visibility:'private',fetcher:async()=>Response.json({...record('private'),body:'secret must never display'})});try{f.toggle();await settle();assert.equal(f.calls.length,1);assert.match(f.root.textContent,/Agent acknowledged/);assert.doesNotMatch(f.root.textContent,/secret must never display/);}finally{f.close();}
});
test('no event record is shown as absence of evidence',async()=>{
  const f=fixture({fetcher:async()=>Response.json(record('public',{receiptState:'no_event_record',recipients:[]}))});try{f.toggle();await settle();assert.match(f.root.textContent,/No event record is available/);assert.equal(f.root.querySelector('[data-receipt-stage]'),null);}finally{f.close();}
});
test('collapse aborts and suppresses a late response even when the fetcher ignores abort',async()=>{
  const wait=deferred(),f=fixture({fetcher:()=>wait.promise});try{f.toggle();f.toggle();assert.equal(f.calls[0][1].signal.aborted,true);wait.resolve(Response.json(record()));await settle();assert.equal(f.root.querySelector('[data-receipt-panel]').hidden,true);assert.equal(f.root.querySelector('[data-receipt-panel]').textContent,'');}finally{f.close();}
});
test('newer refresh wins over an older request',async()=>{
  const waits=[deferred(),deferred()];let i=0;const f=fixture({fetcher:()=>waits[i++].promise});try{f.toggle();f.refresh();assert.equal(f.calls[0][1].signal.aborted,true);
    const fresh=record();fresh.recipients[0].queuedAt='2026-10-05T04:00:00Z';waits[1].resolve(Response.json(fresh));await settle();waits[0].resolve(Response.json(record()));await settle();assert.match(f.root.querySelector('[data-receipt-stage="queuedAt"]').textContent,/04:00:00/);
  }finally{f.close();}
});
test('logout/reset, account-token replacement, view changes and detached nodes suppress late results',async()=>{
  for(const invalidate of [f=>{f.api.token='';f.setUser(null);f.ui.reset();},f=>{f.api.token='new-session';},f=>f.setView('inbox'),f=>{f.root.innerHTML='<p>New view</p>';f.ui.mount(f.root);}]){
    const wait=deferred(),f=fixture({fetcher:()=>wait.promise});try{f.toggle();invalidate(f);wait.resolve(Response.json(record()));await settle();assert.equal(f.root.querySelector('[data-receipt-stage]'),null);}finally{f.close();}
  }
});
test('stale unauthorized response cannot invalidate a newer login',async()=>{
  const wait=deferred(),f=fixture({fetcher:()=>wait.promise});try{f.toggle();f.api.token='new-session';wait.resolve(new Response('',{status:401}));await settle();assert.equal(f.sessionErrors,0);}finally{f.close();}
});
test('403, invalid receipts and oversized bodies fail closed without echoing server content',async()=>{
  const bad=[()=>new Response('secret server content',{status:403}),()=>Response.json(record('private')),()=>Response.json({...record(),messageId:recipientId}),()=>Response.json(record('public',{recipients:[{...record().recipients[0],queuedAt:'not a date'}]})),()=>new Response('secret server content',{headers:{'Content-Length':'262145'}})];
  for(const response of bad){const f=fixture({fetcher:async()=>response()});try{f.toggle();await settle();assert.ok(f.root.querySelector('[role="alert"]'));assert.equal(f.root.querySelector('[data-receipt-stage]'),null);assert.doesNotMatch(f.root.textContent,/secret server content/);}finally{f.close();}}
});
test('receipt response validation bounds recipients/attempts and rejects contradictory no-record payloads',()=>{
  assert.throws(()=>checkedReceipt(record('public',{recipients:Array(101).fill(record().recipients[0])}),messageId,'public'));
  assert.throws(()=>checkedReceipt(record('public',{recipients:[{...record().recipients[0],attempts:Array(101).fill({})}]}),messageId,'public'));
  assert.throws(()=>checkedReceipt(record('public',{receiptState:'no_event_record'}),messageId,'public'));
  const value=checkedReceipt(record(),messageId,'public');assert.equal(value.recipients[0].messageFetchedAt,null);
});

test('hung requests time out and cannot paint a late result',async()=>{
  const wait=deferred(),f=fixture({fetcher:()=>wait.promise,timeoutMs:10});try{f.toggle();await new Promise(resolve=>setTimeout(resolve,30));assert.match(f.root.textContent,/timed out/);assert.equal(f.calls[0][1].signal.aborted,true);wait.resolve(Response.json(record()));await settle();assert.equal(f.root.querySelector('[data-receipt-stage]'),null);}finally{f.close();}
});

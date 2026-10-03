import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import {createViewerShell,createViewerRoutes} from '../viewer.mjs';

// Execute only our own static viewer script in a controlled DOM. No Chromium,
// live accounts, external website or network request is used by this harness.
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function viewer(){
 const shell=createViewerShell(),script=shell.body.match(/<script>([\s\S]*?)<\/script>/)[1];
 const elements=new Map(['status','screen','connect','pause','token','open'].map(id=>[id,{
  value:'',textContent:'',hidden:id==='screen',disabled:['pause','open'].includes(id),src:'',listeners:new Map(),
  addEventListener(name,handler){this.listeners.set(name,handler);},removeAttribute(name){if(name==='src')this.src='';}
 }]));
 const requests=[],blobs=[],revoked=[],intervals=[],events=new Map();
 runInNewContext(script,{
  document:{querySelector:selector=>elements.get(selector.slice(1))},
  fetch(path,options){return new Promise((resolve,reject)=>requests.push({path,options,resolve,reject}));},
  URL:{createObjectURL(blob){const url='blob:fixture-'+(blobs.length+1);blobs.push({url,blob});return url;},revokeObjectURL:url=>revoked.push(url)},
  setInterval:fn=>intervals.push(fn),addEventListener:(name,fn)=>events.set(name,fn)
 });
 const click=id=>elements.get(id).listeners.get('click')();
 const connect=credential=>{elements.get('token').value=credential;click('connect');};
 const finish=async(index,body,status=200)=>{
  requests[index].resolve({ok:status>=200&&status<300,status,blob:async()=>({fixtureImage:body})});await flush();
 };
 return {shell,elements,requests,blobs,revoked,intervals,events,click,connect,finish};
}

test('viewer reconnect clears cached screen and drops an older in-flight worker image',async()=>{
 const v=viewer();v.connect('connection-A');await v.finish(0,'first-A-screen');
 assert.equal(v.elements.get('screen').hidden,false);assert.equal(v.blobs[0].blob.fixtureImage,'first-A-screen');
 v.intervals[0]();assert.equal(v.requests.length,2);
 v.connect('connection-B');
 assert.equal(v.elements.get('screen').hidden,true);assert.equal(v.elements.get('screen').src,'');
 assert.deepEqual(v.revoked,['blob:fixture-1']);assert.equal(v.elements.get('token').value,'');
 await v.finish(1,'late-A-screen');assert.equal(v.blobs.length,1);assert.equal(v.elements.get('screen').hidden,true);
 v.intervals[0]();assert.equal(v.requests[2].options.headers.Authorization,'Bearer connection-B');
 await v.finish(2,'B-screen');assert.equal(v.blobs.at(-1).blob.fixtureImage,'B-screen');
 assert.equal(v.elements.get('screen').hidden,false);
});

test('authentication failure erases cached screen, disables controls and stops polling',async()=>{
 for(const code of [401,403]){
  const v=viewer();v.connect('connection-A');await v.finish(0,'A-screen');v.intervals[0]();await v.finish(1,'denied',code);
  assert.equal(v.elements.get('screen').hidden,true);assert.equal(v.elements.get('screen').src,'');
  assert.equal(v.elements.get('open').disabled,true);assert.equal(v.elements.get('pause').disabled,true);
  assert.equal(v.elements.get('status').textContent,'Connection expired or unavailable.');
  assert.deepEqual(v.revoked,['blob:fixture-1']);v.intervals[0]();assert.equal(v.requests.length,2);
 }
});

test('disconnect and page exit discard pending screens and stop further requests',async()=>{
 for(const exit of ['pause','pagehide']){
  const v=viewer();v.connect('connection-A');if(exit==='pause')v.click('pause');else v.events.get('pagehide')();
  await v.finish(0,'late-disconnected-screen');assert.equal(v.blobs.length,0);
  assert.equal(v.elements.get('screen').hidden,true);assert.equal(v.elements.get('open').disabled,true);
  v.intervals[0]();assert.equal(v.requests.length,1);
 }
});

test('old browser-open failure cannot disconnect a newly connected worker',async()=>{
 const v=viewer();v.connect('connection-A');await v.finish(0,'A-screen');
 const opening=v.click('open');assert.equal(v.requests[1].path,'/viewer/open');
 assert.equal(v.requests[1].options.headers.Authorization,'Bearer connection-A');
 v.connect('connection-B');assert.equal(v.requests[2].options.headers.Authorization,'Bearer connection-B');
 await v.finish(1,'old-A-denied',401);await opening;
 assert.equal(v.elements.get('open').disabled,false);assert.equal(v.elements.get('pause').disabled,false);
 await v.finish(2,'B-screen');assert.equal(v.blobs.at(-1).blob.fixtureImage,'B-screen');
});

test('static viewer CSP hashes exactly authorize bundled scripts and styles without persistent tokens',()=>{
 for(const target of ['fixture','relay']){
  const shell=createViewerShell({target}),script=shell.body.match(/<script>([\s\S]*?)<\/script>/)[1],style=shell.body.match(/<style>([\s\S]*?)<\/style>/)[1];
  const digest=value=>"'sha256-"+createHash('sha256').update(value).digest('base64')+"'";
  assert.ok(shell.headers['content-security-policy'].includes('script-src '+digest(script)));
  assert.ok(shell.headers['content-security-policy'].includes('style-src '+digest(style)));
  for(const policy of ["connect-src 'self'","img-src blob:","frame-ancestors 'none'","form-action 'none'"])assert.ok(shell.headers['content-security-policy'].includes(policy));
  assert.doesNotMatch(script,/localStorage|sessionStorage|document\.cookie|location\.(?:hash|search)|URLSearchParams/);
  assert.doesNotMatch(shell.body,/connection-A|connection-B|Bearer [A-Za-z0-9_-]{32}/);
 }
});

test('viewer sends credentials only in headers on fixed same-origin paths',async()=>{
 const v=viewer();v.connect('secret-fixture-token');
 assert.equal(v.requests[0].path,'/viewer/snapshot');assert.equal(v.requests[0].options.credentials,'omit');
 assert.equal(v.requests[0].options.cache,'no-store');assert.equal(v.requests[0].options.headers.Authorization,'Bearer secret-fixture-token');
 assert.equal(v.requests[0].path.includes('secret-fixture-token'),false);await v.finish(0,'screen');
 const opening=v.click('open');assert.equal(v.requests[1].options.body,'{}');await v.finish(1,'ok');
 await v.finish(2,'refreshed');await opening;
});

test('viewer routes return only image bytes and state, never observation or target handles',async()=>{
 const context=Object.freeze({hostOnly:true}),seen=[];
 const routes=createViewerRoutes({
  async snapshot(ref){seen.push(ref);return {structuredContent:{state:'open'},content:[{type:'image',mimeType:'image/png',data:Buffer.from('controlled-image').toString('base64')}]};},
  async callTool(invocation,ref){seen.push(ref);assert.deepEqual(invocation,{name:'browser_open',arguments:{}});return {structuredContent:{sessionId:'private-session',observation:{id:'private-observation',targets:[{id:'private-target'}]}}};}
 });
 const screen=await routes['/viewer/snapshot'].handler(new Request('http://localhost/viewer/snapshot'),context);
 assert.equal(screen.headers.get('content-type'),'image/png');assert.equal(await screen.text(),'controlled-image');
 const opened=await routes['/viewer/open'].handler(new Request('http://localhost/viewer/open',{method:'POST',body:'{}'}),context);
 assert.deepEqual(await opened.json(),{state:'open'});assert.deepEqual(seen,[context,context]);
 const injected=await routes['/viewer/open'].handler(new Request('http://localhost/viewer/open',{method:'POST',body:'{"accountId":"other-worker"}'}),context);
 assert.equal(injected.status,400);assert.equal(seen.length,2);
});

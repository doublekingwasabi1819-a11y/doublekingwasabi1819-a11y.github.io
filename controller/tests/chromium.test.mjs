import test from 'node:test';
import assert from 'node:assert/strict';
import {access,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {createBrowserController} from '../core.mjs';
import {createFixtureDriverFactory} from '../playwright-driver.mjs';

const alpha={workspaceId:'fixture_workspace',accountId:'11111111-1111-4111-8111-111111111111',agentId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',runId:'run_a'};
const beta={...alpha,accountId:'22222222-2222-4222-8222-222222222222',agentId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',runId:'run_b'};
let binaryAvailable=true;try{await access(chromium.executablePath());}catch{binaryAvailable=false;}

test('real sandboxed Chromium: DOM actions, cursor, masking, stale nodes and fixture profile isolation',{
  skip:binaryAvailable?false:'Pinned Chromium binary is not installed; browser execution is NOT verified.',timeout:45000
},async t=>{
  const profileRoot=await mkdtemp(join(tmpdir(),'relay-fixture-chromium-'));
  const launches=[];
  const trustedChromium={async launchPersistentContext(path,options){
    const context=await chromium.launchPersistentContext(path,options);
    launches.push({path,context,options});return context;
  }};
  const controller=createBrowserController({authorize:async context=>context.binding,authorizeAction:async()=>true,
    createDriver:createFixtureDriverFactory({profileRoot,chromium:trustedChromium})});
  t.after(()=>controller.shutdown());
  const ac={binding:alpha},bc={binding:beta};
  const call=(name,args,context=ac)=>controller.callTool({name,arguments:args},context);
  const ok=r=>{assert.notEqual(r.isError,true,JSON.stringify(r));return r.structuredContent;};
  let opened=ok(await call('browser_open',{}));
  const sid=opened.sessionId;
  const note=opened.observation.targets.find(x=>x.role==='textbox');
  opened=ok(await call('browser_fill',{session_id:sid,observation_id:opened.observation.id,target_id:note.id,text:'fixture-only text'}));
  const page=launches[0].context.pages()[0];
  assert.equal(await page.locator('#cursor').isVisible(),true);
  assert.equal(await page.locator('[data-controller-target="note"]').inputValue(),'fixture-only text');
  const save=opened.observation.targets.find(x=>x.role==='button');
  const before=opened.observation.id;
  opened=ok(await call('browser_click',{session_id:sid,observation_id:before,target_id:save.id}));
  assert.equal(opened.observation.status,'Saved 1 test note(s).');
  const stale=await call('browser_click',{session_id:sid,observation_id:before,target_id:save.id});
  assert.equal(stale.structuredContent.error.code,'STALE_OBSERVATION');
  const screenshot=await call('browser_screenshot',{session_id:sid,observation_id:opened.observation.id});
  ok(screenshot);assert.equal(screenshot.content[0].type,'image');
  assert.equal(Buffer.from(screenshot.content[0].data,'base64').subarray(1,4).toString(),'PNG');
  assert.equal(JSON.stringify(opened).includes('fixture-only text'),false);
  assert.equal(JSON.stringify(opened).includes('fixture-secret-never-return'),false);
  // Direct evaluation is test harness setup on OUR fixed fixture, not a tool.
  await page.evaluate(()=>localStorage.setItem('fixture-profile-proof','alpha fixture'));
  ok(await call('browser_open',{},bc));
  assert.notEqual(launches[0].path,launches[1].path);
  assert.equal(await launches[1].context.pages()[0].evaluate(()=>localStorage.getItem('fixture-profile-proof')),null);
  ok(await call('browser_close',{session_id:sid}));
  const reopened=ok(await call('browser_open',{}));
  assert.equal(launches[2].path,launches[0].path);
  assert.equal(await launches[2].context.pages()[0].evaluate(()=>localStorage.getItem('fixture-profile-proof')),'alpha fixture');
  // Equal markup must not allow a stale reference to silently retarget a node.
  await launches[2].context.pages()[0].evaluate(()=>{const old=document.querySelector('[data-controller-target="save"]');old.replaceWith(old.cloneNode(true));});
  const changed=await call('browser_click',{session_id:reopened.sessionId,observation_id:reopened.observation.id,target_id:reopened.observation.targets.find(x=>x.role==='button').id});
  assert.equal(changed.structuredContent.error.code,'STALE_OBSERVATION');
  assert.ok(launches.every(x=>x.options.chromiumSandbox===true));
  // Keep fixture-only temporary profiles for failure inspection; no credentials.
});

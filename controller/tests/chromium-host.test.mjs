import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {access,mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {chromium} from 'playwright';
import {createFixtureHost,createPrivateBrowserHost} from '../serve.mjs';
import {createFixtureDriverFactory} from '../playwright-driver.mjs';

// Actual pinned Chromium, SDK HTTP transport, private host and rendered viewer.
// All credentials and pages belong to this disposable fixture. Never attach a
// human profile, expose the listener, disable a sandbox or record token images.
let binaryAvailable=true;
try{await access(chromium.executablePath());}catch{binaryAvailable=false;}
const requireChromium=process.env.RELAY_REQUIRE_CHROMIUM==='1';
const ok=result=>{
  assert.notEqual(result.isError,true,'The real fixture tool operation failed.');
  return result.structuredContent;
};

test('real sandboxed Chromium: HTTP MCP, rendered masked viewer, current targets and grant revocation',{
  skip:binaryAvailable||requireChromium?false:'Pinned Chromium is absent; the HTTP/browser/viewer pipeline is NOT verified.',
  timeout:120000
},async t=>{
  assert.equal(binaryAvailable,true,'RELAY_REQUIRE_CHROMIUM=1: pinned Chromium is missing; browser acceptance cannot skip.');
  const hosts=[],clients=[],roots=[],launches=[];
  let viewerBrowser;
  t.after(async()=>{
    // Stop viewer polling before retiring hosts. Keep fixture profiles if a
    // browser cleanup fails; deleting a lock must never hide failed teardown.
    const results=await Promise.allSettled([
      ...clients.map(client=>client.close()),
      ...(viewerBrowser?[viewerBrowser.close()]:[])
    ]);
    results.push(...await Promise.allSettled(hosts.map(host=>host.close())));
    assert.ok(results.every(result=>result.status==='fulfilled'),'Fixture browser/host cleanup failed.');
    await Promise.all(roots.map(root=>rm(root,{recursive:true,force:true})));
  });
  async function driverFactory(){
    const profileRoot=await mkdtemp(join(tmpdir(),'relay-real-http-fixture-'));
    roots.push(profileRoot);
    assert.equal((await stat(profileRoot)).mode&0o777,0o700);
    return createFixtureDriverFactory({profileRoot,chromium:{
      async launchPersistentContext(path,options){
        assert.equal(options.chromiumSandbox,true);
        const context=await chromium.launchPersistentContext(path,options);
        launches.push({context,options});
        return context;
      }
    }});
  }
  async function connect(host,token){
    const {url}=await host.listen({host:'127.0.0.1',port:0});
    const client=new Client({name:'real-chromium-fixture-client',version:'0.1.0'});
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(url),{
      requestInit:{headers:{authorization:`Bearer ${token}`}}
    }));
    assert.equal((await client.listTools()).tools.length,6);
    return {client,url,origin:new URL(url).origin};
  }
  viewerBrowser=await chromium.launch({headless:true,chromiumSandbox:true});
  const viewerContext=await viewerBrowser.newContext({
    acceptDownloads:false,serviceWorkers:'block',permissions:[],viewport:{width:1280,height:900}
  });
  let allowedOrigin;
  await viewerContext.route('**/*',async route=>{
    if(new URL(route.request().url()).origin===allowedOrigin)await route.continue();
    else await route.abort('blockedbyclient');
  });
  await viewerContext.routeWebSocket('**/*',socket=>socket.close());
  const viewer=await viewerContext.newPage();
  viewer.on('dialog',dialog=>void dialog.dismiss().catch(()=>{}));
  viewer.on('download',download=>void download.cancel().catch(()=>{}));
  async function show(origin,token,{navigate=true}={}){
    if(navigate){allowedOrigin=origin;await viewer.goto(origin+'/viewer',{waitUntil:'domcontentloaded'});}
    await viewer.getByLabel('Connection token',{exact:true}).fill(token);
    await viewer.getByRole('button',{name:'Connect',exact:true}).click();
    await viewer.locator('#screen').waitFor({state:'visible'});
    await viewer.waitForFunction(()=>{
      const image=document.querySelector('#screen');
      return image.complete&&image.naturalWidth===1280&&image.naturalHeight===720;
    });
    assert.equal(await viewer.getByLabel('Connection token',{exact:true}).inputValue(),'');
    assert.deepEqual(await viewer.evaluate(()=>({local:localStorage.length,session:sessionStorage.length})),{local:0,session:0});
    assert.equal((await viewerContext.cookies(origin)).length,0);
    assert.equal(new URL(viewer.url()).pathname,'/viewer');
    assert.equal(new URL(viewer.url()).search,'');
  }

  const token=randomBytes(32).toString('base64url');
  const fixtureHost=createFixtureHost({token,createDriver:await driverFactory()});
  hosts.push(fixtureHost);
  const fixture=await connect(fixtureHost,token);
  let opened=ok(await fixture.client.callTool({name:'browser_open',arguments:{}}));
  const sessionId=opened.sessionId;
  const note=opened.observation.targets.find(target=>target.role==='textbox');
  assert.ok(note);
  opened=ok(await fixture.client.callTool({name:'browser_fill',arguments:{
    session_id:sessionId,observation_id:opened.observation.id,target_id:note.id,text:'disposable fixture note'
  }}));
  await show(fixture.origin,token);
  // Rendering and periodic viewer snapshots must not replace the MCP agent's
  // observation or invalidate the element handles returned by browser_fill.
  const earlierSource=await viewer.locator('#screen').getAttribute('src');
  await viewer.waitForFunction(previous=>document.querySelector('#screen').getAttribute('src')!==previous,earlierSource);
  const save=opened.observation.targets.find(target=>target.role==='button');
  assert.ok(save);
  opened=ok(await fixture.client.callTool({name:'browser_click',arguments:{
    session_id:sessionId,observation_id:opened.observation.id,target_id:save.id
  }}));
  assert.equal(opened.observation.status,'Saved 1 test note(s).');
  const screenshot=await fixture.client.callTool({name:'browser_screenshot',arguments:{
    session_id:sessionId,observation_id:opened.observation.id
  }});
  ok(screenshot);
  const image=screenshot.content.find(content=>content.type==='image');
  assert.equal(image.mimeType,'image/png');
  assert.equal(Buffer.from(image.data,'base64').subarray(1,4).toString(),'PNG');
  assert.equal(JSON.stringify(opened).includes('disposable fixture note'),false);
  assert.equal(JSON.stringify(opened).includes('fixture-secret-never-return'),false);
  await show(fixture.origin,token,{navigate:false});
  const fixturePage=launches[0].context.pages()[0];
  const noteBox=await fixturePage.locator('[data-controller-target="note"]').boundingBox();
  const secretBox=await fixturePage.locator('[data-controller-mask]').boundingBox();
  const cursorBox=await fixturePage.locator('#cursor').boundingBox();
  assert.ok(noteBox&&secretBox&&cursorBox,'Actual fixture controls and cursor must be visible.');
  // Inspect the rendered PNG in memory, without a screenshot or token artifact.
  const pixels=await viewer.evaluate(async({noteBox,secretBox,cursorBox})=>{
    const image=document.querySelector('#screen');
    // Polling may replace an image while its PNG is decoding. Read pixels only
    // from a complete, decoded source; retry a bounded number of replacements.
    for(let attempt=0;attempt<3;attempt++){
      const source=image.src;
      try{await image.decode();}catch{continue;}
      if(image.src!==source||!image.complete||image.naturalWidth!==1280||image.naturalHeight!==720)continue;
      const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
      const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
      const center=box=>Array.from(ctx.getImageData(Math.floor(box.x+box.width/2),Math.floor(box.y+box.height/2),1,1).data);
      let redCursorPixels=0;
      const area=ctx.getImageData(Math.floor(cursorBox.x),Math.floor(cursorBox.y),Math.ceil(cursorBox.width),Math.ceil(cursorBox.height)).data;
      for(let i=0;i<area.length;i+=4)if(area[i]>180&&area[i+1]<110&&area[i+2]<110&&area[i+3]===255)redCursorPixels++;
      return {note:center(noteBox),secret:center(secretBox),redCursorPixels};
    }
    throw new Error('The fixture viewer image did not finish decoding.');
  },{noteBox,secretBox,cursorBox});
  assert.deepEqual(pixels.note,[17,24,39,255]);
  assert.deepEqual(pixels.secret,[17,24,39,255]);
  assert.ok(pixels.redCursorPixels>0,'The actual DOM action cursor must appear in the rendered screenshot.');
  await viewer.getByRole('button',{name:'Disconnect',exact:true}).click();
  ok(await fixture.client.callTool({name:'browser_close',arguments:{session_id:sessionId}}));
  assert.equal(launches[0].context.pages().length,0);

  // Exercise real revocation with a host-owned fixture reference and grant ID.
  const binding=Object.freeze({workspaceId:'fixture_host_revocation',accountId:randomUUID(),agentId:randomUUID(),runId:randomUUID()});
  const reference=Object.freeze({fixtureRun:binding.runId});
  const privateHost=createPrivateBrowserHost({target:'fixture',
    resolveBinding:async context=>{assert.equal(context,reference);return binding;},
    authorizeAction:async()=>true,createDriver:await driverFactory()
  });
  hosts.push(privateHost);
  const grant=privateHost.issueGrant({requestContext:reference,ttlMs:60000});
  const privateFixture=await connect(privateHost,grant.token);
  ok(await privateFixture.client.callTool({name:'browser_open',arguments:{}}));
  await show(privateFixture.origin,grant.token);
  await privateHost.revokeGrant(grant.grantId);
  await viewer.waitForFunction(()=>{
    const image=document.querySelector('#screen');
    return image.hidden&&!image.hasAttribute('src')&&document.querySelector('#open').disabled&&document.querySelector('#pause').disabled;
  });
  assert.equal(await viewer.locator('#status').textContent(),'Connection expired or unavailable.');
  assert.equal(await viewer.getByLabel('Connection token',{exact:true}).inputValue(),'');
  assert.deepEqual(await viewer.evaluate(()=>({local:localStorage.length,session:sessionStorage.length})),{local:0,session:0});
  assert.equal(launches[1].context.pages().length,0);
  const denied=await fetch(privateFixture.origin+'/viewer/snapshot',{headers:{authorization:`Bearer ${grant.token}`}});
  assert.equal(denied.status,401);
  assert.ok(launches.every(launch=>launch.options.chromiumSandbox===true));
});

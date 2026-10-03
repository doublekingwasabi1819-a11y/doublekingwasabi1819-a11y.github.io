import {createHash,randomUUID} from 'node:crypto';
import {readFile,mkdir,lstat,realpath} from 'node:fs/promises';
import {isAbsolute,join,resolve,parse} from 'node:path';
import {chromium as installedChromium} from 'playwright';
import {BrowserControllerError} from './core.mjs';

export const FIXTURE_URL='https://relay-fixture.invalid/';
const fixture=await readFile(new URL('./fixture.html',import.meta.url),'utf8');
const expected=[
  {key:'note',tag:'INPUT',type:'text',role:'textbox',name:'Test note'},
  {key:'save',tag:'BUTTON',type:'button',role:'button',name:'Save test note'}
];
const stale=()=>{throw new BrowserControllerError('STALE_OBSERVATION');};
const opaque=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(x);
const uuid=x=>typeof x==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(x);

async function privateDirectory(path,{create=false}={}) {
  if(create){try{await mkdir(path,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}}
  const stat=await lstat(path);
  // Never chmod or adopt an arbitrary existing directory. Host prepares one
  // fresh 0700 root; canonical identity rejects redirected/symlink ancestors.
  if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o777)!==0o700||typeof process.getuid!=='function'||stat.uid!==process.getuid()||await realpath(path)!==path||path===parse(path).root)throw new TypeError('A canonical, host-owned 0700 private profile directory is required.');
}

/** Fixture-only adapter. Server configuration is NEVER accepted from tool arguments.
 * Run in a dedicated non-root, network-isolated container with Chromium sandbox
 * support. Application routes are defense in depth, not an OS network boundary.
 */
export function createFixtureDriverFactory({profileRoot,chromium=installedChromium,headless=true}={}) {
  if(typeof profileRoot!=='string'||!isAbsolute(profileRoot)||resolve(profileRoot)===parse(resolve(profileRoot)).root||!chromium||typeof chromium.launchPersistentContext!=='function'||typeof headless!=='boolean')throw new TypeError('An absolute private profile root and trusted Chromium implementation are required.');
  profileRoot=resolve(profileRoot);
  const active=new Set();
  return async function createDriver({binding}) {
    if(!binding||!opaque(binding.workspaceId)||!uuid(binding.accountId)||!uuid(binding.agentId)||!opaque(binding.runId))throw new TypeError('A trusted worker binding is required.');
    // Workspace/account identity comes from live host auth, not a browser tool.
    const profileId=createHash('sha256').update(JSON.stringify([binding.workspaceId,binding.accountId.toLowerCase()])).digest('hex');
    if(active.has(profileId))throw new BrowserControllerError('LIMIT');
    active.add(profileId);
    let context;
    try {
      await privateDirectory(profileRoot);
      const profile=join(profileRoot,profileId);
      await privateDirectory(profile,{create:true});
      context=await chromium.launchPersistentContext(profile,{
        headless,chromiumSandbox:true,acceptDownloads:false,serviceWorkers:'block',
        permissions:[],viewport:{width:1280,height:720}
      });
      context.setDefaultTimeout(3000);
      await context.clearPermissions();
      // No arbitrary navigation, network requests, files, redirects or sockets.
      await context.route('**/*',async route=>{
        const request=route.request();
        if(request.url()===FIXTURE_URL&&request.method()==='GET'&&request.isNavigationRequest()&&request.resourceType()==='document'){
          await route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:fixture,
            headers:{'cache-control':'no-store','content-security-policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"}});
        }else await route.abort('blockedbyclient');
      });
      await context.routeWebSocket('**/*',socket=>socket.close());
      // Never reattach a previous live page. Persisted fixture storage is not an
      // imported real-account session and grants no Relay website access.
      for(const prior of context.pages())await prior.close();
      const page=await context.newPage();
      context.on('page',p=>{if(p!==page)void p.close().catch(()=>{});});
      page.on('dialog',dialog=>void dialog.dismiss().catch(()=>{}));
      page.on('download',download=>void download.cancel().catch(()=>{}));
      await page.goto(FIXTURE_URL,{waitUntil:'domcontentloaded',timeout:10000});
      let closed=false,closureComplete=false,targets=new Map(),revision=0;
      const assertPage=()=>{if(closed||page.isClosed()||page.url()!==FIXTURE_URL)stale();};
      // Bound snapshot of known fixture controls only. No body dump or values.
      async function snapshot() {
        assertPage();
        return page.evaluate(()=>{
        const controls=Array.from(document.querySelectorAll('[data-controller-target]')).slice(0,201);
          return {title:document.title,status:document.querySelector('[data-controller-status]')?.textContent||'',
            controls:controls.map(el=>({key:el.getAttribute('data-controller-target'),tag:el.tagName,type:el.getAttribute('type')||'',name:el.getAttribute('aria-label')||el.textContent?.trim()||'',disabled:el.disabled===true,secret:!!el.closest('[data-controller-mask]')}))};
        });
      }
      async function checkedTarget(targetId) {
        assertPage();
        const target=targets.get(targetId);
        if(!target)stale();
        const current=await snapshot();
        if(JSON.stringify(current)!==target.fingerprint)stale();
        const handles=await page.locator(`[data-controller-target="${target.key}"]`).elementHandles();
        try{if(handles.length!==1||handles[0]!==target.handle){
          // JSHandle wrappers are not identity-stable: compare the actual DOM
          // element in-page, so replacing a node with identical markup is stale.
          if(handles.length!==1||!await target.handle.evaluate((el,other)=>el===other&&el.isConnected,handles[0]))stale();
        }}finally{for(const handle of handles)if(handle!==target.handle)await handle.dispose();}
        if(!await target.handle.isVisible()||!await target.handle.isEnabled())stale();
        return target;
      }
      async function releaseTargets(){const old=targets;targets=new Map();await Promise.all([...old.values()].map(t=>t.handle.dispose().catch(()=>{})));}
      async function moveCursor(handle) {
        await handle.scrollIntoViewIfNeeded();
        const box=await handle.boundingBox();if(!box)stale();
        await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
      }
      return {
        async observe() {
          await releaseTargets();
          const current=await snapshot();
          if(current.controls.length!==expected.length||current.title!=='Relay browser test')stale();
          const advertised=[];
          for(const spec of expected){
            const matches=current.controls.filter(x=>x.key===spec.key);
            if(matches.length!==1)stale();
            const got=matches[0];if(got.tag!==spec.tag||got.type!==spec.type||got.name!==spec.name||got.disabled||got.secret)stale();
            const handles=await page.locator(`[data-controller-target="${spec.key}"]`).elementHandles();
            if(handles.length!==1)stale();
            const targetId=`t_${++revision}_${randomUUID()}`;
            targets.set(targetId,{...spec,handle:handles[0],fingerprint:JSON.stringify(current)});
            advertised.push({id:targetId,role:spec.role,name:spec.name});
          }
          // Status is generated by this fixed fixture, never an input echo.
          if(!/^(Waiting|Saved \d+ test note\(s\)\.)$/.test(current.status))stale();
          return {title:current.title,status:current.status,targets:advertised};
        },
        async click(targetId) {
          const target=await checkedTarget(targetId);
          try{await moveCursor(target.handle);await checkedTarget(targetId);await target.handle.click({timeout:3000});}
          finally{await releaseTargets();}
        },
        async fill(targetId,text) {
          const target=await checkedTarget(targetId);if(target.role!=='textbox')stale();
          try{await moveCursor(target.handle);await checkedTarget(targetId);await target.handle.fill(text,{timeout:3000});}
          finally{await releaseTargets();}
        },
        async screenshot() {
          assertPage();
          const image=await page.screenshot({type:'png',fullPage:false,
            mask:[page.locator('input, textarea, [contenteditable], [data-controller-mask]')],maskColor:'#111827'});
          assertPage();return {mimeType:'image/png',data:image.toString('base64')};
        },
        async close(){if(closureComplete)return;closed=true;await releaseTargets();await context.close();closureComplete=true;active.delete(profileId);}
      };
    }catch(error){let released=!context;try{if(context){await context.close();released=true;}}catch{/* Quarantine profile until host confirms teardown. */}if(released)active.delete(profileId);throw error;}
  };
}

import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {createBrowserController} from './core.mjs';
import {createControllerMcp} from './mcp-adapter.mjs';
import {createControllerHttp} from './http-server.mjs';
import {createFixtureDriverFactory} from './playwright-driver.mjs';
import {createBrowserGrants} from './grants.mjs';
import {createViewerShell,createViewerRoutes} from './viewer.mjs';

/** Fully explicit private host composition. No listener/account/grant is created
 * by importing this module. resolveBinding must check live worker identity and
 * browser delegation on every call, without a manager/default credential. */
export function createPrivateBrowserHost({resolveBinding,authorizeAction,createDriver,target='fixture',serverFactory,httpOptions={},controllerOptions={}}={}){
 if(!['fixture','relay'].includes(target)||typeof resolveBinding!=='function'||typeof createDriver!=='function'||typeof authorizeAction!=='function')throw new TypeError('Explicit private browser host hooks are required.');
 for(const key of ['authenticate','controller','serverFactory','routes','publicRoutes'])if(Object.hasOwn(httpOptions,key))throw new TypeError('Host authority options cannot be overridden.');
 for(const key of ['authorize','authorizeAction','createDriver'])if(Object.hasOwn(controllerOptions,key))throw new TypeError('Controller authority options cannot be overridden.');
 let grants;
 const controller=createBrowserController({...controllerOptions,authorize:context=>grants.authorize(context),authorizeAction:(action,context)=>grants.withContext(context,reference=>authorizeAction(action,reference)),createDriver});
 grants=createBrowserGrants({resolveBinding,onRevoke:async context=>{const result=await controller.revokeContext(context);if(result.isError)throw new Error('Browser cleanup failed.');}});
 const http=createControllerHttp({...httpOptions,controller,authenticate:request=>grants.authenticate(request),
  serverFactory:context=>serverFactory?serverFactory({controller,requestContext:context,target}):createControllerMcp({controller,requestContext:context,target}),
  publicRoutes:{'/viewer':createViewerShell({target})},routes:createViewerRoutes(controller)});
 return Object.freeze({
  issueGrant:options=>grants.issue(options),revokeGrant:id=>grants.revoke(id),
  fetch:request=>http.fetch(request),listen:options=>http.listen(options),
  async close(){const results=await Promise.allSettled([grants.close(),http.close()]);await controller.shutdown();if(results.some(r=>r.status==='rejected'))throw new Error('Private browser host cleanup failed.');}
 });
}

export function createFixtureHost({profileRoot,token,createDriver,now=Date.now}={}){
 if(typeof token!=='string'||!/^[A-Za-z0-9_-]{32,128}$/.test(token))throw new TypeError('A separate fixture MCP token is required.');
 const binding=Object.freeze({workspaceId:'fixture_workspace',accountId:randomUUID(),agentId:randomUUID(),runId:randomUUID()});
 const reference=Object.freeze({fixtureRun:binding.runId});
 const host=createPrivateBrowserHost({target:'fixture',resolveBinding:async context=>{if(context!==reference)throw new Error('Unknown fixture context.');return binding;},authorizeAction:async()=>true,
  createDriver:createDriver||createFixtureDriverFactory({profileRoot}),controllerOptions:{now}});
 host.issueGrant({requestContext:reference,token,ttlMs:3600000});
 return host;
}

export async function startFixtureCli({args=process.argv.slice(2),env=process.env,output=process.stdout}={}){
 if(args.length!==1||args[0]!=='--fixture')throw new TypeError('Use --fixture with explicit private fixture configuration.');
 const port=env.RELAY_BROWSER_PORT===undefined?8788:Number(env.RELAY_BROWSER_PORT);
 if(!Number.isInteger(port)||port<1||port>65535||!env.RELAY_BROWSER_PROFILES)throw new TypeError('A private fixture profile root and valid port are required.');
 const host=createFixtureHost({profileRoot:env.RELAY_BROWSER_PROFILES,token:env.RELAY_FIXTURE_MCP_TOKEN});
 try{const {url}=await host.listen({host:'127.0.0.1',port});output.write(`Fixture MCP: ${url}\nPrivate viewer: ${new URL('/viewer',url)}\n`);return host;}catch(error){await host.close();throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 let host;try{host=await startFixtureCli();}catch{process.stderr.write('Fixture host could not start. Check the explicit fixture configuration.\n');process.exitCode=1;}
 if(host)for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{void host.close().catch(()=>{process.exitCode=1;});});
}

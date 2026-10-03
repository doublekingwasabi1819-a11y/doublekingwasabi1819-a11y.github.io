import {fromJsonSchema} from '@modelcontextprotocol/server';
import {createPrivateBrowserHost} from './serve.mjs';
import {createControllerMcp} from './mcp-adapter.mjs';
import {createRelayDriverFactory} from './relay-driver.mjs';
import {installRelayToolMetadata, relayBrowserToolDescriptors, relayDirectToolDescriptors} from './mcp-tool-metadata.mjs';

const UUID=/^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/;
const definitions=relayDirectToolDescriptors;
const plain=x=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
const validId=x=>typeof x==='string'&&UUID.test(x);
const count=x=>Number.isSafeInteger(x)&&x>=0;
const same=(a,b)=>a.toLowerCase()===b.toLowerCase();
const boundedText=(x,max)=>typeof x==='string'&&[...x].length<=max&&Buffer.byteLength(x)<=max*4;
const canonical=x=>Array.isArray(x)?x.map(canonical):plain(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
function jsonValue(value,depth=0,state={nodes:0,path:new Set()}){
  if(depth>16||++state.nodes>1024)return false;
  if(value===null||typeof value==='boolean'||typeof value==='string')return typeof value!=='string'||value.length<=12000;
  if(typeof value==='number')return Number.isFinite(value);
  if(!(Array.isArray(value)||plain(value))||state.path.has(value))return false;
  const keys=Object.keys(value);if(keys.length>200)return false;state.path.add(value);
  const valid=keys.every(key=>{const descriptor=Object.getOwnPropertyDescriptor(value,key);return descriptor&&Object.hasOwn(descriptor,'value')&&jsonValue(descriptor.value,depth+1,state);});state.path.delete(value);return valid;
}
const schemaEqual=(a,b)=>jsonValue(a)&&JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const messages={VALIDATION:'Invalid Relay tool arguments.',UNKNOWN_TOOL:'Unknown Relay tool.',AUTH_REQUIRED:'Relay authentication is required.',SESSION:'Relay authentication is required.',STALE_SESSION:'This Relay worker run changed.',DELETED:'This Relay workspace is unavailable.',FORBIDDEN:'This connection cannot access that Relay worker or operation.',CONFLICT:'This message identifier was used for different content.',NOT_FOUND:'The Relay recipient or message is unavailable.',RATE_LIMIT:'Relay rate limit reached. Retry later.',NETWORK:'Relay is temporarily unreachable. Preserve the message identifier after an uncertain send.',INTERNAL:'Relay could not complete this request.'};
function failure(error){const code=Object.hasOwn(messages,error?.code)?error.code:'INTERNAL',message=messages[code];return {isError:true,structuredContent:{error:{code,message}},content:[{type:'text',text:message}]};}
const invalid=()=>{const error=new Error(messages.INTERNAL);error.code='INTERNAL';throw error;};
function exact(value,keys){if(!plain(value)||Object.keys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(value,k)))invalid();return value;}
function trustedRegistry(adapter){
  if(!plain(adapter)||Object.keys(adapter).some(k=>!['tools','callTool'].includes(k))||typeof adapter.callTool!=='function'||!Array.isArray(adapter.tools)||adapter.tools.length!==definitions.length)throw new TypeError('An explicit five-tool Relay adapter is required.');
  const seen=new Set();
  for(const tool of adapter.tools){
    const expected=definitions.find(d=>d.name===tool?.name);
    if(!plain(tool)||!expected||seen.has(tool.name)||Object.keys(tool).some(k=>!['name','description','inputSchema','annotations','securitySchemes'].includes(k))||!schemaEqual(tool.inputSchema,expected.inputSchema)||!boundedText(tool.description,1000))throw new TypeError('Only the exact strict Relay tool registry is supported.');
    if(!plain(tool.annotations)||Object.keys(tool.annotations).some(k=>!['readOnlyHint','destructiveHint','idempotentHint','openWorldHint'].includes(k))||tool.annotations.readOnlyHint!==expected.annotations.readOnlyHint||tool.annotations.destructiveHint!==false||tool.annotations.idempotentHint!==true||tool.annotations.openWorldHint!==false)throw new TypeError('Relay tool annotations must match the trusted registry.');
    // PR15's standalone adapter declares only its own read/write scope. This
    // combined host's published descriptors also require browser:control.
    if(!schemaEqual(tool.securitySchemes,[{type:'oauth2',scopes:[expected.annotations.readOnlyHint?'relay:read':'relay:write']}]))throw new TypeError('Relay tool scope declarations must match the trusted registry.');
    seen.add(tool.name);
  }
  // Capture the injected adapter method, not a mutable future registry. Models
  // never provide the adapter, source code, authority, profile, or credentials.
  return {callTool:adapter.callTool.bind(adapter),tools:structuredClone(definitions)};
}
function bindingFor(value){
  if(!plain(value)||!validId(value.accountId)||!validId(value.agentId)||typeof value.workspaceId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(value.workspaceId)||typeof value.runId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(value.runId))invalid();
  return {accountId:value.accountId.toLowerCase(),agentId:value.agentId.toLowerCase()};
}
function message(value,owner,peer){
  exact(value,['id','senderId','recipientId','body','createdAt','readAt']);
  if(!validId(value.id)||!validId(value.senderId)||!validId(value.recipientId)||same(value.senderId,value.recipientId)||!boundedText(value.body,12000)||!boundedText(value.createdAt,100)||!(value.readAt===null||boundedText(value.readAt,100))||![value.senderId,value.recipientId].some(id=>same(id,owner)))invalid();
  if(peer&&!((same(value.senderId,owner)&&same(value.recipientId,peer))||(same(value.recipientId,owner)&&same(value.senderId,peer))))invalid();return value;
}
function checkedOutput(name,value,args,binding){
  const owner=binding.accountId;
  switch(name){
    case 'relay_fast_identity':{
      exact(value,['user','unreadDirectMessages']);exact(value.user,['id','name','role','agentId']);
      if(!validId(value.user.id)||!same(value.user.id,owner)||!validId(value.user.agentId)||!same(value.user.agentId,binding.agentId)||value.user.role!=='worker'||!boundedText(value.user.name,200)||!count(value.unreadDirectMessages))invalid();break;
    }
    case 'relay_fast_inbox':{
      exact(value,['contacts','threads','unreadCount']);if(!Array.isArray(value.contacts)||value.contacts.length>1000||!Array.isArray(value.threads)||value.threads.length>1000||!count(value.unreadCount))invalid();
      for(const contact of value.contacts){exact(contact,['id','name','role','enabled']);if(!validId(contact.id)||same(contact.id,owner)||!boundedText(contact.name,200)||!['worker','manager'].includes(contact.role)||typeof contact.enabled!=='boolean')invalid();}
      for(const thread of value.threads){exact(thread,['participantA','participantB','lastMessage','unreadCount']);if(!validId(thread.participantA)||!validId(thread.participantB)||same(thread.participantA,thread.participantB)||![thread.participantA,thread.participantB].some(id=>same(id,owner))||!count(thread.unreadCount))invalid();message(thread.lastMessage,owner,same(thread.participantA,owner)?thread.participantB:thread.participantA);}break;
    }
    case 'relay_fast_thread':exact(value,['messages','hasMore']);if(!Array.isArray(value.messages)||value.messages.length>50||typeof value.hasMore!=='boolean')invalid();for(const row of value.messages)message(row,owner,args.recipient_id);break;
    case 'relay_fast_send':exact(value,['message']);message(value.message,owner,args.recipient_id);if(!same(value.message.senderId,owner)||value.message.body!==args.body)invalid();break;
    case 'relay_fast_mark_read':exact(value,['markedRead','unreadCount']);if(!count(value.markedRead)||value.markedRead>args.message_ids.length||!count(value.unreadCount))invalid();break;
    default:invalid();
  }
  const serialized=JSON.stringify(value);if(Buffer.byteLength(serialized)>4_000_000)invalid();
  return {structuredContent:JSON.parse(serialized),content:[{type:'text',text:serialized}]};
}

/**
 * Composition only; import does not start Chromium, listen, log in, or issue a
 * grant. Supply live worker/delegation resolvers and explicit action permission.
 * The optional PR15 adapter is injected as {tools,callTool}, so standalone
 * controller builds require no parent repository files. Its own Relay read/write
 * scopes still apply in addition to this host's live browser delegation.
 * The adapter's request-scoped credential resolver must bind the original host
 * reference permanently to this same workspace/worker/agent/run. Reconnecting a
 * different identity requires a new reference/grant; never remap an old one.
 *
 * createDriver is a TRUSTED TEST ONLY override for controlled fixture testing.
 * Production omits it and uses the fixed-origin sandboxed Relay driver. There is
 * no CLI, automatic account selection, imported session, or public deployment.
 */
export function createRelayBrowserHost({profileRoot,resolveBinding,resolveWorkerSession,authorizeAction,relayAdapter,chromium,headless=true,httpOptions={},controllerOptions={},createDriver}={}){
  if(typeof resolveBinding!=='function'||typeof resolveWorkerSession!=='function'||typeof authorizeAction!=='function'||(createDriver!==undefined&&typeof createDriver!=='function'))throw new TypeError('Explicit trusted Relay worker and action hooks are required.');
  const adapter=relayAdapter===undefined?undefined:trustedRegistry(relayAdapter);
  const factory=createDriver||createRelayDriverFactory({profileRoot,resolveWorkerSession,...(chromium===undefined?{}:{chromium}),headless});
  return createPrivateBrowserHost({resolveBinding,authorizeAction,createDriver:factory,target:'relay',httpOptions,controllerOptions,
    serverFactory:({controller,requestContext,target,withRequestContext})=>{
      if(typeof withRequestContext!=='function')throw new TypeError('A live trusted request-context hook is required.');
      const server=createControllerMcp({controller,requestContext,target});
      for(const tool of adapter?.tools||[])server.registerTool(tool.name,{description:tool.description,annotations:structuredClone(tool.annotations),inputSchema:fromJsonSchema(structuredClone(tool.inputSchema)),_meta:structuredClone(tool._meta)},async args=>{
        try{return await withRequestContext(async(reference,anchoredBinding)=>{
          // Ownership comes from the grant's pinned live check, never a second
          // raw resolver that could silently select another worker or run.
          const binding=bindingFor(anchoredBinding);
          const copied=structuredClone(args),result=await adapter.callTool({name:tool.name,arguments:structuredClone(copied)},reference);
          if(result?.isError)return failure(result.structuredContent?.error);
          return checkedOutput(tool.name,result?.structuredContent,copied,binding);
        });}catch(error){return failure(error);}
      });
      installRelayToolMetadata(server,[...relayBrowserToolDescriptors,...(adapter?.tools||[])]);
      return server;
    }
  });
}

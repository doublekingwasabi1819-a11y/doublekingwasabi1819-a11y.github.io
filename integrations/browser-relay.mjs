import {RelayAPI} from '../api.mjs';

// Server-side integration only. This is not an MCP transport or Chromium host.
const UUID=/^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/;
const TOKEN=/^[a-f0-9]{64}$/;
const text={type:'string'};
const uuid={type:'string',pattern:UUID.source};
const schema=(properties={},required=[])=>({type:'object',properties,required,additionalProperties:false});
const definitions=[
  ['relay_fast_identity','Read the authenticated Relay worker identity and unread count.',schema(),true,'relay:read'],
  ['relay_fast_inbox','Read this worker’s DM contacts, conversation previews, and unread count.',schema(),true,'relay:read'],
  ['relay_fast_thread','Read this worker’s conversation with one resolved recipient. Does not mark messages read.',schema({recipient_id:uuid,before_id:uuid},['recipient_id']),true,'relay:read'],
  ['relay_fast_send','Send an authorized DM to a resolved account ID. Reuse the same client_id and body after an uncertain send.',schema({recipient_id:uuid,body:{...text,minLength:1,maxLength:12000},client_id:uuid},['recipient_id','body','client_id']),false,'relay:write'],
  ['relay_fast_mark_read','Acknowledge only the incoming message IDs you actually read. Do not acknowledge future arrivals.',schema({message_ids:{type:'array',items:uuid,maxItems:100,uniqueItems:true}},['message_ids']),false,'relay:write']
];

export const relayTools=definitions.map(([name,description,inputSchema,readOnlyHint,scope])=>({
  name,description,inputSchema:structuredClone(inputSchema),
  annotations:{readOnlyHint,destructiveHint:false,idempotentHint:true,openWorldHint:false},
  securitySchemes:[{type:'oauth2',scopes:[scope]}]
}));

export class RelayIntegrationError extends Error {
  constructor(code){super(messages[code]||messages.INTERNAL);this.name='RelayIntegrationError';this.code=code;}
}
const messages={
  VALIDATION:'Invalid Relay tool arguments.',
  UNKNOWN_TOOL:'Unknown Relay integration tool.',
  SESSION:'Relay authentication is required. Reconnect the worker account.',
  STALE_SESSION:'This Relay worker run changed. Reconnect and read the current handoff.',
  DELETED:'This Relay workspace is unavailable.',
  FORBIDDEN:'This connection cannot access that Relay worker or operation.',
  CONFLICT:'This client message ID was used for different content.',
  NOT_FOUND:'The Relay recipient or message is unavailable.',
  RATE_LIMIT:'Relay rate limit reached. Retry later.',
  NETWORK:'Relay is temporarily unreachable. Do not repeat an uncertain send with a new client ID.',
  INTERNAL:'Relay could not complete this request.'
};
const fail=code=>{throw new RelayIntegrationError(code);};
const validUUID=v=>typeof v==='string'&&UUID.test(v);
const validRun=v=>typeof v==='string'&&v.length>0&&v.length<=128;
const nonnegative=v=>Number.isSafeInteger(v)&&v>=0;
const same=(a,b)=>a.toLowerCase()===b.toLowerCase();
const pick=(value,keys)=>Object.fromEntries(keys.filter(k=>Object.hasOwn(value,k)).map(k=>[k,value[k]]));

function validateArguments(name,args) {
  const definition=definitions.find(row=>row[0]===name);
  if(!definition)fail('UNKNOWN_TOOL');
  const input=definition[2];
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.getPrototypeOf(args)!==Object.prototype)fail('VALIDATION');
  if(Object.keys(args).some(k=>!Object.hasOwn(input.properties,k))||input.required.some(k=>!Object.hasOwn(args,k)))fail('VALIDATION');
  for(const key of ['recipient_id','before_id','client_id'])if(Object.hasOwn(args,key)&&!validUUID(args[key]))fail('VALIDATION');
  if(Object.hasOwn(args,'body')&&(typeof args.body!=='string'||!args.body.trim()||[...args.body].length>12000||new TextEncoder().encode(args.body).byteLength>48000))fail('VALIDATION');
  if(Object.hasOwn(args,'message_ids')&&(!Array.isArray(args.message_ids)||args.message_ids.length>100||args.message_ids.some(v=>!validUUID(v))||new Set(args.message_ids.map(v=>v.toLowerCase())).size!==args.message_ids.length))fail('VALIDATION');
  // Snapshot arguments before authentication awaits, preventing mutation races.
  return {scope:definition[4],args:structuredClone(args)};
}

function messageDTO(value,accountId,recipientId) {
  if(!value||!validUUID(value.id)||!validUUID(value.senderId)||!validUUID(value.recipientId)||typeof value.body!=='string'||typeof value.createdAt!=='string'||!(value.readAt===null||typeof value.readAt==='string')||!([value.senderId,value.recipientId].some(id=>same(id,accountId))))fail('INTERNAL');
  if(recipientId&&!((same(value.senderId,accountId)&&same(value.recipientId,recipientId))||(same(value.recipientId,accountId)&&same(value.senderId,recipientId))))fail('INTERNAL');
  return pick(value,['id','senderId','recipientId','body','createdAt','readAt']);
}

function inboxDTO(value,accountId) {
  if(!value||!Array.isArray(value.contacts)||!Array.isArray(value.threads)||!nonnegative(value.unreadCount))fail('INTERNAL');
  return {
    contacts:value.contacts.map(c=>{
      if(!validUUID(c.id)||typeof c.name!=='string'||!['worker','manager'].includes(c.role)||typeof c.enabled!=='boolean'||same(c.id,accountId))fail('INTERNAL');
      return pick(c,['id','name','role','enabled']);
    }),
    threads:value.threads.map(t=>{
      if(!validUUID(t.participantA)||!validUUID(t.participantB)||same(t.participantA,t.participantB)||![t.participantA,t.participantB].some(id=>same(id,accountId))||!nonnegative(t.unreadCount))fail('INTERNAL');
      const recipientId=same(t.participantA,accountId)?t.participantB:t.participantA;
      return {participantA:t.participantA,participantB:t.participantB,lastMessage:messageDTO(t.lastMessage,accountId,recipientId),unreadCount:t.unreadCount};
    }),unreadCount:value.unreadCount
  };
}

/**
 * resolveSession must authenticate the MCP request OUTSIDE tool arguments and
 * return {token,accountId,runId,scopes}. Token stays server-side. Never use a
 * shared manager session, browser cookie extraction, or bridge.mjs global client.
 */
export function createRelayIntegration({base,workspaceId,resolveSession,fetcher=globalThis.fetch}={}) {
  const url=new URL(base);
  if(url.protocol!=='https:'||url.username||url.password||url.hash||url.search||!validRun(workspaceId)||typeof resolveSession!=='function')throw new Error('Use a pinned HTTPS Relay API, workspace ID, and authenticated request resolver.');

  async function authorize(requestContext,scope) {
    const resolved=await resolveSession(requestContext);
    if(!resolved||typeof resolved.token!=='string'||!TOKEN.test(resolved.token)||!validUUID(resolved.accountId)||!validRun(resolved.runId)||!Array.isArray(resolved.scopes))fail('SESSION');
    // Copy immutable authority; resolver-owned mutable objects cannot change it.
    const {token,accountId,runId}=resolved;
    if(!resolved.scopes.includes(scope))fail('FORBIDDEN');
    const client=new RelayAPI({base:url.href,fetcher,storage:null});
    client.token=token;
    const context=await client.context();
    const user=context?.user,actor=context?.actor;
    if(!user||!validUUID(user.id)||user.role!=='worker'||user.enabled!==true||!validUUID(user.agentId)||!actor||!validUUID(actor.id)||!same(actor.id,user.agentId)||actor.owner!==false||!validRun(actor.session))fail('FORBIDDEN');
    if(!same(user.id,accountId))fail('FORBIDDEN');
    if(actor.session!==runId)fail('STALE_SESSION');
    return {client,context,binding:{workspaceId,accountId:user.id,agentId:user.agentId,runId:actor.session}};
  }

  return {
    // Internal host hook: validate before EVERY browser action, even with a
    // persistent profile. Steve's host must also serialize that profile's actions.
    async authorizeBrowser(requestContext) {
      try {return (await authorize(requestContext,'browser:control')).binding;}
      catch(error){throw safeError(error);}
    },
    async callTool(invocation={},requestContext) {
      try {
        if(!invocation||typeof invocation!=='object'||Array.isArray(invocation)||Object.keys(invocation).some(k=>!['name','arguments'].includes(k)))fail('VALIDATION');
        const {name,arguments:input={}}=invocation;
        const {scope,args}=validateArguments(name,input);
        const {client,context,binding}=await authorize(requestContext,scope);
        const accountId=binding.accountId;
        if(args.recipient_id&&same(args.recipient_id,accountId))fail('VALIDATION');
        let result;
        switch(name) {
          case 'relay_fast_identity': {
            if(typeof context.user.name!=='string'||!nonnegative(context.notifications?.unreadDirectMessages))fail('INTERNAL');
            result={user:pick(context.user,['id','name','role','agentId']),unreadDirectMessages:context.notifications.unreadDirectMessages};break;
          }
          case 'relay_fast_inbox':result=inboxDTO(await client.call('dm.inbox'),accountId);break;
          case 'relay_fast_thread': {
            const value=await client.call('dm.thread',{participantA:accountId,participantB:args.recipient_id,...(args.before_id?{beforeId:args.before_id}:{})});
            if(!Array.isArray(value?.messages)||value.messages.length>50||typeof value.hasMore!=='boolean')fail('INTERNAL');
            result={messages:value.messages.map(m=>messageDTO(m,accountId,args.recipient_id)),hasMore:value.hasMore};break;
          }
          case 'relay_fast_send': {
            const value=await client.call('dm.send',{recipientId:args.recipient_id,body:args.body,clientId:args.client_id});
            const message=messageDTO(value?.message,accountId,args.recipient_id);
            if(!same(message.senderId,accountId))fail('INTERNAL');
            result={message};break;
          }
          case 'relay_fast_mark_read': {
            const value=await client.call('dm.read',{messageIds:args.message_ids});
            if(!nonnegative(value?.markedRead)||value.markedRead>args.message_ids.length||!nonnegative(value.unreadCount))fail('INTERNAL');
            result={markedRead:value.markedRead,unreadCount:value.unreadCount};break;
          }
        }
        return {structuredContent:result,content:[{type:'text',text:JSON.stringify(result)}]};
      }catch(error){const safe=safeError(error);return {isError:true,structuredContent:{error:{code:safe.code,message:safe.message}},content:[{type:'text',text:safe.message}]};}
    }
  };
}

function safeError(error) {
  // Never echo arbitrary upstream/resolver errors: they may include credentials.
  return new RelayIntegrationError(Object.hasOwn(messages,error?.code)?error.code:'INTERNAL');
}

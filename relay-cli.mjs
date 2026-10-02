#!/usr/bin/env node
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {RelayAPI} from './api.mjs';
import {newId,handoff} from './engine.mjs';

/** Credentials come only from the process environment, never command arguments. */
export async function environment(env=process.env,{fetcher=globalThis.fetch}={}) {
  const base=env.RELAY_API_URL;
  if(!base)throw new Error('Set RELAY_API_URL to your Relay account API address.');
  const store=new RelayAPI({base,fetcher,storage:null});
  if(env.RELAY_SESSION_TOKEN) {
    store.token=env.RELAY_SESSION_TOKEN;
  } else {
    if(!env.RELAY_USERNAME||!env.RELAY_PASSWORD)throw new Error('Provide RELAY_SESSION_TOKEN, or RELAY_USERNAME and RELAY_PASSWORD, through environment secrets. Do not pass credentials as command arguments.');
    const role=env.RELAY_LOGIN_ROLE||'worker';
    if(!['worker','manager'].includes(role))throw new Error('RELAY_LOGIN_ROLE must be worker or manager. Choosing a role never grants additional permissions.');
    await store.login({role,username:env.RELAY_USERNAME,password:env.RELAY_PASSWORD});
  }
  // The server derives the account and actor. No RELAY_OWNER or agent-ID override.
  return {store};
}

async function input(file) {
  if(file&&file!=='-')return readFile(file,'utf8');
  let text='';for await(const chunk of process.stdin)text+=chunk;return text;
}

export async function main(args=process.argv.slice(2)) {
  const [command,file,version]=args;
  if(!['read','handoff','apply','room-read','room-save'].includes(command))throw new Error('Usage: node relay-cli.mjs read | handoff [agent-id] | apply operation.json | room-read | room-save notes.txt expected-version (use - for stdin)');
  const {store}=await environment();
  if(command==='read')return store.read();
  if(command==='handoff') {
    const context=await store.read();
    const id=file||context.actor?.id;
    if(!context.state.agents.some(agent=>agent.id===id))throw new Error('Choose a worker agent ID for its handoff. Worker accounts use their own slot by default.');
    return handoff(context.state,id,store.base);
  }
  if(command==='room-read')return store.call('room.read');
  if(command==='room-save') {
    if(!/^\d+$/.test(version||'')||!Number.isSafeInteger(Number(version)))throw new Error('Read your room first, then supply its current version with room-save.');
    return store.call('room.save',{body:await input(file),expectedVersion:Number(version)});
  }
  const operation=JSON.parse(await input(file));
  if(!operation||typeof operation!=='object'||Array.isArray(operation))throw new Error('Operation must be a JSON object.');
  operation.id||=newId();
  const state=await store.mutate(operation);
  return {ok:true,operationId:operation.id,revision:state.revision};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {const result=await main();console.log(typeof result==='string'?result:JSON.stringify(result,null,2));}
  catch(error){console.error(error.message);process.exitCode=1;}
}

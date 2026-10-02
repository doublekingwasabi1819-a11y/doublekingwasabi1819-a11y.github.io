#!/usr/bin/env node
import readline from 'node:readline';
import {pathToFileURL} from 'node:url';
import {environment} from './relay-cli.mjs';
import {newId,handoff} from './engine.mjs';
let configured;
async function client(){if(!configured)configured=environment();try{return await configured;}catch(error){configured=null;throw error;}}
const string={type:'string'};
const definitions=[
 ['relay_dm_inbox','Read private conversation previews, worker contacts, and your unread count. Only participants and the manager can read DMs.',{},[]],
 ['relay_dm_thread','Read up to 50 private messages between two account IDs. Does not mark messages read.',{participant_a:string,participant_b:string,before_id:string},['participant_a','participant_b']],
 ['relay_dm_send','Send a private message. Only sender, recipient, and manager can read it. Use the same client_id when retrying an uncertain send.',{recipient_id:string,body:string,client_id:string},['recipient_id','body','client_id']],
 ['relay_dm_read','Mark only specified incoming messages as read after reading them. Manager inspection does not mark workers’ messages read.',{message_ids:{type:'array',items:string,maxItems:100}},['message_ids']],
 ['relay_read','Read the signed-in worker’s identity, private room, project rules, assignments and messages.',{},[]],
 ['relay_room_read','Read your own landing-room notes and version. The manager can also access worker rooms.',{},[]],
 ['relay_room_save','Save your own room notes against the version you read. Conflicting changes are rejected.',{body:string,expected_version:{type:'integer',minimum:0}},['body','expected_version']],
 ['relay_claim','Atomically claim an unowned ready task for the signed-in worker.',{task_id:string,operation_id:string},['task_id']],
 ['relay_checkpoint','Save progress and next steps. This does not automatically submit for review.',{task_id:string,checkpoint:string,evidence:string,status:{type:'string',enum:['working','blocked']},operation_id:string},['task_id','checkpoint']],
 ['relay_submit','Submit your task for independent review with actual test results and code links.',{task_id:string,checkpoint:string,evidence:string,operation_id:string},['task_id','checkpoint','evidence']],
 ['relay_message','Post a shared project message, optionally directed to an agent or attached to a task. Directed messages are visible to the team.',{body:string,to:string,task_id:string,operation_id:string},['body']],
 ['relay_question','Ask the project manager for a decision or help with a blocker.',{title:string,body:string,task_id:string,operation_id:string},['title','body']],
 ['relay_review','Review another agent’s submitted task. Self-review is rejected.',{task_id:string,approve:{type:'boolean'},review:string,operation_id:string},['task_id','approve','review']],
 ['relay_checkin','Record contact or a standalone handoff checkpoint.',{checkpoint:string,operation_id:string},[]]
].map(([name,description,properties,required])=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false}}));
const content=value=>({content:[{type:'text',text:JSON.stringify(value)}]});

export async function handle(msg,getClient=client) {
  if(msg.method==='initialize')return {protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'relay-studio',version:'2.1.0'},instructions:'Read the project before acting. The server authorizes your signed-in account; role or actor fields cannot grant access. Your room is separate from the shared board and is also accessible to the manager. Private messages are readable only by participants and manager. Check relay_dm_inbox at task start, checkpoints, and before stopping. Notifications appear in tool results; they cannot wake an inactive chat. Save concrete checkpoints and test evidence. Do not self-review. Never put credentials in notes or messages.'};
  if(msg.method==='ping')return {};
  if(msg.method==='tools/list')return {tools:definitions};
  if(msg.method!=='tools/call')throw Object.assign(new Error('Method not found'),{code:-32601});
  try {
    const {name,arguments:a={}}=msg.params||{};
    if(!definitions.some(tool=>tool.name===name))throw new Error('Unknown tool.');
    if(!a||typeof a!=='object'||Array.isArray(a))throw new Error('Tool arguments must be an object.');
    const {store}=await getClient();
    if(name==='relay_read') {
      const context=await store.read(),s=context.state,id=context.actor?.id;
      const own=s.agents.find(agent=>agent.id===id);
      return content({user:context.user,room:context.room,notifications:context.notifications,revision:s.revision,project:s.project,agent:own,tasks:s.tasks,requests:s.requests.filter(row=>row.status==='open'),memory:s.memory,messages:s.messages.slice(-60),handoff:own?handoff(s,id,store.base):null});
    }
    if(name==='relay_dm_inbox')return content(await store.call('dm.inbox'));
    if(name==='relay_dm_thread')return content(await store.call('dm.thread',{participantA:a.participant_a,participantB:a.participant_b,...(a.before_id?{beforeId:a.before_id}:{})}));
    if(name==='relay_dm_send')return content(await store.call('dm.send',{recipientId:a.recipient_id,body:a.body,clientId:a.client_id}));
    if(name==='relay_dm_read')return content(await store.call('dm.read',{messageIds:a.message_ids}));
    if(name==='relay_room_read')return content(await store.call('room.read'));
    if(name==='relay_room_save')return content(await store.call('room.save',{body:a.body,expectedVersion:a.expected_version}));
    let type,payload;
    switch(name) {
      case'relay_claim':type='task.claim';payload={taskId:a.task_id};break;
      case'relay_checkpoint':type='task.progress';payload={taskId:a.task_id,checkpoint:a.checkpoint,evidence:a.evidence,status:a.status||'working'};break;
      case'relay_submit':type='task.progress';payload={taskId:a.task_id,checkpoint:a.checkpoint,evidence:a.evidence,status:'review'};break;
      case'relay_message':type='message.add';payload={body:a.body,to:a.to,taskId:a.task_id};break;
      case'relay_question':type='request.add';payload={title:a.title,body:a.body,taskId:a.task_id};break;
      case'relay_review':type='task.review';payload={taskId:a.task_id,approve:a.approve,review:a.review};break;
      case'relay_checkin':type='agent.checkpoint';payload={checkpoint:a.checkpoint};break;
    }
    const id=a.operation_id||newId();
    const state=await store.mutate({id,type,payload});
    return content({ok:true,revision:state.revision,operationId:id,notifications:store.snapshot?.notifications});
  } catch(error){return {isError:true,content:[{type:'text',text:error.message}]};}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const input=readline.createInterface({input:process.stdin,crlfDelay:Infinity});let queue=Promise.resolve();
  input.on('line',line=>{queue=queue.then(async()=>{
    let msg;try{msg=JSON.parse(line);}catch{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}})+'\n');return;}
    if(msg.id===undefined)return;
    try{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:await handle(msg)})+'\n');}
    catch(error){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,error:{code:error.code||-32603,message:error.message}})+'\n');}
  });});
}

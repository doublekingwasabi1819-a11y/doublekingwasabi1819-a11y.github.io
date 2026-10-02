// Uses only a disposable local database, never the live studio.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {emptyState} from '../engine.mjs';
const host=process.env.RELAY_TEST_HOST||'/tmp/relay-dm-pg',port=process.env.RELAY_TEST_PORT||'55432';
if(!host.startsWith('/tmp/'))throw Error('Tests require a local /tmp Unix socket');
const q=x=>"'"+String(x).replaceAll("'","''")+"'";
function sql(query,fail=false){const r=spawnSync('psql',['-U','postgres','-h',host,'-p',port,'-d','relay_dm_test','-X','-qAt','-v','ON_ERROR_STOP=1'],{input:query,encoding:'utf8'});if(fail){assert.notEqual(r.status,0);return r.stderr;}assert.equal(r.status,0,r.stderr);return r.stdout.trim();}
const rpc=(a,t='',d={})=>JSON.parse(sql(`set role service_role;select public.${a.startsWith('dm.')?'relay_dm_rpc':'relay_rpc'}(${q(a)},${q(t)},${q(JSON.stringify(d))}::jsonb);`));
const ok=r=>{assert.equal(r.error,undefined,JSON.stringify(r));return r;};
let checks=0;const check=(name,f)=>{f();checks++;console.log('PASS '+name);};
sql('drop function if exists public.relay_dm_rpc(text,text,jsonb);drop function if exists public.relay_rpc(text,text,jsonb);drop schema if exists relay_private cascade;');
sql(readFileSync(new URL('../backend/schema.sql',import.meta.url),'utf8'));
const code=randomBytes(32).toString('hex'),password=randomBytes(20).toString('hex');
sql(`update relay_private.studio set setup_hash=${q(createHash('sha256').update(code).digest('hex'))};`);
const manager=ok(rpc('setup','',{setupCode:code,name:'Manager',username:'manager',password,state:emptyState()}));
const users=[];for(const name of ['alpha','beta','charlie']){const u=ok(rpc('workers.create',manager.token,{name,username:name,password}));const login=ok(rpc('login','',{role:'worker',username:name,password}));users.push({...u,token:login.token});}
const [a,b,c]=users,mid=ok(rpc('context',manager.token)).user.id;
let first,second;
check('DMs are isolated from unrelated workers, board state and handoffs',()=>{
 first=ok(rpc('dm.send',a.token,{recipientId:b.id,body:'Private A to B <script>literal</script>',clientId:randomUUID(),senderId:c.id,role:'manager'})).message;
 assert.equal(first.senderId,a.id);
 const thread={participantA:a.id,participantB:b.id};
 for(const token of [a.token,b.token,manager.token])assert.equal(ok(rpc('dm.thread',token,thread)).messages[0].body,first.body);
 assert.equal(rpc('dm.thread',c.token,thread).error.code,'FORBIDDEN');
 const ci=ok(rpc('dm.inbox',c.token));assert.equal(ci.threads.length,0);assert.equal(ci.unreadCount,0);assert.ok(!JSON.stringify(ci).includes(first.body));
 assert.ok(!JSON.stringify(ok(rpc('context',c.token))).includes(first.body));
 assert.equal(ok(rpc('dm.inbox',b.token)).unreadCount,1);
 assert.equal(ok(rpc('dm.notifications',b.token)).unreadDirectMessages,1);
 assert.equal(ok(rpc('dm.inbox',manager.token)).threads.length,1);
});
check('Manager and sender cannot consume recipient unread state',()=>{
 assert.equal(ok(rpc('dm.read',manager.token,{messageIds:[first.id]})).markedRead,0);
 assert.equal(ok(rpc('dm.read',a.token,{messageIds:[first.id]})).markedRead,0);
 assert.equal(ok(rpc('dm.read',c.token,{messageIds:[first.id]})).markedRead,0);
 assert.equal(ok(rpc('dm.inbox',b.token)).unreadCount,1);
 second=ok(rpc('dm.send',a.token,{recipientId:b.id,body:'Arrived after fetching the thread',clientId:randomUUID()})).message;
 assert.equal(ok(rpc('dm.read',b.token,{messageIds:[first.id]})).markedRead,1);
 assert.equal(ok(rpc('dm.inbox',b.token)).unreadCount,1);
});
check('Idempotent sends reject altered retries',()=>{
 const clientId=randomUUID(),d={recipientId:a.id,body:'Reply B to A',clientId};
 const m=ok(rpc('dm.send',b.token,d)).message;
 assert.equal(ok(rpc('dm.send',b.token,d)).message.id,m.id);
 assert.equal(rpc('dm.send',b.token,{...d,body:'Changed'}).error.code,'CONFLICT');
 assert.equal(rpc('dm.send',b.token,{...d,recipientId:c.id}).error.code,'CONFLICT');
});
check('Empty, oversized, invalid recipients and malformed read IDs rejected',()=>{
 for(const body of ['', ' ', '😀'.repeat(12001)])assert.equal(rpc('dm.send',a.token,{recipientId:b.id,body,clientId:randomUUID()}).error.code,'VALIDATION');
 assert.equal(rpc('dm.send',a.token,{recipientId:randomUUID(),body:'x',clientId:randomUUID()}).error.code,'NOT_FOUND');
 assert.equal(rpc('dm.send',a.token,{recipientId:a.id,body:'x',clientId:randomUUID()}).error.code,'VALIDATION');
 for(const messageIds of [null,{},[null],['nope'],Array(101).fill(first.id)])assert.equal(rpc('dm.read',b.token,{messageIds}).error.code,'VALIDATION');
});
check('Thread pagination and cursors cannot cross conversations',()=>{
 const m=ok(rpc('dm.send',c.token,{recipientId:b.id,body:'C and B only',clientId:randomUUID()})).message;
 assert.equal(rpc('dm.thread',a.token,{participantA:a.id,participantB:b.id,beforeId:m.id}).error.code,'NOT_FOUND');
 const p=ok(rpc('dm.thread',b.token,{participantA:a.id,participantB:b.id,beforeId:second.id}));assert.equal(p.messages.length,1);assert.equal(p.messages[0].id,first.id);
 for(let i=0;i<52;i++)ok(rpc('dm.send',a.token,{recipientId:b.id,body:'Page '+i,clientId:randomUUID()}));
 const page=ok(rpc('dm.thread',b.token,{participantA:a.id,participantB:b.id}));assert.equal(page.messages.length,50);assert.equal(page.hasMore,true);
 const older=ok(rpc('dm.thread',b.token,{participantA:a.id,participantB:b.id,beforeId:page.messages[0].id}));assert.equal(older.messages.length,5);assert.equal(older.hasMore,false);
});
check('Anonymous database roles cannot access DM table or privileged RPC',()=>{
 for(const role of ['anon','authenticated']){assert.match(sql(`set role ${role};select * from relay_private.direct_messages;`,true),/permission denied/);assert.match(sql(`set role ${role};select public.relay_dm_rpc('dm.inbox');`,true),/permission denied/);}
 assert.equal(sql("select relrowsecurity from pg_class where oid='relay_private.direct_messages'::regclass;"),'t');
});
check('No token, revoked token and disabled account reject every DM action',()=>{
 const actions=['dm.inbox','dm.thread','dm.send','dm.read'];for(const action of actions)assert.equal(rpc(action).error.code,'SESSION');
 ok(rpc('workers.update',manager.token,{workerId:c.id,enabled:false}));for(const action of actions)assert.equal(rpc(action,c.token).error.code,'SESSION');
 ok(rpc('workers.reset',manager.token,{workerId:a.id,currentPassword:password,newPassword:password+'new'}));for(const action of actions)assert.equal(rpc(action,a.token).error.code,'SESSION');
});
check('Worker deletion removes its private history and studio deletion clears all DMs',()=>{
 ok(rpc('workers.delete',manager.token,{workerId:a.id,currentPassword:password,confirmation:'alpha'}));assert.equal(sql(`select count(*) from relay_private.direct_messages where sender_id=${q(a.id)} or recipient_id=${q(a.id)};`),'0');
 ok(rpc('workspace.delete',manager.token,{currentPassword:password,confirmation:'DELETE MY STUDIO'}));assert.equal(sql('select count(*) from relay_private.direct_messages;'),'0');
});
console.log(`${checks} DM database checks passed`);

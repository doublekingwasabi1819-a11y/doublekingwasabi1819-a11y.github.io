import assert from 'node:assert/strict';
import {createStoredPublisher} from '../backend/updates-publisher.mjs';
const config={appId:'123',installationId:'456',privateKey:'-----BEGIN PRIVATE KEY-----\nTEST ONLY\n-----END PRIVATE KEY-----'};
const factory=c=>({repository:async()=>({connected:Boolean(c.appId)}),stage:async p=>p,check:async()=>c.appId,publish:async()=>c.installationId,deployment:async()=>null,outcome:async()=>null});
const base={url:'https://test.invalid/',serviceKey:'test-service-key',factory};
let count=0,clock=0;
const publisher=createStoredPublisher({...base,now:()=>clock,fetcher:async(url,options)=>{
  count++;assert.equal(url,'https://test.invalid/rest/v1/rpc/relay_update_publisher_credentials');
  assert.equal(options.headers.Authorization,'Bearer test-service-key');assert.equal(options.redirect,'error');
  return Response.json(config);
}});
assert.deepEqual(await Promise.all([publisher.repository(),publisher.repository()]),[{connected:true},{connected:true}]);
assert.equal(count,1);clock=60001;await publisher.repository();assert.equal(count,2);
console.log('PASS concurrent secret reads share a bounded cache');
let attempts=0;
const retry=createStoredPublisher({...base,fetcher:()=>{if(++attempts===1)throw Error('SECRET VALUE MUST NOT LEAK');return Promise.resolve(Response.json(config));}});
await assert.rejects(retry.repository(),e=>e.code==='PUBLISHER_CONFIG'&&!e.message.includes('SECRET VALUE'));
assert.deepEqual(await retry.repository(),{connected:true});assert.equal(attempts,2);
console.log('PASS synchronous provider failure is sanitized and can retry');
for(const value of [{...config,privateKey:'wrong format'},['secret'],{...config,appId:'../invalid'}]){
 const p=createStoredPublisher({...base,fetcher:async()=>Response.json(value)});
 await assert.rejects(p.repository(),e=>e.code==='PUBLISHER_CONFIG');
}
const missing=createStoredPublisher({...base,fetcher:async()=>Response.json(null)});assert.deepEqual(await missing.repository(),{connected:false});
console.log('PASS malformed configuration fails closed and absent configuration stays disconnected');
const env=createStoredPublisher({...base,env:config,fetcher:()=>{throw Error('must not query Vault');}});assert.deepEqual(await env.repository(),{connected:true});
console.log('PASS complete server environment configuration remains supported');

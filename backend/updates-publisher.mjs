import {createGitHubPublisher} from './updates-github.mjs';

// Server only. Load one named Vault secret using the existing service credential.
// Never include provider responses, secret values, or parser errors in public errors.
export function createStoredPublisher({url,serviceKey,env={},fetcher=fetch,now=()=>Date.now(),factory=createGitHubPublisher}){
  if(env.appId&&env.installationId&&env.privateKey)return factory({...env,fetcher,now});
  let cached,until=0,loading;
  async function load(){
    if(cached&&until>now())return cached;
    if(loading)return loading;
    loading=Promise.resolve().then(async()=>{
      try{
        const response=await fetcher(url.replace(/\/$/,'')+'/rest/v1/rpc/relay_update_publisher_credentials',{
          method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
          headers:{'Content-Type':'application/json',apikey:serviceKey,Authorization:'Bearer '+serviceKey},body:'{}'
        });
        if(!response.ok)throw Error();
        const config=await response.json();
        if(config!==null&&(!config||typeof config!=='object'||Array.isArray(config)
          ||!/^\d+$/.test(config.appId)||!/^\d+$/.test(config.installationId)
          ||typeof config.privateKey!=='string'||config.privateKey.length>20000
          ||!config.privateKey.includes('-----BEGIN PRIVATE KEY-----')))throw Error();
        cached=factory({...config,fetcher,now});until=now()+(config?60000:5000);return cached;
      }catch{
        throw Object.assign(new Error('The publishing connection is temporarily unavailable. Retry shortly.'),{code:'PUBLISHER_CONFIG',status:503});
      }
    }).finally(()=>{loading=null;});
    return loading;
  }
  return Object.fromEntries(['repository','stage','check','publish','deployment','outcome'].map(method=>[method,async(...args)=>(await load())[method](...args)]));
}

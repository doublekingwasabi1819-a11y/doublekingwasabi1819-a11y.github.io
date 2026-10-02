import {HubError} from './engine.mjs';

const browserSessionStorage=()=>{try{return globalThis.sessionStorage;}catch{return null;}};

/** Browser and agent client. Permissions are decided by the server session. */
export class RelayAPI {
  constructor({base='',fetcher=globalThis.fetch,storage}={}) {
    this.base=String(base).replace(/\/$/,'');
    if(this.base){const url=new URL(this.base);if(url.username||url.password||url.hash||!(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname)))throw new Error('Relay requires an HTTPS backend.');}
    this.configured=Boolean(this.base);this.fetcher=fetcher;this.storage=storage===undefined?browserSessionStorage():storage;
    this.token='';this.expiresAt=null;this.snapshot=null;this.repo='Relay accounts';
    this.storageKey='relay-account-session-v2';
  }
  restore(){
    try{const saved=JSON.parse(this.storage?.getItem(this.storageKey)||'null');
      if(saved?.base===this.base&&typeof saved.token==='string'&&Date.parse(saved.expiresAt)>Date.now()){
        this.token=saved.token;this.expiresAt=saved.expiresAt;return true;
      }
    }catch{}
    this.disconnect();return false;
  }
  remember(result){
    if(!result?.token||!result.expiresAt)throw new HubError('The server did not issue a session.','SESSION');
    if(this.token!==result.token)this.snapshot=null;
    this.token=result.token;this.expiresAt=result.expiresAt;
    try{this.storage?.setItem(this.storageKey,JSON.stringify({base:this.base,token:this.token,expiresAt:this.expiresAt}));}catch{}
  }
  async call(action,data={}){
    if(!this.configured)throw new HubError('Account sign-in is waiting for backend activation.','NOT_CONFIGURED');
    const token=this.token;
    let response;
    try{response=await this.fetcher.call(globalThis,this.base,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify({action,data}),cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer'});}
    catch{throw new HubError('Could not reach Relay. Your draft is still here. Check your connection and retry.','NETWORK');}
    let result;try{result=await response.json();}catch{throw new HubError('The server returned an unreadable response.','NETWORK');}
    if(!response.ok||result?.error){
      const error=new HubError(result?.error?.message||'Relay could not complete this request.',result?.error?.code||String(response.status));
      error.status=response.status;
      if(token===this.token&&['SESSION','UNAUTHORIZED','STALE_SESSION','DELETED'].includes(error.code))this.disconnect();
      throw error;
    }
    return result;
  }
  status(){return this.call('status');}
  async setup(data){const result=await this.call('setup',data);this.remember(result);return result;}
  async login(data){const result=await this.call('login',data);this.remember(result);return result;}
  async logout(){const token=this.token;try{if(token)await this.call('logout');}finally{if(token===this.token)this.disconnect();}}
  async context(){const token=this.token;const snapshot=await this.call('context');if(token===this.token)this.snapshot=snapshot;return snapshot;}
  async read(){return this.context();}
  async mutate(op){const token=this.token;await this.call('operation',{op});if(token!==this.token)throw new HubError('The signed-in account changed while saving. Read the board from your current account.','ACCOUNT_CHANGED');return (await this.context()).state;}
  disconnect(){this.token='';this.expiresAt=null;this.snapshot=null;try{this.storage?.removeItem(this.storageKey);}catch{}}
}

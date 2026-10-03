import {createUpdatesRPC,createUpdatesHandler} from './updates-handler.mjs';
import {createStoredPublisher} from './updates-publisher.mjs';
const connection={url:Deno.env.get('SUPABASE_URL'),serviceKey:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')};
const rpc=createUpdatesRPC(connection);
const publisher=createStoredPublisher({...connection,env:{appId:Deno.env.get('RELAY_GITHUB_APP_ID'),installationId:Deno.env.get('RELAY_GITHUB_INSTALLATION_ID'),privateKey:Deno.env.get('RELAY_GITHUB_PRIVATE_KEY')}});
Deno.serve(createUpdatesHandler({rpc,publisher}));

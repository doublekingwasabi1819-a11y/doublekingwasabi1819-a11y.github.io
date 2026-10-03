import {createUpdatesRPC,createUpdatesHandler} from './updates-handler.mjs';
import {createGitHubPublisher} from './updates-github.mjs';
const rpc=createUpdatesRPC({url:Deno.env.get('SUPABASE_URL'),serviceKey:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')});
const publisher=createGitHubPublisher({appId:Deno.env.get('RELAY_GITHUB_APP_ID'),installationId:Deno.env.get('RELAY_GITHUB_INSTALLATION_ID'),privateKey:Deno.env.get('RELAY_GITHUB_PRIVATE_KEY')});
Deno.serve(createUpdatesHandler({rpc,publisher}));

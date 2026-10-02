// Deployment bundles handler.mjs and engine.mjs alongside this entrypoint.
import {createDatabaseRPC,createHandler} from './handler.mjs';

const rpc=createDatabaseRPC({url:Deno.env.get('SUPABASE_URL'),serviceKey:Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')});
Deno.serve(createHandler({rpc}));

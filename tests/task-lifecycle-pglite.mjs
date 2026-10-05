#!/usr/bin/env node
// Disposable in-memory PostgreSQL only. No network or database credentials.
// Install @electric-sql/pglite@0.5.8 outside the repository and set
// RELAY_PGLITE_ROOT=/tmp/<install>/node_modules/@electric-sql/pglite.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomBytes, createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {emptyState, applyOperation, HubError} from '../engine.mjs';
import {createDatabaseRPC, createHandler} from '../backend/handler.mjs';

const root = process.env.RELAY_PGLITE_ROOT;
if (!root?.startsWith('/tmp/')) throw new Error('Use a local /tmp PGlite package; remote databases are not supported.');
assert.equal(JSON.parse(readFileSync(root + '/package.json', 'utf8')).version, '0.5.8');
const {PGlite} = await import(pathToFileURL(root + '/dist/index.js'));
const {pgcrypto} = await import(pathToFileURL(root + '/dist/contrib/pgcrypto.js'));
const db = new PGlite({extensions: {pgcrypto}});
const sql = (query, params = []) => db.query(query, params);
const rpc = async (action, token = '', data = {}) => {
  await db.exec('set role service_role');
  try {
    const name = action.startsWith('dm.') ? 'relay_dm_rpc' : 'relay_rpc';
    return (await sql(`select public.${name}($1,$2,$3::jsonb) as value`, [action, token, JSON.stringify(data)])).rows[0].value;
  } finally { await db.exec('reset role'); }
};
const ok = result => { assert.equal(result.error, undefined, JSON.stringify(result)); return result; };
let checks = 0;
async function check(name, run) { await run(); checks++; console.log('PASS ' + name); }
const password = 'Temporary! ' + randomBytes(16).toString('hex');
const resetPassword = 'Reset! ' + randomBytes(16).toString('hex');
const schema = readFileSync(new URL('../backend/schema.sql', import.meta.url), 'utf8');
const rollout = readFileSync(new URL('../backend/task-controls-rollout.sql', import.meta.url), 'utf8');
const rollback = readFileSync(new URL('../backend/task-controls-rollback.sql', import.meta.url), 'utf8');
let manager, alpha, beta, gamma, betaLogin, alphaLogin, gammaLogin;
const context = async () => ok(await rpc('context', manager.token));
const getAssignments = task => Array.isArray(task.assignees) ? task.assignees : task.owner ? [{agentId: task.owner, session: task.session}] : [];
// The production handler and database transport run unchanged. Only HTTP to the
// database is replaced with parameterized queries against real local PostgreSQL.
const databaseRPC = createDatabaseRPC({url: 'https://sql-fixture.invalid', serviceKey: 'synthetic-local-service-key',
  fetcher: async (_url, options) => {
    const {p_action, p_token, p_data} = JSON.parse(options.body);
    return Response.json(await rpc(p_action, p_token, p_data));
  }
});
const handler = createHandler({rpc: databaseRPC});
const edge = async (action, token, data = {}, target = handler) => {
  const response = await target(new Request('https://edge-fixture.invalid', {method: 'POST',
    headers: {'Content-Type': 'application/json', ...(token ? {Authorization: `Bearer ${token}`} : {})},
    body: JSON.stringify({action, data})
  }));
  return {status: response.status, body: await response.json()};
};
let operationNumber = 0;
const operation = (type, payload = {}, id = 'edge-op-' + ++operationNumber) => ({id, type, payload});
const mutate = (token, op, target) => edge('operation', token, {op}, target);
const edgeOK = response => { assert.equal(response.status, 200, JSON.stringify(response)); return response.body; };
const edgeTask = async () => (await context()).state.tasks.find(t => t.id === 'edge-task');
const edit = (task, title) => ({taskId: task.id, expectedVersion: task.version, title, description: 'Edited scope', acceptance: 'Verified SQL round trip', priority: 'high'});

function assertChanged(before, after, agentId, runId) {
  assert.deepEqual(after.map(t => t.id), before.map(t => t.id), 'task order remains stable');
  for (const previous of before) {
    const next = after.find(t => t.id === previous.id);
    const assignments = getAssignments(previous);
    if (previous.status === 'done' || !assignments.some(a => a.agentId === agentId)) {
      assert.deepEqual(next, previous, 'completed or unrelated task remains unchanged: ' + previous.id);
      continue;
    }
    const expected = runId === null
      ? assignments.filter(a => a.agentId !== agentId)
      : assignments.map(a => a.agentId === agentId ? {...a, session: runId} : a);
    assert.deepEqual(next.assignees, expected, 'all matching assignments updated in order: ' + previous.id);
    assert.equal(next.owner, expected[0]?.agentId ?? null);
    assert.equal(next.session, expected[0]?.session ?? null);
    assert.equal(next.version, (previous.version ?? 0) + 1, 'one version bump per task');
    assert.equal(next.status, runId === null && !expected.length && previous.status !== 'done' ? 'ready' : previous.status);
    assert.ok(Date.parse(next.updatedAt));
    for (const key of ['deletedAt', 'deletedBy', 'title', 'history', 'evidence', 'createdAt']) {
      assert.deepEqual(next[key], previous[key], key + ' is retained');
    }
  }
}

try {
  await check('schema compiles; lifecycle helper keeps private invoker permissions', async () => {
    await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
    await db.exec(schema);
    const definition = (await sql("select prosecdef, proconfig from pg_proc where oid='relay_private.update_task_worker(jsonb,text,text,timestamptz)'::regprocedure")).rows[0];
    assert.equal(definition.prosecdef, false);
    assert.deepEqual(definition.proconfig, ['search_path=pg_catalog']);
    for (const role of ['anon', 'authenticated']) {
      await db.exec('set role ' + role);
      try {
        await assert.rejects(db.exec("select relay_private.update_task_worker('{}'::jsonb,'a',null,now())"), /permission denied/);
        await assert.rejects(db.exec("select public.relay_rpc('status')"), /permission denied/);
      } finally { await db.exec('reset role'); }
    }
  });

  await check('focused SQL rollback and rollout restore exact verified RPC definitions and are repeatable', async () => {
    const definition = (await sql("select pg_get_functiondef('public.relay_rpc(text,text,jsonb)'::regprocedure) as value")).rows[0].value;
    await db.exec(rollback);
    assert.equal((await sql("select md5(prosrc) as value from pg_proc where oid='public.relay_rpc(text,text,jsonb)'::regprocedure")).rows[0].value, '6f6381892da4da201900f74e7fd6b8fb');
    assert.equal((await sql("select to_regprocedure('relay_private.update_task_worker(jsonb,text,text,timestamptz)') is null as value")).rows[0].value, true);
    await db.exec(rollback);
    await db.exec(rollout);
    await db.exec(rollout);
    assert.equal((await sql("select pg_get_functiondef('public.relay_rpc(text,text,jsonb)'::regprocedure) as value")).rows[0].value, definition);
    assert.equal((await sql("select has_function_privilege('anon','relay_private.update_task_worker(jsonb,text,text,timestamptz)','EXECUTE') as value")).rows[0].value, false);
  });

  await check('prior task-controls release upgrades to the exact branded RPC and rolls back safely', async () => {
    const definition = (await sql("select pg_get_functiondef('public.relay_rpc(text,text,jsonb)'::regprocedure) as value")).rows[0].value;
    const prior = definition.replace(`      'workers', v_workers,
      'manager', (select jsonb_build_object('name', a.name)
        from relay_private.accounts a where a.role = 'manager'),
      'capabilities', jsonb_build_object('taskLifecycleV1', true));`, `      'workers', v_workers);`);
    await db.exec(prior);
    assert.equal((await sql("select md5(prosrc) as value from pg_proc where oid='public.relay_rpc(text,text,jsonb)'::regprocedure")).rows[0].value, '48f80463867e20075a3f13fc5b641eb7');
    await db.exec(rollout);
    assert.equal((await sql("select pg_get_functiondef('public.relay_rpc(text,text,jsonb)'::regprocedure) as value")).rows[0].value, definition);
    await db.exec(prior);
    await db.exec(rollback);
    assert.equal((await sql("select md5(prosrc) as value from pg_proc where oid='public.relay_rpc(text,text,jsonb)'::regprocedure")).rows[0].value, '6f6381892da4da201900f74e7fd6b8fb');
    await db.exec(rollout);
    assert.equal((await sql("select pg_get_functiondef('public.relay_rpc(text,text,jsonb)'::regprocedure) as value")).rows[0].value, definition);
  });

  await check('focused SQL rollout refuses an unexpected RPC without changing data or definitions', async () => {
    const definition = (await sql("select pg_get_functiondef('public.relay_rpc(text,text,jsonb)'::regprocedure) as value")).rows[0].value;
    const drifted = definition.replace('declare\n', 'declare\n  -- Deliberate local schema-drift fixture.\n');
    await db.exec(drifted);
    await assert.rejects(db.exec(rollout), /Unexpected relay_rpc definition/);
    await db.exec('rollback');
    assert.equal((await sql("select pg_get_functiondef('public.relay_rpc(text,text,jsonb)'::regprocedure) as value")).rows[0].value, drifted);
    await db.exec(definition);
  });

  await check('authenticated setup and worker creation use the actual account RPC', async () => {
    const setupCode = randomBytes(32).toString('hex');
    await sql('update relay_private.studio set setup_hash=$1', [createHash('sha256').update(setupCode).digest('hex')]);
    manager = ok(await rpc('setup', '', {setupCode, name: 'Mara Relay', username: 'manager', password, state: emptyState()}));
    const users = [];
    for (const name of ['alpha', 'beta', 'gamma']) users.push(ok(await rpc('workers.create', manager.token, {name, username: name, password})));
    [alpha, beta, gamma] = users;
    betaLogin = ok(await rpc('login', '', {role: 'worker', username: 'beta', password}));
    alphaLogin = ok(await rpc('login', '', {role: 'worker', username: 'alpha', password}));
    gammaLogin = ok(await rpc('login', '', {role: 'worker', username: 'gamma', password}));
  });

  await check('authenticated context exposes only manager display name and SQL task-controls capability to both roles', async () => {
    for (const token of [manager.token, alphaLogin.token, betaLogin.token]) {
      const result = ok(await rpc('context', token, {manager: {name: 'Spoofed'}, owner: true}));
      assert.deepEqual(result.manager, {name: 'Mara Relay'});
      assert.deepEqual(result.capabilities, {taskLifecycleV1: true});
      assert.equal(result.room.accountId, result.user.id);
      if (token !== manager.token) assert.deepEqual(result.workers, []);
      const throughEdge = edgeOK(await edge('context', token));
      assert.deepEqual(throughEdge.manager, result.manager);
      assert.equal(throughEdge.capabilities.taskControlsV1, true);
    }
    for (const token of ['', '0'.repeat(64)]) {
      const result = await rpc('context', token);
      assert.equal(result.error.code, 'SESSION');
      assert.equal(result.manager, undefined);
      assert.equal(result.capabilities, undefined);
    }
  });

  await check('baseline context advertises no lifecycle capability and rollout restores it without changing user data', async () => {
    const before = await context();
    await db.exec(rollback);
    const baseline = await context();
    assert.equal(baseline.manager, undefined);
    assert.equal(baseline.capabilities, undefined);
    assert.equal(edgeOK(await edge('context', manager.token)).capabilities.taskControlsV1, false);
    const blocked = await mutate(manager.token, operation('task.add', {title: 'Blocked before SQL rollout', acceptance: 'Must not be saved'}));
    assert.equal(blocked.status, 503);
    assert.equal(blocked.body.error.code, 'BACKEND_NOT_READY');
    assert.deepEqual((await context()).state, before.state);
    assert.deepEqual(baseline.state, before.state);
    assert.deepEqual(baseline.user, before.user);
    assert.deepEqual(baseline.workers, before.workers);
    await db.exec(rollout);
    assert.deepEqual(await context(), before);
  });

  await check('Edge handler creates a task assigned to two authenticated workers and persists edits', async () => {
    const result = edgeOK(await mutate(manager.token, operation('task.add', {
      title: 'SQL-backed shared task', acceptance: 'Both workers can contribute', agentIds: [alpha.agentId, beta.agentId]
    }, 'edge-task')));
    assert.equal(result.state.tasks[0].status, 'working');
    assert.deepEqual(result.state.tasks[0].assignees.map(a => a.agentId), [alpha.agentId, beta.agentId]);
    const saved = await edgeTask();
    edgeOK(await mutate(manager.token, operation('task.edit', edit(saved, 'Edited shared task'))));
    const updated = await edgeTask();
    assert.equal(updated.title, 'Edited shared task');
    assert.equal(updated.version, saved.version + 1);
    const workerView = edgeOK(await edge('context', betaLogin.token));
    assert.deepEqual(workerView.state.tasks[0], updated);
    assert.deepEqual(workerView.workers, []);
  });

  await check('Edge handler allows secondary-assignee progress while rejecting unrelated or spoofed worker controls', async () => {
    let task = await edgeTask();
    edgeOK(await mutate(betaLogin.token, operation('task.progress', {taskId: task.id, expectedVersion: task.version,
      checkpoint: 'Secondary worker contribution', status: 'review', evidence: 'Real SQL round trip passed'})));
    task = await edgeTask();
    assert.equal(task.checkpoint, 'Secondary worker contribution');
    assert.equal((await context()).state.agents.find(a => a.id === beta.agentId).checkpoint, task.checkpoint);
    const before = (await context()).state;
    for (const type of ['task.assign', 'task.edit', 'task.delete', 'task.restore']) {
      const response = await mutate(betaLogin.token, operation(type, {...edit(task, 'Spoofed'), agentIds: [gamma.agentId], owner: true, actor: {id: 'owner', owner: true}}));
      assert.equal(response.status, 403, type);
    }
    assert.equal((await mutate(gammaLogin.token, operation('task.progress', {taskId: task.id, expectedVersion: task.version, checkpoint: 'Not assigned'}))).status, 403);
    assert.equal((await mutate(betaLogin.token, operation('task.progress', {taskId: task.id, checkpoint: 'Missing multi-assignee version'}))).status, 409);
    assert.equal((await mutate(betaLogin.token, operation('task.review', {taskId: task.id, expectedVersion: task.version, approve: true, review: 'Self approval'}))).body.error.code, 'SELF_REVIEW');
    assert.deepEqual((await context()).state, before);
  });

  await check('Edge soft-delete and restore preserve assignees, evidence, messages, and reject stale versions', async () => {
    const before = await edgeTask();
    edgeOK(await mutate(alphaLogin.token, operation('message.add', {taskId: before.id, body: 'Keep this shared discussion'})));
    assert.equal((await mutate(manager.token, operation('task.edit', {...edit(before, 'Missing version'), expectedVersion: undefined}))).status, 409);
    const remove = operation('task.delete', {taskId: before.id, expectedVersion: before.version});
    edgeOK(await mutate(manager.token, remove));
    const deleted = await edgeTask();
    assert.ok(deleted.deletedAt); assert.equal(deleted.deletedBy, 'owner');
    assert.equal((await mutate(manager.token, operation('task.restore', {taskId: before.id, expectedVersion: before.version}))).status, 409);
    assert.equal((await mutate(betaLogin.token, operation('task.progress', {taskId: before.id, expectedVersion: deleted.version, checkpoint: 'Deleted update'}))).body.error.code, 'TASK_DELETED');
    edgeOK(await mutate(manager.token, remove));
    assert.deepEqual(await edgeTask(), deleted, 'delete operation retry writes once');
    const restore = operation('task.restore', {taskId: before.id, expectedVersion: deleted.version});
    edgeOK(await mutate(manager.token, restore)); edgeOK(await mutate(manager.token, restore));
    const restored = await edgeTask();
    for (const key of ['assignees', 'checkpoint', 'evidence', 'review', 'status', 'createdAt']) assert.deepEqual(restored[key], before[key]);
    assert.equal(restored.deletedAt, undefined); assert.equal(restored.version, before.version + 2);
    assert.ok((await context()).state.messages.some(m => m.body === 'Keep this shared discussion'));
  });

  await check('Edge reassignment promotes a surviving worker and revokes the removed worker task access', async () => {
    const before = await edgeTask();
    edgeOK(await mutate(manager.token, operation('task.assign', {taskId: before.id, expectedVersion: before.version, agentIds: [beta.agentId]})));
    let task = await edgeTask(); assert.equal(task.owner, beta.agentId);
    assert.equal((await mutate(alphaLogin.token, operation('task.progress', {taskId: task.id, expectedVersion: task.version, checkpoint: 'Removed'}))).status, 403);
    edgeOK(await mutate(manager.token, operation('task.assign', {taskId: task.id, expectedVersion: task.version, agentIds: [alpha.agentId, beta.agentId]})));
  });

  await check('real SQL CAS collision on the same task returns conflict and retains the winning edit', async () => {
    const before = await edgeTask(); let commits = 0;
    const racingHandler = createHandler({rpc: async (action, token, data) => {
      if (action === 'board.commit' && ++commits === 1) {
        const latest = await context();
        const next = applyOperation(latest.state, operation('task.edit', edit(before, 'Winning concurrent edit')), latest.actor);
        await databaseRPC('board.commit', manager.token, {expectedRevision: latest.state.revision, state: next});
      }
      return databaseRPC(action, token, data);
    }});
    const attempted = operation('task.edit', edit(before, 'Stale losing edit'));
    assert.equal((await mutate(manager.token, attempted, racingHandler)).status, 409);
    assert.equal(commits, 1); assert.equal((await edgeTask()).title, 'Winning concurrent edit');
    assert.ok(!(await context()).state.operations.includes(attempted.id));
  });

  await check('real SQL unrelated CAS collision retries and lost acknowledgement stays idempotent', async () => {
    const before = await edgeTask(); let commits = 0;
    const retryingHandler = createHandler({rpc: async (action, token, data) => {
      if (action === 'board.commit' && ++commits === 1) {
        const latest = await context();
        const next = applyOperation(latest.state, operation('message.add', {body: 'Concurrent unrelated message'}), latest.actor);
        await databaseRPC('board.commit', manager.token, {expectedRevision: latest.state.revision, state: next});
      }
      return databaseRPC(action, token, data);
    }});
    edgeOK(await mutate(manager.token, operation('task.edit', edit(before, 'Retried edit')), retryingHandler));
    assert.equal(commits, 2); assert.equal((await edgeTask()).version, before.version + 1);
    let lost = false, acknowledgedCommits = 0;
    const losingHandler = createHandler({rpc: async (action, token, data) => {
      const result = await databaseRPC(action, token, data);
      if (action === 'board.commit') { acknowledgedCommits++; if (!lost) { lost = true; throw new HubError('Simulated lost response', 'NETWORK'); } }
      return result;
    }});
    const task = await edgeTask(), once = operation('task.edit', edit(task, 'Saved once'));
    edgeOK(await mutate(manager.token, once, losingHandler)); edgeOK(await mutate(manager.token, once, losingHandler));
    assert.equal(acknowledgedCommits, 1); assert.equal((await edgeTask()).version, task.version + 1);
  });

  await check('rollback refuses new task data rather than losing multi-assignee or deletion semantics', async () => {
    const before = (await context()).state;
    await assert.rejects(db.exec(rollback), /New-format tasks exist/);
    await db.exec('rollback');
    assert.deepEqual((await context()).state, before);
    assert.equal((await sql("select to_regprocedure('relay_private.update_task_worker(jsonb,text,text,timestamptz)') is not null as value")).rows[0].value, true);
  });

  await check('fixtures include primary, secondary, legacy, done, and soft-deleted assignments', async () => {
    const {state} = await context();
    const assignment = user => ({agentId: user.agentId, session: state.agents.find(a => a.id === user.agentId).session});
    const a = assignment(alpha), b = assignment(beta), c = assignment(gamma);
    const task = (id, assignees, status = 'working', version = 7, extra = {}) => ({
      id, title: id, assignees, owner: assignees[0]?.agentId ?? null, session: assignees[0]?.session ?? null,
      status, version, history: [{body: 'Retained history'}], evidence: 'Retained evidence',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...extra
    });
    const deleted = {deletedAt: '2026-09-30T00:00:00.000Z', deletedBy: 'owner'};
    state.tasks = [
      task('multi-primary', [b, a, c]), task('multi-secondary', [a, b, c], 'review', 3),
      task('only-beta', [b], 'blocked', 4), task('legacy-beta', [b], 'working'),
      task('done-multi', [a, b], 'done'), task('done-single', [b], 'done'),
      task('deleted-only', [b], 'review', 9, deleted), task('deleted-multi', [a, b], 'working', 10, deleted),
      task('unrelated', [a], 'working', 99), task('explicit-empty', [], 'ready', 12, {owner: beta.agentId, session: b.session}),
      task('unowned', [], 'ready'), task('legacy-done', [b], 'done'),
      task('deleted-done', [b], 'done', 13, deleted)
    ];
    for (const id of ['legacy-beta', 'legacy-done']) {
      const legacy = state.tasks.find(t => t.id === id); delete legacy.assignees; delete legacy.version;
    }
    const revision = state.revision; state.revision++;
    ok(await rpc('board.commit', manager.token, {expectedRevision: revision, state}));
  });

  await check('failed password proof leaves all assignments and versions unchanged', async () => {
    const before = await context();
    assert.equal((await rpc('workers.reset', manager.token, {workerId: beta.id, currentPassword: 'Incorrect password', newPassword: resetPassword})).error.code, 'AUTH');
    assert.deepEqual((await context()).state, before.state);
  });

  await check('reset renews matching unfinished assignments without changing completed attribution or restoring deleted tasks', async () => {
    const before = await context();
    ok(await rpc('workers.reset', manager.token, {workerId: beta.id, currentPassword: password, newPassword: resetPassword}));
    const after = await context(), run = after.state.agents.find(a => a.id === beta.agentId).session;
    assert.notEqual(run, before.state.agents.find(a => a.id === beta.agentId).session);
    assertChanged(before.state.tasks, after.state.tasks, beta.agentId, run);
    assert.equal(after.state.revision, before.state.revision + 1);
    assert.equal((await rpc('context', betaLogin.token)).error.code, 'SESSION');
    ok(await rpc('context', alphaLogin.token));
    betaLogin = ok(await rpc('login', '', {role: 'worker', username: 'beta', password: resetPassword}));
    assert.equal(ok(await rpc('context', betaLogin.token)).actor.session, run);
    const staleState = structuredClone(before.state); staleState.revision++;
    assert.equal((await rpc('board.commit', manager.token, {expectedRevision: before.state.revision, state: staleState})).error.code, 'CONFLICT');
  });

  await check('reset of another assignee preserves the first worker renewed sessions', async () => {
    const before = await context();
    ok(await rpc('workers.reset', manager.token, {workerId: alpha.id, currentPassword: password, newPassword: password}));
    const after = await context(), run = after.state.agents.find(a => a.id === alpha.agentId).session;
    assertChanged(before.state.tasks, after.state.tasks, alpha.agentId, run);
  });

  await check('worker deletion requires its login confirmation and cannot be performed by workers', async () => {
    const before = await context();
    assert.equal((await rpc('workers.delete', manager.token, {workerId: beta.id, currentPassword: password, confirmation: 'wrong'})).error.code, 'CONFIRMATION');
    assert.equal((await rpc('workers.delete', betaLogin.token, {workerId: alpha.id, currentPassword: password, confirmation: 'alpha'})).error.code, 'FORBIDDEN');
    assert.deepEqual((await context()).state, before.state);
  });

  await check('deleting a primary or secondary assignee promotes survivors and preserves completed attribution', async () => {
    const before = await context();
    ok(await rpc('workers.delete', manager.token, {workerId: beta.id, currentPassword: password, confirmation: 'beta'}));
    const after = await context();
    assertChanged(before.state.tasks, after.state.tasks, beta.agentId, null);
    assert.equal(after.state.revision, before.state.revision + 1);
    assert.equal((await rpc('context', betaLogin.token)).error.code, 'SESSION');
    assert.ok(after.workers.every(w => w.id !== beta.id));
    assert.equal(after.state.agents.find(a => a.id === beta.agentId).deleted, true);
    assert.equal((await sql('select count(*)::integer as n from relay_private.rooms where account_id=$1', [beta.id])).rows[0].n, 0);
  });

  await check('subsequent deletions keep remaining order, done status, and soft-deletion metadata', async () => {
    for (const user of [alpha, gamma]) {
      const before = await context();
      ok(await rpc('workers.delete', manager.token, {workerId: user.id, currentPassword: password, confirmation: user.username}));
      assertChanged(before.state.tasks, (await context()).state.tasks, user.agentId, null);
    }
    const {state} = await context();
    assert.equal(state.tasks.find(t => t.id === 'done-multi').status, 'done');
    assert.equal(state.tasks.find(t => t.id === 'multi-primary').status, 'ready');
    assert.equal(state.tasks.find(t => t.id === 'deleted-only').deletedBy, 'owner');
  });

  await check('schema reinstall preserves all task data and restricted helper access', async () => {
    const before = await context();
    await db.exec(schema);
    assert.deepEqual((await context()).state, before.state);
    for (const role of ['anon', 'authenticated']) {
      const result = await sql("select has_function_privilege($1,'relay_private.update_task_worker(jsonb,text,text,timestamptz)','EXECUTE') as permitted", [role]);
      assert.equal(result.rows[0].permitted, false);
    }
  });
  console.log(`${checks} disposable PGlite task-lifecycle checks passed. No remote database or independent-session concurrency checks.`);
} finally { await db.close(); }

// Invoked by test-signed-operation-reliability.cjs only in its empty disposable DB.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
module.exports = async function testAccessVersions(db, moduleAt, family) {
  const {accessResource,accessScope} = require('../dist/shared/accessOperations');
  const {versionedAccessOperation} = moduleAt('services/versionedAccessOperation');
  const opId = () => Date.now().toString(16).padStart(16,'0')+'-'+crypto.randomBytes(32).toString('hex');
  const type='call-admission:whitelist:add', path='/call-admission/whitelist/add';
  const payload={externalIdentityId:'external-access-test'};
  const resource=accessResource(type,path,payload,'alice');
  const version = async (scope=family,key=resource) => (await db.query('SELECT version_id FROM signed_resource_versions WHERE family_id=$1 AND resource_key=$2',[scope,key])).rows[0]?.version_id || '0';
  const request = (expectedVersion, operationId=opId()) => ({familyId:family,device:{identityId:'alice'},params:{},originalUrl:'/api'+path,
    signedRequest:{type,signerId:'d-alice',payload,operationId,expectedVersion,accessPath:path}});
  const invoke = async (req, action=async()=>{}) => {
    let result; const res={statusCode:200,status(code){this.statusCode=code;return this;},json(body){result={status:this.statusCode,body};return this;}};
    await versionedAccessOperation(async (_req,response)=>{await action();response.json({status:'ok',result:{accepted:true}});})(req,res,error=>{throw error;});
    return result;
  };
  const add = () => db.query(`INSERT INTO call_whitelist_entries(family_id,owner_identity_id,external_identity_id,external_public_key_algorithm,external_public_key_value,status)
    VALUES($1,'alice','external-access-test','ed25519','public','active') ON CONFLICT(family_id,owner_identity_id,external_identity_id) DO UPDATE SET status='active'`,[family]);
  const initial=await version();
  const first=request(initial);
  assert.equal((await invoke(first,add)).status,200);
  const after=await version();assert.notEqual(after,initial);
  await db.query("UPDATE call_whitelist_entries SET status='revoked' WHERE family_id=$1 AND external_identity_id='external-access-test'",[family]);
  assert.notEqual(await version(),after,'External writer must invalidate the intent');
  assert.equal((await invoke(first,add)).status,200,'Committed retry returns its old result');
  assert.equal((await db.query("SELECT status FROM call_whitelist_entries WHERE family_id=$1 AND external_identity_id='external-access-test'",[family])).rows[0].status,'revoked','Replay must not restore access');
  assert.equal((await invoke(request(initial),add)).body.error.code,'ACCESS_VERSION_CONFLICT');
  assert.equal((await invoke({...first,signedRequest:{...first.signedRequest,expectedVersion:await version()}})).status,409,'Same ID cannot be rebound to a fresh version');
  assert.equal((await invoke(request(undefined))).status,400);
  const wrong=request(await version());wrong.signedRequest.accessPath='/wrong';assert.equal((await invoke(wrong)).status,400);
  const beforeRace=await version();
  const race=await Promise.all([invoke(request(beforeRace),add),invoke(request(beforeRace),add)]);
  assert.deepEqual(race.map(r=>r.status).sort(),[200,409]);
  const beforeRollback=await version();
  await assert.rejects(invoke(request(beforeRollback),async()=>{await add();throw new Error('rollback test');}),/rollback test/);
  assert.equal(await version(),beforeRollback,'Failure rolls back both rights and revision');
  // Every bypass writer must invalidate: membership projection, automatic disabling,
  // claim redemption and tenant changes, even from a different carrier Circle.
  const userKey=accessResource('admin:user:enable','/admin/users/alice/enable',{},'bob');
  const beforeUser=await version(family,userKey);
  await db.query("UPDATE identities SET can_create_invites=NOT can_create_invites WHERE family_id=$1 AND identity_id='alice'",[family]);
  assert.notEqual(await version(family,userKey),beforeUser);
  const beforePresence=await version(family,userKey);
  await db.query("UPDATE identities SET presence_last_seen_at=NOW() WHERE family_id=$1 AND identity_id='alice'",[family]);
  assert.equal(await version(family,userKey),beforePresence,'Presence must not conflict with rights changes');
  const globalKey=accessResource('server-admin:admins:grant','/server-admin/admins/grant',{},'alice');
  assert.equal(accessScope('server-admin:admins:grant',family),accessScope('server-admin:admins:revoke',crypto.randomUUID()));
  const beforeAdmin=await version('@server-access',globalKey);
  await db.query("INSERT INTO server_admins(server_admin_id,principal_identity_id,status,granted_via) VALUES ('access-version-admin','alice','active','bootstrap')");
  assert.notEqual(await version('@server-access',globalKey),beforeAdmin);
  await db.query("DELETE FROM server_admins WHERE server_admin_id='access-version-admin'");
  console.log('Access version tests passed: CAS race, external writes, replay, rollback, scope and validation');
};

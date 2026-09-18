// Run only against a disposable database. This creates the public schema itself.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname,'../..');
const {Client} = require(path.join(root,'server/node_modules/pg'));
const target = process.env.RELIABILITY_TEST_DATABASE_URL;
if (!target || !new URL(target).pathname.endsWith('_reliability_test')) throw new Error('An empty *_reliability_test database URL is required');
const moduleAt = p => require(path.join(root,'server/dist/server/src',p));
const opId = (time=Date.now()) => time.toString(16).padStart(16,'0')+'-'+crypto.randomBytes(32).toString('hex');
async function main() {
  const setup = new Client({connectionString:target});await setup.connect();
  assert.equal((await setup.query("SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")).rows[0].count,'0','Refusing a nonempty database');
  const baseline = fs.existsSync(path.join(root,'SERVER_PUBLIC_INITIAL_SCHEMA.sql')) ? 'SERVER_PUBLIC_INITIAL_SCHEMA.sql' : 'server/db/migrations/001_initial_schema.sql';
  await setup.query(fs.readFileSync(path.join(root,baseline),'utf8'));
  await setup.query('SET search_path=public');
  // The exported baseline is self-contained. Private upgrade history is not exported.
  for (const name of ['151_signed_operation_reliability.sql','152_access_resource_versions.sql']) {
    const upgradePath = path.join(root,'server/db/migrations/000-pre-public',name);
    if (fs.existsSync(upgradePath)) {
      const upgrade = fs.readFileSync(upgradePath,'utf8');
      await setup.query(upgrade);await setup.query(upgrade); // Private upgrades remain repeatable.
    }
  }
  await setup.end();
  const db=moduleAt('db');db.initializeDatabase(target);
  const {query}=db;
  try {
    const family=crypto.randomUUID();
    await query("INSERT INTO family_config(family_id,server_name,public_base_url) VALUES ($1,'Test','https://test.invalid')",[family]);
    for (const id of ['alice','bob']) {
      await query("INSERT INTO identities(identity_id,family_id,public_key_algorithm,public_key_value) VALUES ($1,$2,'ed25519',$3)",[id,family,id]);
      await query("INSERT INTO devices(device_id,identity_id,family_id,public_key_algorithm,public_key_value,encryption_public_key_algorithm,encryption_public_key_value,registration_attestation) VALUES ($1,$2,$3,'ed25519',$4,'x25519',$4 || '-encryption',$5::jsonb)",['d-'+id,id,family,'key-'+id,JSON.stringify({version:1,identitySignedRequest:{},deviceKeyBinding:{}})]);
    }
    await require('./test-access-versions.cjs')(db,moduleAt,family);
    const {claimDurableNonce}=moduleAt('services/durableNonce');
    assert.equal((await Promise.all(Array.from({length:12},()=>claimDurableNonce('alice','same',Date.now()+60000)))).filter(Boolean).length,1);
    await db.closeDatabase();db.initializeDatabase(target);
    assert.equal(await claimDurableNonce('alice','same',Date.now()+60000),false,'Restart must not forget nonce');
    const child = spawnSync(process.execPath, ['-e', `
      const db=require(${JSON.stringify(path.join(root,'server/dist/server/src/db'))});
      const {claimDurableNonce}=require(${JSON.stringify(path.join(root,'server/dist/server/src/services/durableNonce'))});
      (async()=>{db.initializeDatabase(process.env.RELIABILITY_TEST_DATABASE_URL);
        try {if(await claimDurableNonce('alice','same',Date.now()+60000)) throw new Error('Replay accepted in a new process');}
        finally {await db.closeDatabase();}
      })().catch(error=>{console.error(error);process.exitCode=1;});
    `], {env:process.env,encoding:'utf8',timeout:15000});
    assert.equal(child.status,0,child.stderr || child.error?.message);

    const {redeemClaim}=moduleAt('services/claimRedemption');
    const {serverAdminRepository,vaultRepository}=moduleAt('db/repositories');
    await query("INSERT INTO server_admin_claims(claim_id,token_hash,status,expires_at,created_via) VALUES ('claim','token','pending',NOW()+INTERVAL '1 hour','cli')");
    const redeem = identity => redeemClaim('admin','token',identity,family,async()=>({admin:await serverAdminRepository.grantToIdentity({identityId:identity,grantedVia:'recovery'})}));
    const claims=await Promise.allSettled([redeem('alice'),redeem('bob')]);
    assert.equal(claims.filter(r=>r.status==='fulfilled').length,1);
    const winner=claims[0].status==='fulfilled'?'alice':'bob';
    assert.ok((await redeem(winner)).admin);
    assert.equal((await query("SELECT count(*) FROM server_admins WHERE status='active'")).rows[0].count,1);
    await query("INSERT INTO tenant_owner_claims(claim_id,family_id,token_hash,status,expires_at) VALUES ('owner-claim',$1,'owner-token','pending',NOW()+INTERVAL '1 hour')",[family]);
    const redeemOwner=identity=>redeemClaim('owner','owner-token',identity,family,async()=>{
      await query('UPDATE family_config SET owner_identity_id=$2 WHERE family_id=$1',[family,identity]);
      return {owner:identity};
    });
    const ownerResults=await Promise.allSettled([redeemOwner('alice'),redeemOwner('bob')]);
    assert.equal(ownerResults.filter(r=>r.status==='fulfilled').length,1);
    const owner=ownerResults[0].status==='fulfilled'?'alice':'bob';
    assert.deepEqual(await redeemOwner(owner),{owner});
    const writes=await Promise.all([vaultRepository.compareAndSet(family,'alice',{data:'A'},0),vaultRepository.compareAndSet(family,'alice',{data:'B'},0)]);
    assert.equal(writes.filter(Boolean).length,1);
    const updates=await Promise.all([vaultRepository.compareAndSet(family,'alice',{data:'C'},1),vaultRepository.compareAndSet(family,'alice',{data:'D'},1)]);
    assert.equal(updates.filter(Boolean).length,1);
    const {reliableOperation}=moduleAt('services/reliableOperation');
    let calls=0;
    const handler=reliableOperation(async(req,res)=>{
      calls++;
      const added=await query("INSERT INTO announcement_channels(channel_id,family_id,owner_identity_id,title) VALUES ($1,$2,'alice','Test') RETURNING channel_id",['channel-'+crypto.randomUUID(),family]);
      res.json({status:'ok',result:{id:added.rows[0].channel_id,secret:'do-not-store-plaintext'}});
    });
    const run=async(handler,id,payload={})=>{
      const req={familyId:family,params:{},signedRequest:{type:'test:create',signerId:'d-alice',operationId:id,payload}};
      let answer;const res={status(code){this.code=code;return this;},json(body){answer={code:this.code||200,body};return this;}};
      await handler(req,res,error=>{throw error});return answer;
    };
    const id=opId();const answers=await Promise.all([run(handler,id),run(handler,id)]);
    assert.equal(calls,1);assert.deepEqual(answers[0],answers[1]);
    assert.equal((await run(handler,id,{changed:true})).code,409);
    assert.ok(!JSON.stringify((await query('SELECT response FROM signed_operation_results')).rows).includes('do-not-store-plaintext'));
    await db.closeDatabase();db.initializeDatabase(target);
    assert.deepEqual(await run(handler,id),answers[0]);assert.equal(calls,1);
    await query("UPDATE signed_operation_results SET created_at=NOW()-INTERVAL '31 days'");
    assert.equal((await run(handler,id)).code,409);assert.equal(calls,1,'Expired result must remain a tombstone');
    const fails=reliableOperation(async(req,res)=>{await query("UPDATE identities SET status_text='must-rollback' WHERE identity_id='alice'");res.status(409).json({error:'conflict'});});
    assert.equal((await run(fails,opId())).code,409);
    assert.equal((await query("SELECT status_text FROM identities WHERE identity_id='alice'")).rows[0].status_text,null);
    const versioned=reliableOperation(async(req,res)=>{await query('UPDATE identities SET status_text=$1 WHERE identity_id=\'alice\'',[req.signedRequest.payload.value]);res.json({ok:true});},()=> 'binding:alice');
    const old=opId(Date.now()-1000), newer=opId();
    await run(versioned,newer,{value:'new'});
    assert.equal((await run(versioned,old,{value:'old'})).code,409);
    assert.equal((await query("SELECT status_text FROM identities WHERE identity_id='alice'")).rows[0].status_text,'new');
    // Real repositories: concurrent edits, edit/delete conflicts, clear boundaries and send tombstones.
    const {messageRepository,groupChatRepository,messageArchiveRepository}=moduleAt('db/repositories');
    const {platformRecoveryRepository}=moduleAt('db/repositories/platformRecoveryRepository');
    const {MessageAlreadyAccepted}=moduleAt('services/messageSendReceipt');
    const baseMessage={family_id:family,direct_chat_id:'alice:bob',chat_seq:0,sender_identity_id:'alice',recipient_identity_id:'bob',sender_device_id:'d-alice',ciphertext:'encrypted',sender_signature:'sig',created_at:100,content_updated_at:100,status:'new',status_updated_at:100,revision:1,epoch:1};
    await messageRepository.insertMessage({...baseMessage,server_message_id:'m1',client_message_id:'client-m1'});
    const edit={familyId:family,directChatId:'alice:bob',serverMessageId:'m1',ciphertext:'edited',senderCiphertext:null,senderSignature:'sig',editedAt:200};
    const editClaims=[{payload:{revision:2},signature:'edit-a'},{payload:{revision:2},signature:'edit-b'}];
    const edits=await Promise.allSettled(editClaims.map(authorClaim=>messageRepository.editMessage({...edit,authorClaim})));
    assert.equal(edits.filter(r=>r.status==='fulfilled').length,1);
    const accepted=editClaims[edits[0].status==='fulfilled'?0:1];
    assert.equal((await messageRepository.editMessage({...edit,editedAt:999,authorClaim:accepted})).edited_at,200);
    const races=await Promise.allSettled([
      messageRepository.editMessage({...edit,authorClaim:{payload:{revision:3},signature:'edit-c'}}),
      messageRepository.softDeleteMessage({familyId:family,directChatId:'alice:bob',serverMessageId:'m1',deletedAt:300,authorClaim:{payload:{revision:3},signature:'delete-c'}})
    ]);
    assert.equal(races.filter(r=>r.status==='fulfilled').length,1);
    const boundary=(await query("SELECT chat_seq FROM messages WHERE server_message_id='m1'")).rows[0].chat_seq;
    await messageRepository.deleteThreadMessages(family,'alice','bob',boundary);
    await messageRepository.insertMessage({...baseMessage,server_message_id:'m2',client_message_id:'client-m2'});
    assert.equal(await messageRepository.deleteThreadMessages(family,'alice','bob',boundary),0);
    assert.equal((await messageRepository.findByClientMessageId(family,'d-alice','client-m1')).server_message_id,'m1');
    await assert.rejects(messageRepository.insertMessage({...baseMessage,server_message_id:'resurrected',client_message_id:'client-m1'}),MessageAlreadyAccepted);
    const duplicateSends=await Promise.allSettled(['race1','race2'].map(server_message_id=>messageRepository.insertMessage({...baseMessage,server_message_id,client_message_id:'duplicate-send'})));
    assert.equal(duplicateSends.filter(r=>r.status==='fulfilled').length,1);
    const rejectedSend=duplicateSends.find(r=>r.status==='rejected').reason;
    assert.ok(rejectedSend instanceof MessageAlreadyAccepted);
    assert.ok(['race1','race2'].includes(rejectedSend.messageId));
    await query("INSERT INTO group_chats(chat_id,family_id,title_ciphertext,owner_identity_id,created_at,updated_at) VALUES ('group',$1,'encrypted','alice',100,100)",[family]);
    const groupMessage={...baseMessage,chat_id:'group',message_id:'g1',kind:'user',client_message_id:'client-g1'};
    await groupChatRepository.insertMessage(groupMessage);
    const groupEdit={familyId:family,chatId:'group',messageId:'g1',ciphertext:'edited',senderSignature:'sig',editedAt:200};
    const groupEdits=await Promise.allSettled(editClaims.map(authorClaim=>groupChatRepository.editMessage({...groupEdit,authorClaim})));
    assert.equal(groupEdits.filter(r=>r.status==='fulfilled').length,1);
    const groupRaces=await Promise.allSettled([
      groupChatRepository.editMessage({...groupEdit,authorClaim:{payload:{revision:3},signature:'edit-c'}}),
      groupChatRepository.softDeleteMessage({familyId:family,chatId:'group',messageId:'g1',deletedAt:300,authorClaim:{payload:{revision:3},signature:'delete-c'}})
    ]);
    assert.equal(groupRaces.filter(r=>r.status==='fulfilled').length,1);
    const gb=(await query("SELECT chat_seq FROM group_chat_messages WHERE message_id='g1'")).rows[0].chat_seq;
    await groupChatRepository.deleteChatMessages(family,'group',gb);
    await groupChatRepository.insertMessage({...groupMessage,message_id:'g2',client_message_id:'client-g2'});
    assert.equal(await groupChatRepository.deleteChatMessages(family,'group',gb),0);
    await assert.rejects(groupChatRepository.insertMessage({...groupMessage,message_id:'g-resurrected'}),MessageAlreadyAccepted);
    const archive=await messageArchiveRepository.createJob({familyId:family,ownerIdentityId:'alice',writerDeviceId:'d-alice',wrappedArchiveKey:{encrypted:true}});
    const segment={familyId:family,archiveId:archive.archive_id,ownerIdentityId:'alice',writerDeviceId:'d-alice',periodKey:'2026-09',messageCount:1,byteSize:10,encryptedSegment:{data:'a'},expectedRevision:null};
    await messageArchiveRepository.putSegment(segment);
    await assert.rejects(messageArchiveRepository.putSegment({...segment,encryptedSegment:{data:'stale'}}),/revision conflict/);
    const segmentWrites=await Promise.allSettled(['b','c'].map(data=>messageArchiveRepository.putSegment({...segment,expectedRevision:1,encryptedSegment:{data}})));
    assert.equal(segmentWrites.filter(r=>r.status==='fulfilled').length,1);
    const binding={payload:{bindingId:'binding-a',recoverySlot:'android_google_restore_v1'}};
    await platformRecoveryRepository.replaceActiveBinding({familyId:family,identityId:'alice',binding});
    await assert.rejects(platformRecoveryRepository.replaceActiveBinding({familyId:family,identityId:'bob',binding}),/already in use/);
    await assert.rejects(platformRecoveryRepository.replaceActiveBinding({familyId:family,identityId:'alice',binding:{payload:{...binding.payload,changed:true}}}),/immutable/);
    await platformRecoveryRepository.revokeActiveBinding(family,'alice','binding-a','android_google_restore_v1');
    await assert.rejects(platformRecoveryRepository.replaceActiveBinding({familyId:family,identityId:'alice',binding}),/cannot be reactivated/);
    // Run real payload and ACK handlers, deliberately discarding the first payload response.
    const temporaryRouter=moduleAt('routes/temporaryAccess').default;
    const invoke=async(route,device,requestId)=>{
      const h=temporaryRouter.stack.find(l=>l.route?.path===route).route.stack.at(-1).handle;
      const req={familyId:family,device,identity:{role:'member'},signedRequest:{payload:{requestId}}};
      let response;const res={status(code){this.code=code;return this;},json(body){response={code:this.code||200,body};return this;}};
      await h(req,res,error=>{throw error});return response;
    };
    for (const [prefix,requestType] of [['trusted','trusted_access'],['renewal','temporary_renewal']]) {
      const tempId='temp-'+prefix,requestId='request-'+prefix;
      await query("INSERT INTO temporary_devices(device_id,identity_id,family_id,public_key_algorithm,public_key_value,approved_by_device_id,expires_at) VALUES ($1::varchar,'alice',$2,'ed25519',$1::text,'d-alice',NOW()+INTERVAL '1 hour')",[tempId,family]);
      await query("INSERT INTO temporary_access_requests(request_id,request_type,family_id,identity_id,enrollment_id,temporary_device_id,temporary_device_public_key_algorithm,temporary_device_public_key_value,status,encrypted_payload,cipher,expires_at) VALUES ($1,$2,$3,'alice','enrollment',$4,'ed25519',$4,'approved','encrypted-secret','cipher',NOW()+INTERVAL '1 hour')",[requestId,requestType,family,tempId]);
      const temporary={deviceId:tempId,identityId:'alice',accessLevel:'temporary'};
      const first=await invoke('/'+prefix+'/payload',temporary,requestId);
      assert.equal(first.code,200);assert.deepEqual(await invoke('/'+prefix+'/payload',temporary,requestId),first);
      assert.equal((await query('SELECT status FROM temporary_devices WHERE device_id=$1',[tempId])).rows[0].status,'active');
      if (prefix==='trusted') {
        // A failure while revoking the device must also roll back the consumed marker.
        await query("CREATE FUNCTION reliability_reject_revoke() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated revoke failure'; END $$");
        await query('CREATE TRIGGER reliability_reject_revoke BEFORE UPDATE ON temporary_devices FOR EACH ROW EXECUTE FUNCTION reliability_reject_revoke()');
        assert.equal((await invoke('/trusted/ack',{deviceId:'d-alice',identityId:'alice',accessLevel:'trusted'},requestId)).code,409);
        assert.equal((await query('SELECT status FROM temporary_access_requests WHERE request_id=$1',[requestId])).rows[0].status,'approved');
        await query('DROP TRIGGER reliability_reject_revoke ON temporary_devices');
      }
      const ackDevice=prefix==='trusted'?{deviceId:'d-alice',identityId:'alice',accessLevel:'trusted'}:temporary;
      assert.equal((await invoke('/'+prefix+'/ack',{...ackDevice,identityId:'bob'},requestId)).code,409);
      assert.equal((await invoke('/'+prefix+'/ack',ackDevice,requestId)).code,200);
      assert.equal((await invoke('/'+prefix+'/ack',ackDevice,requestId)).code,200);
      assert.equal((await query('SELECT status FROM temporary_devices WHERE device_id=$1',[tempId])).rows[0].status,prefix==='trusted'?'revoked':'active');
    }
    console.log('PASS: direct/group edit and delete CAS; bounded clear; send receipts after deletion and concurrent sends; archive insert/update CAS; revoked recovery binding; temporary payload loss and repeated ACK.');
    console.log('PASS: public baseline; durable nonce race/restart; claim race/retry; vault insert/update CAS; operation race/restart/fingerprint/encryption/rollback; binding ordering.');
  } finally {await db.closeDatabase();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});

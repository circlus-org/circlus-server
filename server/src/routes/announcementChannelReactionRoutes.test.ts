import fs from 'node:fs';
import path from 'node:path';
import { initializeDatabase, closeDatabase, query } from '../db';
import { channelReactionHandler } from './announcementChannelReactionRoutes';
import type { AuthRequest } from '../middleware/auth';
import { validChannelReactionWrite, canReplaceChannelReactions } from '../../../shared/channelReactions';
jest.mock('../middleware/auth',()=>({verifySignature:(_r:any,_s:any,n:any)=>n(),requireActiveIdentity:(_r:any,_s:any,n:any)=>n(),getSignedPayload:(r:any)=>r.signedRequest.payload}));

describe('channel reaction payload policy',()=>{
  it('accepts full catalog emoji sequences but not arbitrary strings or duplicate emoji',()=>{
    expect(validChannelReactionWrite({postId:'p',revision:1,emojis:['👍🏽','👨‍👩‍👧‍👦','🇬🇪']})).toBe(true);
    for(const emojis of [['hello'],['👍','👍'],Array(13).fill('❤️')]) expect(validChannelReactionWrite({postId:'p',revision:1,emojis})).toBe(false);
    expect(canReplaceChannelReactions(false,['👍','❤️'],['❤️'])).toBe(true);
    expect(canReplaceChannelReactions(false,['👍'],['❤️'])).toBe(false);
  });
});
const dbDescribe = process.env.REACTION_TEST_DATABASE_URL ? describe : describe.skip;
dbDescribe('channel reactions on real PostgreSQL',()=>{
  const schema=`channel_reactions_test_${process.pid}`;
  const family='00000000-0000-0000-0000-000000000001';
  async function call(action:'list'|'set'|'settings'|'readers',actor:string,payload:any={},channelId='channel',familyId=family){
    let status=200,body:any,failure:unknown;
    const res={status(code:number){status=code;return res;},json(value:unknown){body=value;return res;}};
    await channelReactionHandler(action)({familyId,identity:{identityId:actor},params:{channelId},signedRequest:{payload}} as unknown as AuthRequest,res,(error:unknown)=>{failure=error;});
    if(failure)throw failure;
    return {status,body};
  }
  const set=(actor:string,revision=1,emojis=['👍'])=>call('set',actor,{postId:'post',revision,emojis});
  beforeAll(async()=>{
    const url=new URL(process.env.REACTION_TEST_DATABASE_URL!);url.searchParams.set('options',`-c search_path=${schema},public`);
    initializeDatabase(url.toString());await query(`CREATE SCHEMA ${schema}`);
    await query(`CREATE TABLE announcement_channels(channel_id text PRIMARY KEY,family_id uuid,owner_identity_id text,status text);
      CREATE TABLE announcement_channel_posts(post_id text PRIMARY KEY,channel_id text,family_id uuid,deleted_at timestamp);
      CREATE TABLE announcement_channel_subscriptions(channel_id text,family_id uuid,subscriber_identity_id text,status text);`);
    await query(fs.readFileSync(path.resolve(__dirname,'../../db/migrations/000-pre-public/158_channel_reactions.sql'),'utf8'));
  });
  afterAll(async()=>{await query(`DROP SCHEMA ${schema} CASCADE`);await closeDatabase();});
  beforeEach(async()=>{
    await query('TRUNCATE announcement_channel_reactions,announcement_channel_posts,announcement_channels,announcement_channel_subscriptions CASCADE');
    await query("INSERT INTO announcement_channels VALUES('channel',$1,'owner','active',false),('other',$1,'owner','active',false)",[family]);
    await query("INSERT INTO announcement_channel_posts VALUES('post','channel',$1,NULL),('foreign','other',$1,NULL)",[family]);
    await query("INSERT INTO announcement_channel_subscriptions VALUES('channel',$1,'alice','active'),('channel',$1,'bob','active'),('channel',$1,'guest','active')",[family]);
  });
  it('defaults off, only author changes the setting, active subscribers including guests may react',async()=>{
    expect((await set('alice')).status).toBe(403);
    expect((await call('settings','alice',{enabled:true})).status).toBe(403);
    expect((await call('settings','owner',{enabled:true})).status).toBe(200);
    expect((await set('guest')).status).toBe(200);
    expect((await set('stranger')).status).toBe(403);
  });
  it('aggregates immediately and never exposes other readers through list/set responses',async()=>{
    await call('settings','owner',{enabled:true});await set('alice');await set('bob');
    const result=(await call('list','alice',{postIds:['post']})).body.result;
    expect(result).toEqual({enabled:true,states:[{postId:'post',revision:1,mine:['👍'],counts:[{emoji:'👍',count:2}]}]});
    expect(JSON.stringify(result)).not.toContain('bob');
    expect((await call('readers','alice',{postId:'post'})).status).toBe(403);
    expect((await call('readers','owner',{postId:'post'})).body.result.readers).toEqual([{identityId:'alice',emojis:['👍']},{identityId:'bob',emojis:['👍']}]);
  });
  it('retries do not double count and stale retries cannot resurrect removed reactions',async()=>{
    await call('settings','owner',{enabled:true});
    expect((await set('alice')).status).toBe(200);expect((await set('alice')).status).toBe(200);
    expect((await set('alice',2,[])).status).toBe(200);expect((await set('alice')).status).toBe(409);
    expect((await call('list','bob',{postIds:['post']})).body.result.states[0].counts).toEqual([]);
  });
  it('serializes competing devices of the same identity',async()=>{
    await call('settings','owner',{enabled:true});
    const results=await Promise.all([set('alice',1,['👍']),set('alice',1,['❤️'])]);
    expect(results.map(r=>r.status).sort()).toEqual([200,409]);
  });
  it('disabling preserves counts, allows only removal and acknowledges an already committed retry',async()=>{
    await call('settings','owner',{enabled:true});await set('alice',1,['👍','❤️']);
    await call('settings','owner',{enabled:false});
    expect((await set('alice',1,['👍','❤️'])).status).toBe(200);
    expect((await set('alice',2,['👍','😂'])).status).toBe(403);
    expect((await set('alice',2,['❤️'])).status).toBe(200);
    expect((await set('alice',3,[])).status).toBe(200);
  });
  it('rejects revoked and paused subscriptions, foreign posts and another circle',async()=>{
    await call('settings','owner',{enabled:true});await set('alice');
    for(const status of ['removed_by_author','paused','unsubscribed']){
      await query('UPDATE announcement_channel_subscriptions SET status=$1 WHERE subscriber_identity_id=$2',[status,'alice']);
      expect((await set('alice',2,[])).status).toBe(403);
      expect((await call('list','alice',{postIds:['post']})).status).toBe(403);
    }
    expect((await call('set','bob',{postId:'foreign',revision:1,emojis:['👍']})).status).toBe(404);
    expect((await call('list','bob',{postIds:['post']},'channel','00000000-0000-0000-0000-000000000002')).status).toBe(404);
  });
  it('paginates author-only readers without leaking extra rows and validates malformed requests',async()=>{
    await query(`INSERT INTO announcement_channel_reactions(family_id,channel_id,post_id,actor_identity_id,revision,emojis)
      SELECT $1,'channel','post','reader-'||LPAD(n::text,3,'0'),1,ARRAY['👍'] FROM generate_series(1,51) AS n`,[family]);
    const first=(await call('readers','owner',{postId:'post'})).body.result;
    expect(first.readers).toHaveLength(50);expect(first.nextCursor).toBe('reader-050');
    const second=(await call('readers','owner',{postId:'post',cursor:first.nextCursor})).body.result;
    expect(second.readers).toEqual([{identityId:'reader-051',emojis:['👍']}]);expect(second.nextCursor).toBeNull();
    expect((await call('list','alice',null)).status).toBe(400);
    expect((await call('list','alice',{postIds:Array(101).fill('post')})).status).toBe(400);
  });
  it('hides deleted posts and cascades physical deletion',async()=>{
    await call('settings','owner',{enabled:true});await set('alice');
    await query("UPDATE announcement_channel_posts SET deleted_at=NOW() WHERE post_id='post'");
    expect((await call('list','bob',{postIds:['post']})).body.result.states).toEqual([]);
    expect((await set('alice',2,[])).status).toBe(404);
    await query("DELETE FROM announcement_channel_posts WHERE post_id='post'");
    expect((await query('SELECT * FROM announcement_channel_reactions')).rowCount).toBe(0);
  });
});

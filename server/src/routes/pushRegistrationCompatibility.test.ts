import type { RequestHandler } from 'express';
jest.mock('../db', () => ({
  transaction: jest.fn(async (callback: any) => callback({query: jest.fn(async () => ({rows:[{version_id:'v'}]}))})),
  inTransactionContext: jest.fn(async (_client: unknown, callback: any) => callback())
}));
jest.mock('../ws/wsGateway', () => ({}));
jest.mock('../db/repositories/mobileNotificationRepository', () => ({
  mobileNotificationRepository: {upsertDirectMobileRoute: jest.fn()},
  normalizeNativeMessagePreviewMode: () => 'off'
}));
jest.mock('../db/repositories', () => ({
  pushSubscriptionRepository: {findByDeviceAndEndpoint: jest.fn()},
  deviceRepository: {}, identityRepository: {}, temporaryDeviceRepository: {}
}));
import mobile from './mobile';
import push from './push';
import { transaction } from '../db';
import { mobileNotificationRepository } from '../db/repositories/mobileNotificationRepository';
import { pushSubscriptionRepository } from '../db/repositories';
import { verifySignature, requireActiveIdentity } from '../middleware/auth';

const route = (router: any, path: string) => router.stack.find((layer: any) => layer.route?.path === path).route;
const mobileRoute = route(mobile, '/devices/delivery-tokens/register');
const pushRoute = route(push, '/subscribe');
const cases = [
  {name:'mobile', route:mobileRoute, type:'mobile:device:delivery-token:register',
    payload:{mobileEndpointId:'endpoint',deliveryToken:'token',pushEncryptionPublicKey:'key'},
    effect:mobileNotificationRepository.upsertDirectMobileRoute},
  {name:'web', route:pushRoute, type:'push:subscribe',
    payload:{subscription:{endpoint:'https://push.example/endpoint'},pushEncryptionPublicKey:'key'},
    effect:pushSubscriptionRepository.findByDeviceAndEndpoint}
];
async function invoke(item: typeof cases[number], fields: Record<string, unknown>) {
  const signed={type:item.type,signerId:'device',payload:item.payload,...fields};
  const req:any={familyId:'family',device:{deviceId:'device'},pushSigner:{deviceId:'device'},params:{},signedRequest:signed,body:signed};
  const res:any={statusCode:200,status(code:number){this.statusCode=code;return this;},json(body:unknown){this.body=body;return this;}};
  const handler:RequestHandler=item.route.stack.at(-1).handle;
  await handler(req,res,error=>{throw error;});
  return res;
}
describe('temporary push registration compatibility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Exercise the real handler's provider-expired branch without contacting a relay.
    jest.mocked(pushSubscriptionRepository.findByDeviceAndEndpoint).mockResolvedValue({status:'invalid',push_id:'push'} as any);
    jest.mocked(transaction).mockImplementation(async (callback:any) => callback({query:jest.fn(async (sql:string) => ({
      rows:sql.includes('SELECT fingerprint') ? [] : [{version_id:'v'}]
    }))}));
  });
  test('authentication precedes the mobile compatibility adapter', () => {
    expect(mobileRoute.stack[0].handle).toBe(verifySignature);
    expect(mobileRoute.stack[1].handle).toBe(requireActiveIdentity);
    expect(pushRoute.stack.at(-2).handle.name).toBe('requirePushSignature');
  });
  describe.each(cases)('$name registration', item => {
    test('accepts an authenticated old request without operationId', async () => {
      expect((await invoke(item,{})).statusCode).toBe(200);
      expect(item.effect).toHaveBeenCalledTimes(1);
      expect(transaction).not.toHaveBeenCalled();
    });
    test.each([null,'',123,'invalid',undefined])('rejects a supplied invalid operationId %p', async operationId => {
      expect((await invoke(item,{operationId})).statusCode).toBe(400);
      expect(item.effect).not.toHaveBeenCalled();
    });
    test('keeps new registrations transactional', async () => {
      const operationId=Date.now().toString(16).padStart(16,'0')+'-'+'a'.repeat(64);
      expect((await invoke(item,{operationId})).statusCode).toBe(200);
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(item.effect).toHaveBeenCalledTimes(1);
    });
    test('keeps payload validation for old requests', async () => {
      expect((await invoke(item,{payload:{}})).statusCode).toBe(400);
      expect(item.effect).not.toHaveBeenCalled();
    });
  });
});

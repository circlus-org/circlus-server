import type { RequestHandler } from 'express';
import { accessResource, accessScope } from '../../../shared/accessOperations';
import { reliableOperation } from './reliableOperation';

export function versionedAccessOperation(handler: RequestHandler): RequestHandler {
  return Object.assign(reliableOperation(handler, req => {
    const path = req.originalUrl.split('?')[0].replace(/^\/api(?=\/)/, '');
    if (req.signedRequest.accessPath !== path) {
      throw Object.assign(new Error('Access destination mismatch'), {reply:{status:400,body:{status:'error',error:{code:'INVALID_REQUEST',message:'Signed accessPath does not match destination'}}}});
    }
    try {
      return accessResource(req.signedRequest.type, path, req.signedRequest.payload, req.device.identityId);
    } catch {
      throw Object.assign(new Error('Invalid access target'), {reply:{status:400,body:{status:'error',error:{code:'INVALID_REQUEST',message:'Invalid access operation target'}}}});
    }
  }, { expectedVersion: true, scope: req => accessScope(req.signedRequest.type, req.familyId) }), { accessVersioned: true });
}

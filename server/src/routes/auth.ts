import { Router } from 'express';
import authIdentityRegistrationRoutes from './authIdentityRegistrationRoutes';
import authDeviceRegistrationRoutes from './authDeviceRegistrationRoutes';
import authIdentityLookupRoutes from './authIdentityLookupRoutes';

const router = Router();

router.use(authIdentityRegistrationRoutes);
router.use(authDeviceRegistrationRoutes);
router.use(authIdentityLookupRoutes);

export default router;

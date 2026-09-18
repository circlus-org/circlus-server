import { Router } from 'express';
import adminConfigRoutes from './adminConfigRoutes';
import adminUserRoutes from './adminUserRoutes';
import adminInviteRoutes from './adminInviteRoutes';
import adminMediaRoutingRoutes from './adminMediaRoutingRoutes';

const router = Router();

router.use(adminConfigRoutes);
router.use(adminUserRoutes);
router.use(adminInviteRoutes);
router.use(adminMediaRoutingRoutes);

export default router;

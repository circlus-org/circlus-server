import { Router } from 'express';
import deviceEnrollmentBootstrapRoutes from './deviceEnrollmentBootstrapRoutes';
import deviceEnrollmentApprovalRoutes from './deviceEnrollmentApprovalRoutes';
import deviceEnrollmentActivationRoutes from './deviceEnrollmentActivationRoutes';
import deviceEnrollmentStatusRoutes from './deviceEnrollmentStatusRoutes';
import deviceEnrollmentPlatformRecoveryRoutes from './deviceEnrollmentPlatformRecoveryRoutes';

const router = Router();

router.use(deviceEnrollmentBootstrapRoutes);
router.use(deviceEnrollmentApprovalRoutes);
router.use(deviceEnrollmentActivationRoutes);
router.use(deviceEnrollmentStatusRoutes);
router.use(deviceEnrollmentPlatformRecoveryRoutes);

export default router;

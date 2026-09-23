import { Router, Response } from 'express';
import { validateRequest, validateQuery, adjustPointsSchema, adjustCreditSchema, serviceTypeWeightSchema, paginationSchema } from '../middleware/validator';
import {
  adjustPoints,
  adjustCreditScore,
  getAdminAuditLogs,
  setVolunteerStatus,
} from '../services/adminService';
import {
  getCurrentServiceTypeWeights,
  getServiceTypeWeightHistory,
  adjustServiceTypeWeight,
  TYPE_VERSION_CONFLICT,
} from '../services/serviceTypeWeightService';
import { AuthRequest, requireAdmin } from '../middleware/auth';
import { messages } from '../constants/messages';
import { sendBadRequest, sendInternalError } from '../utils/httpResponses';

const router = Router();

router.use(requireAdmin);

router.post('/adjust-points', validateRequest(adjustPointsSchema), async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.user?.id || 'admin';
    const result = await adjustPoints(
      req.body.volunteer_id,
      req.body.points_change,
      adminId,
      req.body.reason
    );
    const statusCode = result.success ? 200 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error adjusting points');
  }
});

router.post('/adjust-credit', validateRequest(adjustCreditSchema), async (req: AuthRequest, res: Response) => {
  try {
    const adminId = req.user?.id || 'admin';
    const result = await adjustCreditScore(
      req.body.volunteer_id,
      req.body.credit_change,
      adminId,
      req.body.reason
    );
    const statusCode = result.success ? 200 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error adjusting credit score');
  }
});

router.get('/audit-logs', validateQuery(paginationSchema), async (req: AuthRequest, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.page_size as string) || 20;
    const adminId = req.query.admin_id as string;
    const action = req.query.action as string;
    const result = await getAdminAuditLogs(page, pageSize, adminId, action);
    res.status(200).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error getting audit logs');
  }
});

router.patch('/volunteers/:id/status', async (req: AuthRequest, res: Response) => {
  try {
    const isActive = req.body.is_active;
    if (typeof isActive !== 'boolean') {
      sendBadRequest(res, messages.validation.activeFlagRequired);
      return;
    }
    const adminId = req.user?.id || 'admin';
    const reason = req.body.reason || '管理员操作';
    const result = await setVolunteerStatus(req.params.id, isActive, adminId, reason);
    const statusCode = result.success ? 200 : 400;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error setting volunteer status');
  }
});

router.get('/service-types/weights', async (_req: AuthRequest, res: Response) => {
  try {
    const result = await getCurrentServiceTypeWeights();
    res.status(200).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error getting service type weights');
  }
});

router.get('/service-types/:type/versions', async (req: AuthRequest, res: Response) => {
  try {
    const result = await getServiceTypeWeightHistory(req.params.type);
    const statusCode = result.success ? 200 : 404;
    res.status(statusCode).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error getting service type versions');
  }
});

router.put('/service-types/weights', validateRequest(serviceTypeWeightSchema), async (req: AuthRequest, res: Response) => {
  try {
    if (req.body.weight === undefined && req.body.is_active === undefined) {
      sendBadRequest(res, messages.validation.weightAdjustFieldsRequired);
      return;
    }

    const adminId = req.user?.id || 'admin';
    const result = await adjustServiceTypeWeight({
      type: req.body.type,
      weight: req.body.weight,
      is_active: req.body.is_active,
      expected_version: req.body.expected_version,
      adminId,
      reason: req.body.reason,
    });

    if (!result.success) {
      res.status(result.code === TYPE_VERSION_CONFLICT ? 409 : 400).json(result);
      return;
    }

    res.status(200).json(result);
  } catch (error) {
    sendInternalError(res, error, 'Error adjusting service type weight');
  }
});

export default router;

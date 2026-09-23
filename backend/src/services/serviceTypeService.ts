import { PoolClient, QueryResult } from 'pg';
import pool from '../db/pool';
import {
  ApiResponse,
  ServiceTypeConfig,
  MIN_SERVICE_TYPE_WEIGHT,
  MAX_SERVICE_TYPE_WEIGHT,
} from '../types';
import { logger } from '../utils/logger';
import { messages } from '../constants/messages';

export interface ServiceTypeCheckResult {
  success: boolean;
  serviceType?: ServiceTypeConfig;
  error?: string;
}

export interface WeightVersionConflict {
  code: 'VERSION_CONFLICT';
  currentVersion: number;
  currentWeight: number;
  isActive: boolean;
}

const mapServiceType = (row: any): ServiceTypeConfig => ({
  type: row.type,
  name: row.name,
  weight: Number(row.weight),
  is_active: row.is_active,
  version: row.version,
  updated_by: row.updated_by ?? undefined,
  updated_at: row.updated_at,
});

export const getServiceTypes = async (
  includeInactive: boolean = true
): Promise<ApiResponse<{ serviceTypes: ServiceTypeConfig[]; currentVersion: Record<string, number> }>> => {
  const client = await pool.connect();

  try {
    const result = await client.query(
      `SELECT * FROM service_type_weights
       WHERE ($1 = true OR is_active = true)
       ORDER BY type ASC`,
      [includeInactive]
    );

    const serviceTypes = result.rows.map(mapServiceType);
    const currentVersion: Record<string, number> = {};
    serviceTypes.forEach(t => {
      currentVersion[t.type] = t.version;
    });

    return { success: true, data: { serviceTypes, currentVersion } };
  } finally {
    client.release();
  }
};

// 供服务记录提交使用：类型不存在或已停用都拒绝，并把类型信息带回给调用方展示
export const getActiveServiceType = async (
  client: PoolClient,
  type: string
): Promise<ServiceTypeCheckResult> => {
  const result: QueryResult = await client.query(
    'SELECT * FROM service_type_weights WHERE type = $1',
    [type]
  );

  if (result.rows.length === 0) {
    return { success: false, error: messages.serviceTypes.notFound };
  }

  const serviceType = mapServiceType(result.rows[0]);

  if (!serviceType.is_active) {
    return { success: false, serviceType, error: messages.serviceTypes.disabled(type) };
  }

  return { success: true, serviceType };
};

export const adjustServiceTypeWeight = async (
  type: string,
  updates: { weight?: number; isActive?: boolean },
  expectedVersion: number,
  adminId: string,
  reason: string
): Promise<ApiResponse<any>> => {
  if (updates.weight === undefined && updates.isActive === undefined) {
    return { success: false, error: messages.serviceTypes.noFieldsToUpdate };
  }

  if (
    updates.weight !== undefined &&
    (updates.weight < MIN_SERVICE_TYPE_WEIGHT || updates.weight > MAX_SERVICE_TYPE_WEIGHT)
  ) {
    return {
      success: false,
      error: `权重必须在 ${MIN_SERVICE_TYPE_WEIGHT} 到 ${MAX_SERVICE_TYPE_WEIGHT} 之间`,
    };
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const currentResult = await client.query(
      'SELECT * FROM service_type_weights WHERE type = $1 FOR UPDATE',
      [type]
    );

    if (currentResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return { success: false, error: messages.serviceTypes.notFound };
    }

    const current = mapServiceType(currentResult.rows[0]);

    // 同一类型重复或并发调整：版本号不匹配直接失败，整单回滚不产生半更新
    if (current.version !== expectedVersion) {
      await client.query('ROLLBACK');
      const conflict: WeightVersionConflict = {
        code: 'VERSION_CONFLICT',
        currentVersion: current.version,
        currentWeight: current.weight,
        isActive: current.is_active,
      };
      return {
        success: false,
        error: messages.serviceTypes.versionConflict(type, expectedVersion, current.version),
        details: conflict,
      };
    }

    const newWeight = updates.weight !== undefined ? updates.weight : current.weight;
    const newIsActive = updates.isActive !== undefined ? updates.isActive : current.is_active;
    const newVersion = current.version + 1;

    const updateResult = await client.query(
      `UPDATE service_type_weights
       SET weight = $1,
           is_active = $2,
           version = $3,
           updated_by = $4
       WHERE type = $5 AND version = $6
       RETURNING *`,
      [newWeight, newIsActive, newVersion, adminId, type, expectedVersion]
    );

    // 双重保险：若行级锁释放后版本被改，UPDATE 命中 0 行，整个事务回滚
    if (updateResult.rowCount === 0) {
      await client.query('ROLLBACK');
      return {
        success: false,
        error: messages.serviceTypes.versionConflict(type, expectedVersion, expectedVersion + 1),
        details: { code: 'VERSION_CONFLICT' },
      };
    }

    await client.query(
      `INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, old_value, new_value, reason)
       VALUES ($1, 'adjust_service_type', 'service_type', NULL, $2, $3, $4)`,
      [
        adminId,
        {
          type,
          weight: current.weight,
          is_active: current.is_active,
          version: current.version,
        },
        {
          type,
          weight: Number(newWeight),
          is_active: newIsActive,
          version: newVersion,
        },
        reason,
      ]
    );

    await client.query('COMMIT');

    // 权重版本仅对新提交生效，历史服务记录、积分、等级、徽章、信用分均不重算
    return {
      success: true,
      data: {
        serviceType: mapServiceType(updateResult.rows[0]),
        oldWeight: current.weight,
        newWeight: Number(newWeight),
        oldIsActive: current.is_active,
        newIsActive,
        oldVersion: current.version,
        newVersion,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(messages.logs.adjustServiceTypeFailed, error);
    return { success: false, error: messages.serviceTypes.adjustFailed };
  } finally {
    client.release();
  }
};

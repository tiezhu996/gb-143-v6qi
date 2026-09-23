import { PoolClient } from 'pg';
import {
  ApiResponse,
  ServiceTypeWeightVersion,
  AdjustServiceTypeWeightInput,
} from '../types';
import pool from '../db/pool';
import { logger } from '../utils/logger';
import { messages } from '../constants/messages';

export const TYPE_VERSION_CONFLICT = 'SERVICE_TYPE_VERSION_CONFLICT';

interface LatestTypeRow {
  type: string;
  name: string;
  weight: string;
  is_active: boolean;
  version: number;
}

const normalizeRow = (row: LatestTypeRow): ServiceTypeWeightVersion => ({
  type: row.type,
  name: row.name,
  weight: parseFloat(row.weight),
  is_active: row.is_active,
  version: row.version,
});

// 查询所有服务类型的当前版本（每个类型取最大版本号）
export const getCurrentServiceTypeWeights = async (): Promise<ApiResponse<ServiceTypeWeightVersion[]>> => {
  const client = await pool.connect();

  try {
    const result = await client.query(`
      SELECT v.type, v.name, v.weight, v.is_active, v.version
      FROM service_type_weight_versions v
      JOIN (
        SELECT type, MAX(version) AS max_version
        FROM service_type_weight_versions
        GROUP BY type
      ) latest ON latest.type = v.type AND latest.max_version = v.version
      ORDER BY v.type
    `);

    return { success: true, data: result.rows.map(normalizeRow) };
  } finally {
    client.release();
  }
};

// 查询单个服务类型的全部历史版本，旧明细据此展示当时权重
export const getServiceTypeWeightHistory = async (
  serviceType: string
): Promise<ApiResponse<ServiceTypeWeightVersion[]>> => {
  const client = await pool.connect();

  try {
    const result = await client.query(
      `SELECT type, name, weight, is_active, version, reason, created_by, created_at
       FROM service_type_weight_versions
       WHERE type = $1
       ORDER BY version DESC`,
      [serviceType]
    );

    if (result.rows.length === 0) {
      return { success: false, error: messages.serviceTypes.notFound };
    }

    const versions: ServiceTypeWeightVersion[] = result.rows.map(row => ({
      type: row.type,
      name: row.name,
      weight: parseFloat(row.weight),
      is_active: row.is_active,
      version: row.version,
      reason: row.reason ?? undefined,
      created_by: row.created_by ?? undefined,
      created_at: row.created_at,
    }));

    return { success: true, data: versions };
  } finally {
    client.release();
  }
};

// 在服务记录事务内读取某类型的当前版本；不存在或已停用返回 null
export const findActiveTypeInTransaction = async (
  client: PoolClient,
  serviceType: string
): Promise<ServiceTypeWeightVersion | null> => {
  const result = await client.query(
    `SELECT type, name, weight, is_active, version
     FROM service_type_weight_versions
     WHERE type = $1
     ORDER BY version DESC
     LIMIT 1`,
    [serviceType]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return normalizeRow(result.rows[0]);
};

// 乐观锁 + 唯一约束双重保证：同一类型相同版本只有一次调整成功，失败整体回滚
export const adjustServiceTypeWeight = async (
  input: AdjustServiceTypeWeightInput
): Promise<ApiResponse<any>> => {
  const { type, weight, is_active, expected_version, adminId, reason } = input;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const currentResult = await client.query(
      `SELECT type, name, weight, is_active, version
       FROM service_type_weight_versions
       WHERE type = $1
       ORDER BY version DESC
       LIMIT 1
       FOR UPDATE`,
      [type]
    );

    if (currentResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return {
        success: false,
        error: messages.serviceTypes.notFound,
        details: { service_type: type },
      };
    }

    const current = normalizeRow(currentResult.rows[0]);

    // 并发或重复提交：版本号已前进，拒绝且不产生任何半更新
    if (current.version !== expected_version) {
      await client.query('ROLLBACK');
      return {
        success: false,
        code: TYPE_VERSION_CONFLICT,
        error: messages.serviceTypes.versionConflict(type, expected_version, current.version),
        details: {
          service_type: type,
          expected_version,
          current_version: current.version,
        },
      };
    }

    const nextWeight = typeof weight === 'number' ? weight : current.weight;
    const nextActive = typeof is_active === 'boolean' ? is_active : current.is_active;

    if (nextWeight === current.weight && nextActive === current.is_active) {
      await client.query('ROLLBACK');
      return {
        success: false,
        error: messages.serviceTypes.noChange,
        details: { service_type: type, current_version: current.version },
      };
    }

    const nextVersion = current.version + 1;
    const insertResult = await client.query(
      `INSERT INTO service_type_weight_versions
         (type, name, weight, is_active, version, reason, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [type, current.name, nextWeight, nextActive, nextVersion, reason, adminId]
    );

    await client.query(
      `INSERT INTO admin_audit_logs (admin_id, action, target_type, old_value, new_value, reason)
       VALUES ($1, 'adjust_service_type_weight', 'service_type', $2, $3, $4)`,
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
          weight: nextWeight,
          is_active: nextActive,
          version: nextVersion,
        },
        reason,
      ]
    );

    await client.query('COMMIT');

    const created = insertResult.rows[0];
    return {
      success: true,
      data: {
        type: created.type,
        name: created.name,
        weight: parseFloat(created.weight),
        is_active: created.is_active,
        version: created.version,
      },
    };
  } catch (error: any) {
    await client.query('ROLLBACK').catch(() => undefined);

    // 唯一约束兜底：极端并发下相同 (type, version) 插入冲突，按版本冲突处理
    if (error && error.code === '23505') {
      logger.warn(messages.serviceTypes.versionConflict(type, expected_version, expected_version + 1));
      return {
        success: false,
        code: TYPE_VERSION_CONFLICT,
        error: messages.serviceTypes.versionConflict(type, expected_version, expected_version + 1),
        details: { service_type: type, expected_version },
      };
    }

    logger.error(messages.logs.adjustServiceTypeWeightFailed, error);
    return { success: false, error: messages.serviceTypes.adjustFailed };
  } finally {
    client.release();
  }
};

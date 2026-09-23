import pool from './pool';
import { messages } from '../constants/messages';
import { logger } from '../utils/logger';
import {
  SERVICE_TYPE_WEIGHTS,
  INITIAL_WEIGHT_VERSION,
  MIN_SERVICE_TYPE_WEIGHT,
  MAX_SERVICE_TYPE_WEIGHT,
} from '../types';

const createTables = async (): Promise<void> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query('CREATE EXTENSION IF NOT EXISTS "pgcrypto"');

    await client.query(`
      CREATE TABLE IF NOT EXISTS volunteers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name VARCHAR(100) NOT NULL,
        phone VARCHAR(20),
        email VARCHAR(100),
        total_points INTEGER NOT NULL DEFAULT 0,
        level INTEGER NOT NULL DEFAULT 1,
        credit_score INTEGER NOT NULL DEFAULT 100,
        service_count INTEGER NOT NULL DEFAULT 0,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_volunteers_total_points ON volunteers(total_points DESC);
      CREATE INDEX IF NOT EXISTS idx_volunteers_credit_score ON volunteers(credit_score DESC);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS service_records (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        volunteer_id UUID NOT NULL REFERENCES volunteers(id) ON DELETE CASCADE,
        service_type VARCHAR(50) NOT NULL,
        duration_hours DECIMAL(6,2) NOT NULL,
        rating INTEGER NOT NULL DEFAULT 5 CHECK (rating >= 1 AND rating <= 5),
        points_earned INTEGER NOT NULL DEFAULT 0,
        is_no_show BOOLEAN NOT NULL DEFAULT false,
        location VARCHAR(200),
        description TEXT,
        recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_service_records_volunteer_id ON service_records(volunteer_id);
      CREATE INDEX IF NOT EXISTS idx_service_records_recorded_at ON service_records(recorded_at DESC);
      CREATE INDEX IF NOT EXISTS idx_service_records_service_type ON service_records(service_type);

      ALTER TABLE service_records
        ADD COLUMN IF NOT EXISTS weight_snapshot DECIMAL(4,2),
        ADD COLUMN IF NOT EXISTS weight_version INTEGER;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS service_type_weights (
        type VARCHAR(50) PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        weight DECIMAL(4,2) NOT NULL
          CHECK (weight >= ${MIN_SERVICE_TYPE_WEIGHT} AND weight <= ${MAX_SERVICE_TYPE_WEIGHT}),
        is_active BOOLEAN NOT NULL DEFAULT true,
        version INTEGER NOT NULL DEFAULT ${INITIAL_WEIGHT_VERSION},
        updated_by VARCHAR(100),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS badges (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        volunteer_id UUID NOT NULL REFERENCES volunteers(id) ON DELETE CASCADE,
        star_level INTEGER NOT NULL CHECK (star_level >= 1 AND star_level <= 5),
        badge_name VARCHAR(100) NOT NULL,
        description TEXT,
        awarded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(volunteer_id, star_level)
      );

      CREATE INDEX IF NOT EXISTS idx_badges_volunteer_id ON badges(volunteer_id);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS complaints (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        volunteer_id UUID NOT NULL REFERENCES volunteers(id) ON DELETE CASCADE,
        complainant_id UUID,
        complaint_type VARCHAR(50) NOT NULL,
        description TEXT NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'rejected')),
        resolution TEXT,
        credit_penalty INTEGER DEFAULT 0,
        points_penalty INTEGER DEFAULT 0,
        handled_by VARCHAR(100),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        resolved_at TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_complaints_volunteer_id ON complaints(volunteer_id);
      CREATE INDEX IF NOT EXISTS idx_complaints_status ON complaints(status);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS credit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        volunteer_id UUID NOT NULL REFERENCES volunteers(id) ON DELETE CASCADE,
        change_amount INTEGER NOT NULL,
        reason VARCHAR(200) NOT NULL,
        before_score INTEGER NOT NULL,
        after_score INTEGER NOT NULL,
        related_id UUID,
        related_type VARCHAR(50),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_credit_logs_volunteer_id ON credit_logs(volunteer_id);
      CREATE INDEX IF NOT EXISTS idx_credit_logs_created_at ON credit_logs(created_at DESC);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS points_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        volunteer_id UUID NOT NULL REFERENCES volunteers(id) ON DELETE CASCADE,
        change_amount INTEGER NOT NULL,
        reason VARCHAR(200) NOT NULL,
        before_points INTEGER NOT NULL,
        after_points INTEGER NOT NULL,
        related_id UUID,
        related_type VARCHAR(50),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_points_logs_volunteer_id ON points_logs(volunteer_id);
      CREATE INDEX IF NOT EXISTS idx_points_logs_created_at ON points_logs(created_at DESC);
    `);

    await client.query(`
      ALTER TABLE points_logs
        ADD COLUMN IF NOT EXISTS weight_snapshot DECIMAL(4,2),
        ADD COLUMN IF NOT EXISTS weight_version INTEGER;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_audit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        admin_id VARCHAR(100) NOT NULL,
        action VARCHAR(50) NOT NULL,
        target_type VARCHAR(50) NOT NULL,
        target_id UUID,
        old_value JSONB,
        new_value JSONB,
        reason TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_created_at ON admin_audit_logs(created_at DESC);
    `);

    await client.query(`
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
      END;
      $$ language 'plpgsql';

      DROP TRIGGER IF EXISTS update_volunteers_updated_at ON volunteers;
      CREATE TRIGGER update_volunteers_updated_at
        BEFORE UPDATE ON volunteers
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

      DROP TRIGGER IF EXISTS update_service_records_updated_at ON service_records;
      CREATE TRIGGER update_service_records_updated_at
        BEFORE UPDATE ON service_records
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

      DROP TRIGGER IF EXISTS update_service_type_weights_updated_at ON service_type_weights;
      CREATE TRIGGER update_service_type_weights_updated_at
        BEFORE UPDATE ON service_type_weights
        FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
    `);

    await client.query('COMMIT');
    logger.info(messages.errors.tableCreateSuccess);
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(messages.errors.tableCreateFailed, error);
    throw error;
  } finally {
    client.release();
  }
};

const seedData = async (): Promise<void> => {
  const client = await pool.connect();

  try {
    const result = await client.query('SELECT COUNT(*) as count FROM volunteers');
    if (parseInt(result.rows[0].count) === 0) {
      logger.info(messages.errors.seedStarting);

      const volunteerInserts = [
        { name: '张伟', phone: '13800138001', email: 'zhangwei@example.com' },
        { name: '李娜', phone: '13800138002', email: 'lina@example.com' },
        { name: '王强', phone: '13800138003', email: 'wangqiang@example.com' },
        { name: '刘婷', phone: '13800138004', email: 'liuting@example.com' },
        { name: '陈明', phone: '13800138005', email: 'chenming@example.com' },
      ];

      for (const v of volunteerInserts) {
        await client.query(
          'INSERT INTO volunteers(name, phone, email) VALUES($1, $2, $3)',
          [v.name, v.phone, v.email]
        );
      }

      logger.info(messages.errors.seedCreated);
    }
  } catch (error) {
    logger.error(messages.errors.seedFailed, error);
  } finally {
    client.release();
  }
};

// 初始化服务类型权重版本，并给版本化之前产生的历史记录补齐当时权重快照。
// 仅写入快照列，不触碰 points_earned、积分、等级、徽章或信用分，因此不构成重算。
const seedServiceTypeWeights = async (): Promise<void> => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    for (const item of SERVICE_TYPE_WEIGHTS) {
      await client.query(
        `INSERT INTO service_type_weights (type, name, weight, is_active, version)
         VALUES ($1, $2, $3, true, $4)
         ON CONFLICT (type) DO NOTHING`,
        [item.type, item.name, item.weight, INITIAL_WEIGHT_VERSION]
      );
    }

    // 历史服务记录按类型的初始默认权重回填快照，version 标记为 0 表示版本化之前的记录
    for (const item of SERVICE_TYPE_WEIGHTS) {
      await client.query(
        `UPDATE service_records
         SET weight_snapshot = $1, weight_version = 0
         WHERE service_type = $2 AND weight_snapshot IS NULL`,
        [item.weight, item.type]
      );
    }

    // 旧积分明细通过关联服务记录显示当时权重，保持“旧明细仍显示当时权重”
    await client.query(
      `UPDATE points_logs
       SET weight_snapshot = sr.weight_snapshot,
           weight_version = sr.weight_version
       FROM service_records sr
       WHERE points_logs.related_type = 'service_record'
         AND points_logs.related_id = sr.id
         AND points_logs.weight_snapshot IS NULL`
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(messages.errors.seedServiceTypesFailed, error);
    throw error;
  } finally {
    client.release();
  }
};

export { createTables, seedData, seedServiceTypeWeights };

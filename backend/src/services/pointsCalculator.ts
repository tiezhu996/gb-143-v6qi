import { SERVICE_TYPE_WEIGHTS, POINTS_PER_HOUR, ServiceRecord } from '../types';

export const getServiceTypeWeight = (serviceType: string): number => {
  const typeConfig = SERVICE_TYPE_WEIGHTS.find(t => t.type === serviceType);
  return typeConfig ? typeConfig.weight : 1.0;
};

// 历史记录（权重版本功能上线前）没有快照，按当时的初始权重展示，不重算积分
export const resolveRecordWeight = (record: ServiceRecord): number => {
  const snapshot = typeof record.weight === 'string'
    ? parseFloat(record.weight)
    : record.weight;
  return typeof snapshot === 'number' && Number.isFinite(snapshot)
    ? snapshot
    : getServiceTypeWeight(record.service_type);
};

// 历史记录没有版本号，统一视作初始第 1 版
export const resolveRecordWeightVersion = (record: ServiceRecord): number => {
  return typeof record.weight_version === 'number' ? record.weight_version : 1;
};

export const calculatePoints = (
  durationHours: number,
  serviceType: string,
  rating: number,
  explicitWeight?: number
): number => {
  const weight = typeof explicitWeight === 'number'
    ? explicitWeight
    : getServiceTypeWeight(serviceType);
  const ratingBonus = (rating - 3) * 0.1;
  const basePoints = durationHours * POINTS_PER_HOUR * weight;
  const finalPoints = Math.round(basePoints * (1 + ratingBonus));
  return Math.max(1, finalPoints);
};

export const calculateNoShowPenalty = (): number => {
  return 20;
};

export const calculateComplaintPenalty = (
  complaintType: string,
  severity: number = 1
): { creditPenalty: number; pointsPenalty: number } => {
  const baseCreditPenalty: Record<string, number> = {
    'no_show': 15,
    'poor_attitude': 10,
    'violation': 20,
    'misconduct': 25,
    'other': 5,
  };

  const basePointsPenalty: Record<string, number> = {
    'no_show': 30,
    'poor_attitude': 15,
    'violation': 25,
    'misconduct': 35,
    'other': 10,
  };

  const creditPenalty = (baseCreditPenalty[complaintType] || 5) * severity;
  const pointsPenalty = (basePointsPenalty[complaintType] || 10) * severity;

  return { creditPenalty, pointsPenalty };
};

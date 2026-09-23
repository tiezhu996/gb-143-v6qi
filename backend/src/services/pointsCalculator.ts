import { SERVICE_TYPE_WEIGHTS, POINTS_PER_HOUR } from '../types';

// 仅用于离线兜底；在线服务记录必须传入从 service_type_weights 当前版本读取的权重
export const getServiceTypeWeight = (serviceType: string): number => {
  const typeConfig = SERVICE_TYPE_WEIGHTS.find(t => t.type === serviceType);
  return typeConfig ? typeConfig.weight : 1.0;
};

export const calculatePoints = (
  durationHours: number,
  serviceType: string,
  rating: number,
  weight?: number
): number => {
  // 使用提交当时的类型权重快照，保证管理员后续调整不影响本条记录
  const effectiveWeight = weight !== undefined ? weight : getServiceTypeWeight(serviceType);
  const ratingBonus = (rating - 3) * 0.1;
  const basePoints = durationHours * POINTS_PER_HOUR * effectiveWeight;
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

import { Container, YardTask, auditEvents, blocks, containers, tasks } from './domain.js';

export type ReeferStage = 'in-yard' | 'inspection' | 'at-gate' | 'on-quay' | 'in-transit';
export type AlarmLevel = 'warning' | 'critical';
export type AlarmStatus = 'open' | 'acknowledged' | 'escalated' | 'suppressed' | 'recovered';
export type PowerState = 'connected' | 'unplugged' | 'battery' | 'offline';
export type AlarmCategory = 'temperature' | 'power' | 'device-offline';

export interface ReeferSample {
  id: string; containerId: string; temperature: number; sampledAt: string; receivedAt: string;
  power: PowerState; deviceId: string; flags: string[]; clientRef?: string;
}
/** 触发告警时的原始读数快照，创建后任何操作（确认/升级/抑制）都不得修改 */
export interface AlarmReading { sampleId: string; temperature: number; power: PowerState; sampledAt: string; deviceId: string; }
export interface ReeferAlarm {
  id: string; key: string; containerId: string; stage: ReeferStage; category: AlarmCategory;
  level: AlarmLevel; status: AlarmStatus; reason: string; advice: string;
  reading: AlarmReading; openedAt: string; lastSeenAt: string; hitCount: number; suppressedHits: number;
  escalateCount: number; acknowledgedBy?: string; acknowledgedAt?: string;
  suppressedUntil?: string; suppressNote?: string; recoveredAt?: string; recoverySampleId?: string;
  dispatchTaskId?: string; handlingRecordId?: string; thresholdNote?: string; unread: boolean;
}
export interface ReeferDevice { id: string; name: string; blockId: string; lastSeenAt: string; }
export interface ThresholdRule { stage: ReeferStage; warnDelta: number; critDelta: number; updatedAt: string; updatedBy: string; }
export interface HandlingRecord { id: string; alarmId: string; containerId: string; action: string; actor: string; at: string; result: string; }
export interface SampleInput { containerId: string; temperature: number; sampledAt: string; power: PowerState; deviceId: string; clientRef?: string; }
interface Evaluation { category: AlarmCategory; level: AlarmLevel; reason: string; }

const CLOCK_SKEW_MS = 5 * 60000;       // 采样时间超前 5 分钟以上视为设备时钟漂移
const STALE_SAMPLE_MS = 30 * 60000;    // 超过 30 分钟的旧采样只归档，不参与判定
const DEVICE_OFFLINE_MS = 10 * 60000;  // 设备心跳中断 10 分钟视为离线
const RECOVERY_SKIP: AlarmStatus[] = ['suppressed', 'recovered'];

export const samples: ReeferSample[] = [];
export const alarms: ReeferAlarm[] = [];
export const handlingRecords: HandlingRecord[] = [];
export const devices: ReeferDevice[] = [
  { id: 'RDU-B07-01', name: 'B07 冷插区采集器', blockId: 'B07', lastSeenAt: new Date(Date.now() - 2 * 60000).toISOString() },
  { id: 'RDU-D05-02', name: 'D05 查验区采集器', blockId: 'D05', lastSeenAt: new Date(Date.now() - 26 * 60000).toISOString() },
  { id: 'RDU-GATE-03', name: '闸口应急车位采集器', blockId: 'C03', lastSeenAt: new Date(Date.now() - 4 * 60000).toISOString() }
];
export const thresholds: ThresholdRule[] = [
  { stage: 'in-yard', warnDelta: 3, critDelta: 5, updatedAt: new Date().toISOString(), updatedBy: 'system' },
  { stage: 'inspection', warnDelta: 2, critDelta: 4, updatedAt: new Date().toISOString(), updatedBy: 'system' },
  { stage: 'at-gate', warnDelta: 2.5, critDelta: 4.5, updatedAt: new Date().toISOString(), updatedBy: 'system' },
  { stage: 'on-quay', warnDelta: 3, critDelta: 5, updatedAt: new Date().toISOString(), updatedBy: 'system' },
  { stage: 'in-transit', warnDelta: 3.5, critDelta: 6, updatedAt: new Date().toISOString(), updatedBy: 'system' }
];

let sequence = 1;
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36).toUpperCase()}-${sequence++}`;
const levelRank = (level: AlarmLevel) => (level === 'critical' ? 2 : 1);
function audit(action: string, entityId: string, details: string) {
  auditEvents.unshift({ id: nextId('AUD'), actor: '冷藏监控中心', action, entity: 'reefer-alarm', entityId, at: new Date().toISOString(), details });
}

export function stageOf(container: Container): ReeferStage {
  if (container.customs === 'inspection' || container.customs === 'hold') return 'inspection';
  if (container.status === 'at-gate') return 'at-gate';
  if (container.status === 'on-quay') return 'on-quay';
  if (container.status === 'in-yard') return 'in-yard';
  return 'in-transit';
}
const setpointOf = (container: Container) => container.temperature ?? 4;
/** 按箱型/货物剖面收紧阈值：保鲜货（设定高于 -5°C）比冻货对温度波动更敏感 */
const cargoFactor = (container: Container) => (setpointOf(container) > -5 ? 0.8 : 1);
function effectiveDeltas(container: Container) {
  const rule = thresholds.find(item => item.stage === stageOf(container)) ?? thresholds[0];
  const factor = cargoFactor(container);
  return { warn: rule.warnDelta * factor, crit: rule.critDelta * factor };
}

export function adviceFor(stage: ReeferStage, category: AlarmCategory): string {
  if (category === 'device-offline') {
    return stage === 'inspection' || stage === 'at-gate'
      ? '遥测中断且处于高风险阶段：立即派巡检现场读温并恢复供电/通讯，恢复前按高一级处置'
      : '遥测中断：派巡检现场确认箱温与电源，恢复前每 30 分钟人工抄表';
  }
  if (category === 'power') {
    return stage === 'at-gate'
      ? '闸口排队无冷插：协调优先过闸或引导至应急冷插车位，15 分钟未缓解即升级'
      : '检查冷插供电与电缆，必要时转移箱位或接应急电源车';
  }
  switch (stage) {
    case 'inspection': return '海关查验中：先现场复核并接便携冷机/电源，确需搬移须查验科放行，禁止擅自移箱';
    case 'at-gate': return '闸口排队无冷插：协调优先过闸或引导至应急冷插车位，15 分钟未缓解即升级';
    case 'on-quay': return '船边作业：通知船方与岸桥，优先装船或接船电';
    case 'in-transit': return '箱不在场内：联系船公司/外堆场确认冷机状态并回传读数';
    default: return '派场桥转移至同区空闲冷插位，并复核设定温度与回风温度';
  }
}

export function evaluateSample(container: Container, sample: Pick<ReeferSample, 'temperature' | 'power'>): Evaluation | null {
  const stage = stageOf(container);
  const setpoint = setpointOf(container);
  const deviation = sample.temperature - setpoint;
  const abs = Math.abs(deviation);
  const { warn, crit } = effectiveDeltas(container);
  if (sample.power === 'offline') {
    const level: AlarmLevel = stage === 'inspection' || stage === 'at-gate' ? 'critical' : 'warning';
    return { category: 'device-offline', level, reason: `监测设备离线，最后读数 ${sample.temperature}°C（设定 ${setpoint}°C）` };
  }
  if (abs >= warn) {
    const level: AlarmLevel = abs >= crit ? 'critical' : 'warning';
    const powerNote = sample.power === 'battery' ? '，当前使用电池供电' : sample.power === 'unplugged' ? '，电源已断开' : '';
    return { category: 'temperature', level, reason: `温度 ${sample.temperature}°C 较设定值 ${setpoint}°C ${deviation >= 0 ? '偏高' : '偏低'} ${abs.toFixed(1)}°C${powerNote}` };
  }
  if (sample.power === 'unplugged' || sample.power === 'battery') {
    const level: AlarmLevel = sample.power === 'unplugged' && (stage === 'inspection' || stage === 'at-gate') ? 'critical' : 'warning';
    return { category: 'power', level, reason: sample.power === 'unplugged' ? '冷藏电源断开，温度暂未越限' : '冷机切换至电池供电，续航有限' };
  }
  return null;
}

function categoryNormal(container: Container, sample: ReeferSample, category: AlarmCategory): boolean {
  if (category === 'temperature') return Math.abs(sample.temperature - setpointOf(container)) < effectiveDeltas(container).warn;
  if (category === 'power') return sample.power === 'connected';
  return sample.power !== 'offline';
}

export function latestSampleFor(containerId: string) {
  const list = samples.filter(item => item.containerId === containerId);
  if (!list.length) return undefined;
  return list.reduce((a, b) => (new Date(a.sampledAt) > new Date(b.sampledAt) ? a : b));
}

function raiseOrRefresh(container: Container, sample: ReeferSample, evaluation: Evaluation): ReeferAlarm {
  const key = `${container.id}:${evaluation.category}`;
  const nowIso = new Date().toISOString();
  const existing = alarms.find(item => item.key === key && item.status !== 'recovered');
  if (existing) {
    existing.lastSeenAt = nowIso;
    if (existing.status === 'suppressed') {
      if (existing.suppressedUntil && existing.suppressedUntil > nowIso) {
        existing.suppressedHits += 1; // 抑制期内：只计数，不重复告警、不打扰值班员
        return existing;
      }
      existing.status = 'open'; // 抑制窗口过期后异常仍在 → 重新打开同一条告警
      existing.level = evaluation.level;
      existing.reason = evaluation.reason;
      existing.advice = adviceFor(stageOf(container), evaluation.category);
      existing.unread = true;
      audit('REOPEN', existing.id, '抑制窗口过期后异常仍在，告警重新打开');
      return existing;
    }
    existing.hitCount += 1;
    if (levelRank(evaluation.level) > levelRank(existing.level)) {
      existing.level = evaluation.level;
      existing.reason = evaluation.reason;
      existing.unread = true;
    }
    return existing;
  }
  const stage = stageOf(container);
  const alarm: ReeferAlarm = {
    id: nextId('ALM'), key, containerId: container.id, stage, category: evaluation.category,
    level: evaluation.level, status: 'open', reason: evaluation.reason, advice: adviceFor(stage, evaluation.category),
    reading: { sampleId: sample.id, temperature: sample.temperature, power: sample.power, sampledAt: sample.sampledAt, deviceId: sample.deviceId },
    openedAt: nowIso, lastSeenAt: nowIso, hitCount: 1, suppressedHits: 0, escalateCount: 0, unread: true
  };
  alarms.unshift(alarm);
  audit('OPEN', alarm.id, `${container.id} ${evaluation.reason}`);
  return alarm;
}

function recoverWithSample(alarm: ReeferAlarm, sample: ReeferSample) {
  alarm.status = 'recovered';
  alarm.recoveredAt = new Date().toISOString();
  alarm.recoverySampleId = sample.id;
  alarm.unread = true; // 恢复也是值班员需要知悉的事件
  if (alarm.dispatchTaskId) {
    const task = tasks.find(item => item.id === alarm.dispatchTaskId);
    if (task && task.status !== 'done' && task.status !== 'executing') {
      task.status = 'done';
      audit('AUTO_CLOSE', task.id, `告警 ${alarm.id} 恢复正常，处置任务自动闭环`);
    }
  }
  audit('RECOVER', alarm.id, `采样 ${sample.id} 恢复正常，告警闭环`);
}

export function ingestSample(input: SampleInput) {
  const containerId = String(input.containerId ?? '').trim().toUpperCase();
  const container = containers.find(item => item.id === containerId);
  if (!container) throw new Error(`箱号 ${containerId || '(空)'} 不存在`);
  if (!container.reefer) throw new Error(`箱 ${containerId} 非冷藏箱，不纳入冷藏监控`);
  const temperature = Number(input.temperature);
  if (!Number.isFinite(temperature) || temperature < -60 || temperature > 60) throw new Error('温度读数超出合理范围 (-60 ~ 60°C)');
  const sampledAt = new Date(input.sampledAt);
  if (Number.isNaN(sampledAt.getTime())) throw new Error('采样时间格式无效');
  const device = devices.find(item => item.id === input.deviceId);
  if (!device) throw new Error(`来源设备 ${input.deviceId} 未登记`);
  if (!['connected', 'unplugged', 'battery', 'offline'].includes(input.power)) throw new Error('电源状态无效');

  // 重复采样幂等：同箱同设备同采样时刻（或同客户端引用）只保留第一条
  const existing = samples.find(item => item.containerId === containerId && item.deviceId === device.id && item.sampledAt === sampledAt.toISOString())
    ?? (input.clientRef ? samples.find(item => item.clientRef === input.clientRef) : undefined);
  if (existing) return { sample: existing, duplicate: true, evaluation: null as Evaluation | null, alarms: [] as ReeferAlarm[] };

  const now = new Date();
  const flags: string[] = [];
  const skewMs = sampledAt.getTime() - now.getTime();
  if (skewMs > CLOCK_SKEW_MS) flags.push('clock-drift');
  if (-skewMs > STALE_SAMPLE_MS) flags.push('stale-sample');
  const sample: ReeferSample = {
    id: nextId('SMP'), containerId, temperature, sampledAt: sampledAt.toISOString(), receivedAt: now.toISOString(),
    power: input.power, deviceId: device.id, flags, ...(input.clientRef ? { clientRef: input.clientRef } : {})
  };
  samples.unshift(sample);
  device.lastSeenAt = now.toISOString();
  if (flags.includes('clock-drift')) audit('CLOCK_DRIFT', containerId, `设备 ${device.id} 采样时间超前 ${Math.round(skewMs / 60000)} 分钟，已标记时钟漂移`);
  if (flags.includes('stale-sample')) return { sample, duplicate: false, evaluation: null, alarms: [] as ReeferAlarm[] }; // 过期采样只归档

  const evaluation = evaluateSample(container, sample);
  const touched: ReeferAlarm[] = [];
  if (evaluation) touched.push(raiseOrRefresh(container, sample, evaluation));
  // 正常采样驱动恢复闭环；抑制中的告警需人工确认闭环，不自动恢复
  for (const alarm of alarms.filter(item => item.containerId === containerId && !RECOVERY_SKIP.includes(item.status))) {
    if (evaluation && alarm.category === evaluation.category) continue;
    const normal = alarm.category === 'device-offline'
      ? sample.deviceId === alarm.reading.deviceId && sample.power !== 'offline'
      : categoryNormal(container, sample, alarm.category);
    if (normal) { recoverWithSample(alarm, sample); touched.push(alarm); }
  }
  for (const alarm of alarms.filter(item => item.containerId === containerId && item.status === 'suppressed')) {
    if (categoryNormal(container, sample, alarm.category)) alarm.unread = true; // 提示值班员：抑制中的告警已可确认闭环
  }
  return { sample, duplicate: false, evaluation, alarms: touched };
}

export function acknowledgeAlarm(id: string, actor = '值班员') {
  const alarm = alarms.find(item => item.id === id);
  if (!alarm) return undefined;
  if (alarm.status === 'recovered') throw new Error('告警已恢复闭环，无需确认');
  // 确认只记录操作人与时间，原始读数 reading 保持不变
  if (alarm.status !== 'suppressed') alarm.status = 'acknowledged';
  alarm.acknowledgedBy = actor;
  alarm.acknowledgedAt = new Date().toISOString();
  alarm.unread = false;
  audit('ACK', alarm.id, `${actor} 确认告警（原始读数保持不变）`);
  return alarm;
}

export function escalateAlarm(id: string, actor = '值班员') {
  const alarm = alarms.find(item => item.id === id);
  if (!alarm) return undefined;
  if (alarm.status === 'recovered') throw new Error('告警已恢复闭环，不能升级');
  alarm.level = 'critical';
  alarm.status = 'escalated';
  alarm.escalateCount += 1;
  alarm.unread = true;
  audit('ESCALATE', alarm.id, `${actor} 第 ${alarm.escalateCount} 次升级，级别提升为 critical`);
  return alarm;
}

export function suppressAlarm(id: string, minutes = 30, actor = '值班员', note = '') {
  const alarm = alarms.find(item => item.id === id);
  if (!alarm) return undefined;
  if (alarm.status === 'recovered') throw new Error('告警已恢复闭环，无需抑制');
  const mins = Number(minutes);
  if (!Number.isFinite(mins) || mins < 5 || mins > 240) throw new Error('抑制时长需在 5–240 分钟之间');
  alarm.status = 'suppressed';
  alarm.suppressedUntil = new Date(Date.now() + mins * 60000).toISOString();
  alarm.suppressNote = note || '重复告警抑制';
  alarm.acknowledgedBy = alarm.acknowledgedBy ?? actor;
  alarm.acknowledgedAt = alarm.acknowledgedAt ?? new Date().toISOString();
  alarm.unread = false;
  audit('SUPPRESS', alarm.id, `${actor} 抑制 ${mins} 分钟：${alarm.suppressNote}`);
  return alarm;
}

export function recoverAlarm(id: string, actor = '值班员') {
  const alarm = alarms.find(item => item.id === id);
  if (!alarm) return undefined;
  if (alarm.status === 'recovered') throw new Error('告警已恢复闭环');
  const container = containers.find(item => item.id === alarm.containerId);
  if (!container) throw new Error('关联箱不存在');
  const latest = latestSampleFor(alarm.containerId);
  if (!latest || new Date(latest.sampledAt).getTime() <= new Date(alarm.reading.sampledAt).getTime()) {
    throw new Error('恢复闭环需要一条晚于触发读数的新采样');
  }
  if (latest.flags.includes('stale-sample')) throw new Error('最新采样已过期，不能用于恢复闭环');
  const normal = alarm.category === 'device-offline'
    ? latest.deviceId === alarm.reading.deviceId && latest.power !== 'offline'
    : categoryNormal(container, latest, alarm.category);
  if (!normal) throw new Error('最新采样仍未恢复正常，暂不能闭环');
  recoverWithSample(alarm, latest);
  audit('RECOVER_CONFIRM', alarm.id, `${actor} 依据采样 ${latest.id} 确认恢复`);
  return alarm;
}

export function markAlarmRead(id: string) {
  const alarm = alarms.find(item => item.id === id);
  if (!alarm) return undefined;
  alarm.unread = false;
  return alarm;
}
export function markAllAlarmsRead() {
  alarms.forEach(item => { item.unread = false; });
  return { cleared: true };
}

export function dispatchAlarm(id: string, mode: 'task' | 'manual', actor = '值班员', action?: string) {
  const alarm = alarms.find(item => item.id === id);
  if (!alarm) return undefined;
  if (alarm.status === 'recovered') throw new Error('告警已恢复闭环，无需处置');
  if (alarm.status === 'suppressed') throw new Error('告警处于抑制期，请先确认恢复或等待抑制结束再处置');
  const container = containers.find(item => item.id === alarm.containerId);
  if (!container) throw new Error('关联箱不存在');
  if (mode === 'task') {
    if (alarm.dispatchTaskId && tasks.some(item => item.id === alarm.dispatchTaskId && item.status !== 'done')) {
      throw new Error(`该告警已派出处置任务 ${alarm.dispatchTaskId}，请勿重复派单`);
    }
    const busy = alarms.find(item => item.id !== alarm.id && item.containerId === alarm.containerId && item.status !== 'recovered'
      && item.dispatchTaskId && tasks.some(task => task.id === item.dispatchTaskId && task.status !== 'done'));
    if (busy) throw new Error(`箱 ${alarm.containerId} 已有进行中的处置任务 ${busy.dispatchTaskId}，避免一条异常重复搬运`);
    const target = blocks.filter(block => block.reeferPlugs > block.usedPlugs).sort((a, b) => a.heat - b.heat)[0];
    const task: YardTask = {
      id: nextId('TASK'), kind: 'rehandle', containerId: alarm.containerId, from: container.yardSlot,
      to: target ? `${target.id} 应急冷插位` : '现场应急接电', priority: alarm.level === 'critical' ? 95 : 88,
      status: 'queued', scheduledAt: new Date().toISOString(), blockingReasons: [], estimatedMinutes: 25, originAlarmId: alarm.id
    };
    tasks.unshift(task);
    alarm.dispatchTaskId = task.id;
    alarm.unread = false;
    audit('DISPATCH', alarm.id, `${actor} 将告警转为场内任务 ${task.id}（${task.from} → ${task.to}）`);
    return { alarm, task };
  }
  const record: HandlingRecord = {
    id: nextId('HND'), alarmId: alarm.id, containerId: alarm.containerId,
    action: action?.trim() || alarm.advice, actor, at: new Date().toISOString(), result: '跟进中'
  };
  handlingRecords.unshift(record);
  alarm.handlingRecordId = record.id;
  alarm.unread = false;
  audit('MANUAL_HANDLING', alarm.id, `${actor} 登记人工处置：${record.action}`);
  return { alarm, record };
}

export function updateThreshold(stage: ReeferStage, patch: { warnDelta?: number; critDelta?: number }, actor = '值班员') {
  const rule = thresholds.find(item => item.stage === stage);
  if (!rule) return undefined;
  const warnDelta = patch.warnDelta ?? rule.warnDelta;
  const critDelta = patch.critDelta ?? rule.critDelta;
  if (!(warnDelta > 0) || !(critDelta > warnDelta)) throw new Error('阈值需满足 0 < 告警偏差 < 严重偏差');
  rule.warnDelta = warnDelta;
  rule.critDelta = critDelta;
  rule.updatedAt = new Date().toISOString();
  rule.updatedBy = actor;
  // 阈值变更后立即重估活跃告警：只调整级别与提示，不代替新采样自动闭环
  let reevaluated = 0;
  for (const alarm of alarms.filter(item => item.status !== 'recovered' && item.category === 'temperature')) {
    const container = containers.find(item => item.id === alarm.containerId);
    const latest = container && latestSampleFor(alarm.containerId);
    if (!container || !latest) continue;
    reevaluated += 1;
    const abs = Math.abs(latest.temperature - setpointOf(container));
    const { warn, crit } = effectiveDeltas(container);
    const next: AlarmLevel | null = abs >= crit ? 'critical' : abs >= warn ? 'warning' : null;
    if (!next) {
      alarm.thresholdNote = '阈值调整后最新读数已回落到限值内，等待下一条正常采样闭环';
      alarm.unread = true;
    } else if (next !== alarm.level) {
      alarm.level = next;
      alarm.thresholdNote = `阈值调整后级别重估为 ${next}`;
      alarm.unread = true;
    } else {
      alarm.thresholdNote = undefined;
    }
  }
  audit('THRESHOLD', stage, `${actor} 调整 ${stage} 阈值为 ±${warnDelta}/±${critDelta}°C，重估 ${reevaluated} 条活跃告警`);
  return { rule, reevaluated };
}

/** 心跳超时的采集设备 → 为其区块内的冷藏箱打开设备离线告警（幂等） */
export function sweepOfflineDevices() {
  const now = Date.now();
  const opened: ReeferAlarm[] = [];
  for (const device of devices) {
    if (now - new Date(device.lastSeenAt).getTime() <= DEVICE_OFFLINE_MS) continue;
    for (const container of containers.filter(item => item.reefer && item.yardSlot.startsWith(device.blockId))) {
      const key = `${container.id}:device-offline`;
      if (alarms.some(item => item.key === key && item.status !== 'recovered')) continue;
      const stage = stageOf(container);
      const last = samples.find(item => item.deviceId === device.id && item.containerId === container.id);
      const alarm: ReeferAlarm = {
        id: nextId('ALM'), key, containerId: container.id, stage, category: 'device-offline',
        level: stage === 'inspection' || stage === 'at-gate' ? 'critical' : 'warning', status: 'open',
        reason: `监测设备 ${device.name} 心跳中断超过 ${Math.round(DEVICE_OFFLINE_MS / 60000)} 分钟，箱温遥测不可用`,
        advice: adviceFor(stage, 'device-offline'),
        reading: { sampleId: last?.id ?? '', temperature: last?.temperature ?? container.temperature ?? 0, power: 'offline', sampledAt: device.lastSeenAt, deviceId: device.id },
        openedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), hitCount: 1, suppressedHits: 0, escalateCount: 0, unread: true
      };
      alarms.unshift(alarm);
      opened.push(alarm);
      audit('OPEN', alarm.id, alarm.reason);
    }
  }
  return opened;
}

export function reeferOverview() {
  sweepOfflineDevices();
  const now = Date.now();
  return {
    alarms: [...alarms].sort((a, b) =>
      (a.status === 'recovered' ? 1 : 0) - (b.status === 'recovered' ? 1 : 0)
      || levelRank(b.level) - levelRank(a.level) || b.openedAt.localeCompare(a.openedAt)),
    unreadCount: alarms.filter(item => item.unread).length,
    activeCount: alarms.filter(item => item.status !== 'recovered').length,
    suppressedCount: alarms.filter(item => item.status === 'suppressed').length,
    devices: devices.map(device => ({ ...device, offline: now - new Date(device.lastSeenAt).getTime() > DEVICE_OFFLINE_MS })),
    thresholds,
    handlingRecords,
    monitors: containers.filter(item => item.reefer).map(container => ({
      container, stage: stageOf(container), setpoint: setpointOf(container), latest: latestSampleFor(container.id)
    })),
    sampleCount: samples.length
  };
}

// 种子遥测：EISU 正常；TEMU 查验中温度越限 + 电池供电；D05 采集器心跳中断
ingestSample({ containerId: 'EISU-1288420', temperature: -17.6, sampledAt: new Date(Date.now() - 4 * 60000).toISOString(), power: 'connected', deviceId: 'RDU-B07-01' });
ingestSample({ containerId: 'TEMU-1774029', temperature: 8.6, sampledAt: new Date(Date.now() - 6 * 60000).toISOString(), power: 'battery', deviceId: 'RDU-D05-02' });
const seededOffline = devices.find(item => item.id === 'RDU-D05-02');
if (seededOffline) seededOffline.lastSeenAt = new Date(Date.now() - 26 * 60000).toISOString();

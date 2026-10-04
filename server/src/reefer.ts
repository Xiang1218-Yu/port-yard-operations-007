import { auditEvents, containers, tasks, Container, YardTask } from './domain.js';

export type PowerState = 'mains' | 'battery' | 'offline';
export type AlertLevel = 'warning' | 'critical';
export type AlertStatus = 'open' | 'acknowledged' | 'escalated' | 'suppressed' | 'resolved';
export type WorkStage = 'inspection' | 'gate-wait' | 'quay-ops' | 'yard-storage' | 'in-transit';
export type SampleStatus = 'accepted' | 'duplicate' | 'stale';

export interface ReeferSample {
  id: string; containerId: string; temperature: number; sampledAt: string; receivedAt: string;
  power: PowerState; sourceDevice: string; status: SampleStatus; clockDrift: boolean; flags: string[];
}
export interface ThresholdProfile { id: string; label: string; match: 'frozen' | 'chilled'; setpoint: number; min: number; max: number; updatedAt: string; }
export interface AlertEvent { at: string; actor: string; action: string; note?: string; }
export interface ReeferAlert {
  id: string; containerId: string; cause: 'temperature' | 'power'; level: AlertLevel; status: AlertStatus;
  stage: WorkStage; advice: string; openedAt: string; updatedAt: string;
  triggeringSampleId: string; triggeringTemperature: number; thresholdMin: number; thresholdMax: number;
  lastAbnormalAt: string; occurrences: number; suppressedOccurrences: number;
  acknowledgedBy?: string; acknowledgedAt?: string; escalatedBy?: string; escalatedAt?: string;
  suppressedBy?: string; suppressReason?: string; resolvedAt?: string; resolvedBySampleId?: string;
  linkedTaskId?: string; history: AlertEvent[];
}
export interface HandlingRecord { id: string; alertId: string; containerId: string; kind: 'yard-task' | 'manual'; summary: string; actor: string; at: string; taskId?: string; }

const now = () => new Date();
const iso = (date: Date) => date.toISOString();
const CLOCK_DRIFT_FUTURE_MS = 5 * 60000;
const CLOCK_DRIFT_PAST_MS = 12 * 3600000;
const DUPLICATE_WINDOW_MS = 60000;

export const thresholds: ThresholdProfile[] = [
  { id: 'TH-FROZEN', label: '冷冻箱（设定 ≤ -10°C）', match: 'frozen', setpoint: -18, min: -22, max: -12, updatedAt: iso(now()) },
  { id: 'TH-CHILLED', label: '冷藏箱（设定 > -10°C）', match: 'chilled', setpoint: 4, min: -2, max: 8, updatedAt: iso(now()) }
];
export const samples: ReeferSample[] = [];
export const alerts: ReeferAlert[] = [];
export const handlingRecords: HandlingRecord[] = [];

let sequence = 1;
const nextId = (prefix: string) => `${prefix}-${String(sequence++).padStart(4, '0')}-${Date.now().toString(36)}`;

function recordAudit(action: string, entityId: string, details: string) {
  auditEvents.unshift({ id: `AUD-${Date.now()}-${sequence}`, actor: '冷藏值班员', action, entity: 'reefer-alert', entityId, at: iso(now()), details });
}

export function profileFor(container: Container): ThresholdProfile {
  const target = container.temperature ?? 4;
  const match = target <= -10 ? 'frozen' : 'chilled';
  return thresholds.find(item => item.match === match) ?? thresholds[0];
}

export function workStageOf(container: Container): WorkStage {
  if (container.customs === 'inspection' || container.status === 'hold') return 'inspection';
  if (container.status === 'at-gate') return 'gate-wait';
  if (container.status === 'on-quay') return 'quay-ops';
  if (container.status === 'in-transit') return 'in-transit';
  return 'yard-storage';
}

export function adviceFor(stage: WorkStage, cause: 'temperature' | 'power'): string {
  const powerNote = cause === 'power' ? '机组电源离线，先恢复供电或改接备用冷插，' : '';
  if (stage === 'inspection') return `${powerNote}箱子处于海关查验：暂停开箱作业，通知查验组与海关现场代表，安排人员到场人工测温复核，未经查验组确认不得移箱。`;
  if (stage === 'gate-wait') return `${powerNote}箱子正在闸口等待：暂缓放行/进场流程，引导车辆至冷藏应急缓冲区，闸口员现场确认机组读数后再决定是否入闸。`;
  if (stage === 'quay-ops') return `${powerNote}箱子在岸桥作业面：通知船边调度暂停吊装，优先转运至最近冷藏插座区并复核设定温度。`;
  if (stage === 'in-transit') return `${powerNote}箱子在途：联系承运方核对机组状态，到场后优先安排冷藏位。`;
  return `${powerNote}箱子在堆场堆存：派场桥/集卡优先翻箱至备用冷插位，并安排人工现场测温复核。`;
}

function levelFor(deviation: number, stage: WorkStage): AlertLevel {
  let level: AlertLevel = deviation > 2 ? 'critical' : 'warning';
  if ((stage === 'inspection' || stage === 'gate-wait') && level === 'warning') level = 'critical';
  return level;
}

function deviationOf(temperature: number, profile: ThresholdProfile) {
  if (temperature > profile.max) return temperature - profile.max;
  if (temperature < profile.min) return profile.min - temperature;
  return 0;
}

export function activeAlertFor(containerId: string) {
  return alerts.find(alert => alert.containerId === containerId && alert.status !== 'resolved');
}

export interface SampleInput { containerId: string; temperature: number; sampledAt: string; power: PowerState; sourceDevice: string; }

export function ingestSample(input: SampleInput) {
  const container = containers.find(item => item.id === input.containerId);
  if (!container) throw new Error(`箱号 ${input.containerId} 不存在`);
  if (!container.reefer) throw new Error(`箱号 ${input.containerId} 不是冷藏箱，无法接入温度采样`);
  if (!['mains', 'battery', 'offline'].includes(input.power)) throw new Error('电源状态必须是 mains / battery / offline');
  const sampledAt = new Date(input.sampledAt);
  if (Number.isNaN(sampledAt.getTime())) throw new Error('采样时间格式无效');
  if (!input.sourceDevice?.trim()) throw new Error('来源设备不能为空');

  const received = now();
  const flags: string[] = [];
  const driftMs = sampledAt.getTime() - received.getTime();
  const clockDrift = driftMs > CLOCK_DRIFT_FUTURE_MS || driftMs < -CLOCK_DRIFT_PAST_MS;
  if (driftMs > CLOCK_DRIFT_FUTURE_MS) flags.push('采样时间超前，来源设备疑似时钟漂移');
  if (driftMs < -CLOCK_DRIFT_PAST_MS) flags.push('采样时间严重滞后，请核查设备时钟');

  const containerSamples = samples.filter(item => item.containerId === container.id);
  const duplicate = containerSamples.find(item => item.sourceDevice === input.sourceDevice && Math.abs(new Date(item.sampledAt).getTime() - sampledAt.getTime()) < DUPLICATE_WINDOW_MS);
  const latestAccepted = containerSamples.filter(item => item.status === 'accepted').sort((a, b) => new Date(b.sampledAt).getTime() - new Date(a.sampledAt).getTime())[0];
  const stale = !duplicate && latestAccepted !== undefined && sampledAt.getTime() < new Date(latestAccepted.sampledAt).getTime();
  if (stale) flags.push('乱序采样：早于已接受的最新读数，不参与告警判定');

  const sample: ReeferSample = {
    id: nextId('SMP'), containerId: container.id, temperature: input.temperature, sampledAt: iso(sampledAt), receivedAt: iso(received),
    power: input.power, sourceDevice: input.sourceDevice.trim(), status: duplicate ? 'duplicate' : stale ? 'stale' : 'accepted', clockDrift, flags
  };
  if (duplicate) sample.flags.push('重复采样：同设备同时间窗已存在读数，已抑制');
  samples.unshift(sample);
  if (sample.status !== 'accepted') return { sample, alert: activeAlertFor(container.id) };

  container.temperature = input.temperature;
  container.lastEvent = `温度回传 ${input.temperature}°C · ${received.toLocaleTimeString()}`;

  const profile = profileFor(container);
  const stage = workStageOf(container);
  const powerAbnormal = input.power === 'offline';
  const deviation = deviationOf(input.temperature, profile);
  const abnormal = powerAbnormal || deviation > 0;
  let alert = activeAlertFor(container.id);

  if (abnormal) {
    const cause = powerAbnormal ? 'power' : 'temperature';
    const level = powerAbnormal ? (stage === 'inspection' || stage === 'gate-wait' ? 'critical' : 'warning') : levelFor(deviation, stage);
    if (alert) {
      alert.occurrences += 1;
      alert.lastAbnormalAt = sample.sampledAt;
      alert.updatedAt = iso(received);
      alert.stage = stage;
      alert.advice = adviceFor(stage, alert.cause);
      if (alert.status === 'suppressed') {
        alert.suppressedOccurrences += 1;
        const worsened = cause === 'temperature' && alert.cause === 'temperature' && input.temperature - alert.triggeringTemperature > 2;
        const powerLost = cause === 'power' && alert.cause === 'temperature';
        if (worsened || powerLost) {
          alert.status = 'open';
          alert.cause = cause;
          alert.advice = adviceFor(stage, cause);
          alert.history.push({ at: iso(received), actor: '系统', action: 'REOPEN', note: worsened ? '抑制期间温度继续恶化，自动重新打开' : '抑制期间机组电源离线，自动重新打开' });
        }
      } else if (level === 'critical' && alert.level === 'warning') {
        alert.level = 'critical';
        alert.history.push({ at: iso(received), actor: '系统', action: 'LEVEL_UP', note: '偏差扩大或进入敏感作业阶段，级别提升为 critical' });
      }
    } else {
      alert = {
        id: nextId('ALR'), containerId: container.id, cause, level, status: 'open', stage, advice: adviceFor(stage, cause),
        openedAt: iso(received), updatedAt: iso(received), triggeringSampleId: sample.id, triggeringTemperature: input.temperature,
        thresholdMin: profile.min, thresholdMax: profile.max, lastAbnormalAt: sample.sampledAt, occurrences: 1, suppressedOccurrences: 0,
        history: [{ at: iso(received), actor: '系统', action: 'OPEN', note: `采样 ${input.temperature}°C 超出阈值 [${profile.min}, ${profile.max}] 或电源异常` }]
      };
      alerts.unshift(alert);
      recordAudit('ALERT_OPEN', alert.id, `${container.id} 触发 ${alert.level} 告警（${cause}）`);
    }
  }
  return { sample, alert };
}

function mustAlert(id: string) {
  const alert = alerts.find(item => item.id === id);
  if (!alert) throw new Error('告警不存在');
  return alert;
}
function touch(alert: ReeferAlert, actor: string, action: string, note?: string) {
  alert.updatedAt = iso(now());
  alert.history.push({ at: iso(now()), actor, action, ...(note ? { note } : {}) });
}

export function acknowledgeAlert(id: string, actor = '冷藏值班员') {
  const alert = mustAlert(id);
  if (alert.status === 'resolved') throw new Error('告警已恢复闭环，不能重复确认');
  if (alert.status !== 'open' && alert.status !== 'escalated') throw new Error(`当前状态 ${alert.status} 不能确认`);
  alert.status = 'acknowledged';
  alert.acknowledgedBy = actor;
  alert.acknowledgedAt = iso(now());
  touch(alert, actor, 'ACK', '确认告警；原始读数保持不变，仅记录处置轨迹');
  recordAudit('ALERT_ACK', id, `${alert.containerId} 告警已确认`);
  return alert;
}

export function escalateAlert(id: string, actor = '冷藏值班员') {
  const alert = mustAlert(id);
  if (alert.status === 'resolved') throw new Error('告警已恢复，不能升级');
  if (alert.level === 'critical' && alert.status === 'escalated') throw new Error('告警已是最高级别');
  alert.level = 'critical';
  alert.status = 'escalated';
  alert.escalatedBy = actor;
  alert.escalatedAt = iso(now());
  touch(alert, actor, 'ESCALATE', '人工升级为 critical，需值班经理跟进');
  recordAudit('ALERT_ESCALATE', id, `${alert.containerId} 告警升级`);
  return alert;
}

export function suppressAlert(id: string, actor = '冷藏值班员', reason = '') {
  const alert = mustAlert(id);
  if (alert.status === 'resolved') throw new Error('告警已恢复，不能抑制');
  if (alert.status === 'suppressed') throw new Error('告警已处于抑制状态');
  if (!reason.trim()) throw new Error('抑制必须填写原因（如：已知除霜周期）');
  alert.status = 'suppressed';
  alert.suppressedBy = actor;
  alert.suppressReason = reason.trim();
  touch(alert, actor, 'SUPPRESS', reason.trim());
  recordAudit('ALERT_SUPPRESS', id, `${alert.containerId} 告警抑制：${reason.trim()}`);
  return alert;
}

export function resolveAlert(id: string, actor = '冷藏值班员') {
  const alert = mustAlert(id);
  if (alert.status === 'resolved') throw new Error('告警已恢复闭环');
  const container = containers.find(item => item.id === alert.containerId);
  if (!container) throw new Error('关联箱号不存在');
  const profile = profileFor(container);
  const latest = samples
    .filter(item => item.containerId === alert.containerId && item.status === 'accepted')
    .sort((a, b) => new Date(b.sampledAt).getTime() - new Date(a.sampledAt).getTime())[0];
  if (!latest) throw new Error('恢复闭环需要一条晚于最近异常的新正常采样');
  if (latest.power === 'offline' || deviationOf(latest.temperature, profile) > 0) {
    throw new Error(`最新采样 ${latest.temperature}°C 仍未回到阈值 [${profile.min}, ${profile.max}] 内或电源离线，不能恢复`);
  }
  if (new Date(latest.sampledAt).getTime() <= new Date(alert.lastAbnormalAt).getTime()) {
    throw new Error('恢复闭环需要一条晚于最近异常的新正常采样');
  }
  alert.status = 'resolved';
  alert.resolvedAt = iso(now());
  alert.resolvedBySampleId = latest.id;
  touch(alert, actor, 'RESOLVE', `依据正常采样 ${latest.id}（${latest.temperature}°C）恢复闭环`);
  recordAudit('ALERT_RESOLVE', id, `${alert.containerId} 告警恢复闭环`);
  return alert;
}

export function dispatchAlert(id: string, mode: 'task' | 'manual', actor = '冷藏值班员', note = '') {
  const alert = mustAlert(id);
  if (alert.status === 'resolved') throw new Error('告警已恢复，无需派工');
  if (alert.level !== 'critical') throw new Error('仅 critical 级别告警可转为场内任务或人工处置');
  const container = containers.find(item => item.id === alert.containerId);
  if (!container) throw new Error('关联箱号不存在');

  if (mode === 'task') {
    const existing = alert.linkedTaskId
      ? tasks.find(task => task.id === alert.linkedTaskId && task.status !== 'done')
      : tasks.find(task => task.sourceAlertId === alert.id && task.status !== 'done');
    if (existing) {
      return { alert, record: handlingRecords.find(item => item.taskId === existing.id), task: existing, deduplicated: true };
    }
    const task: YardTask = {
      id: `TASK-${Date.now()}-${sequence++}`, kind: 'rehandle', containerId: container.id, from: container.yardSlot,
      to: alert.stage === 'gate-wait' ? '闸口冷藏应急缓冲区' : 'D05 冷藏应急查验区', priority: 95, status: 'queued',
      scheduledAt: iso(now()), blockingReasons: [], estimatedMinutes: 25, sourceAlertId: alert.id
    };
    tasks.unshift(task);
    alert.linkedTaskId = task.id;
    const record: HandlingRecord = { id: nextId('HND'), alertId: alert.id, containerId: container.id, kind: 'yard-task', summary: `生成优先搬运任务 ${task.id}：${task.from} → ${task.to}`, actor, at: iso(now()), taskId: task.id };
    handlingRecords.unshift(record);
    touch(alert, actor, 'DISPATCH_TASK', record.summary);
    recordAudit('ALERT_DISPATCH', id, record.summary);
    return { alert, record, task, deduplicated: false };
  }

  if (!note.trim()) throw new Error('人工处置必须填写处置说明');
  const record: HandlingRecord = { id: nextId('HND'), alertId: alert.id, containerId: container.id, kind: 'manual', summary: note.trim(), actor, at: iso(now()) };
  handlingRecords.unshift(record);
  touch(alert, actor, 'MANUAL_HANDLING', note.trim());
  recordAudit('ALERT_MANUAL', id, `${alert.containerId} 人工处置：${note.trim()}`);
  return { alert, record, deduplicated: false };
}

export function updateThresholds(id: string, patch: Partial<Pick<ThresholdProfile, 'min' | 'max' | 'setpoint'>>) {
  const profile = thresholds.find(item => item.id === id);
  if (!profile) throw new Error('阈值档案不存在');
  const next = { ...profile, ...patch };
  if (next.min >= next.max) throw new Error('阈值下限必须小于上限');
  if (next.setpoint < next.min || next.setpoint > next.max) throw new Error('设定温度必须位于阈值区间内');
  Object.assign(profile, patch, { updatedAt: iso(now()) });
  recordAudit('THRESHOLD_UPDATE', id, `阈值变更为 [${profile.min}, ${profile.max}]，设定 ${profile.setpoint}°C；已开告警保持原阈值快照`);
  return profile;
}

export function reeferOverview() {
  const active = alerts.filter(alert => alert.status !== 'resolved');
  return {
    alerts: [...alerts].sort((a, b) => (a.status === 'resolved' ? 1 : 0) - (b.status === 'resolved' ? 1 : 0) || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    samples: samples.slice(0, 30),
    thresholds,
    handlingRecords: handlingRecords.slice(0, 20),
    counts: {
      active: active.length,
      critical: active.filter(alert => alert.level === 'critical').length,
      suppressed: active.filter(alert => alert.status === 'suppressed').length,
      duplicates: samples.filter(sample => sample.status === 'duplicate').length,
      clockDrift: samples.filter(sample => sample.clockDrift).length
    }
  };
}

export function seedReeferData() {
  if (samples.length) return;
  const base = Date.now();
  const at = (minutes: number) => new Date(base + minutes * 60000).toISOString();
  ingestSample({ containerId: 'EISU-1288420', temperature: -18.2, sampledAt: at(-40), power: 'mains', sourceDevice: 'RTG-B07-P3' });
  ingestSample({ containerId: 'TEMU-1774029', temperature: 6.1, sampledAt: at(-32), power: 'mains', sourceDevice: 'D05-PLUG-04' });
  ingestSample({ containerId: 'TEMU-1774029', temperature: 9.6, sampledAt: at(-18), power: 'battery', sourceDevice: 'D05-PLUG-04' });
  ingestSample({ containerId: 'TEMU-1774029', temperature: 9.6, sampledAt: at(-18), power: 'battery', sourceDevice: 'D05-PLUG-04' });
  ingestSample({ containerId: 'EISU-1288420', temperature: -17.8, sampledAt: at(-10), power: 'mains', sourceDevice: 'RTG-B07-P3' });
}

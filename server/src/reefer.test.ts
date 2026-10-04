import test from 'node:test'; import assert from 'node:assert/strict';
import { containers, createContainer, tasks } from './domain.js';
import { acknowledgeAlert, activeAlertFor, alerts, dispatchAlert, escalateAlert, ingestSample, resolveAlert, samples, suppressAlert, thresholds, updateThresholds } from './reefer.js';

let tick = 0;
const nextSampleTime = () => new Date(Date.now() - 3600000 + (tick++) * 61000).toISOString();

test('ingest judges alert level by container type and work stage', () => {
  const inspection = ingestSample({ containerId: 'TEMU-1774029', temperature: 9.5, sampledAt: nextSampleTime(), power: 'mains', sourceDevice: 'D05-PLUG-04' });
  assert.equal(inspection.alert?.level, 'critical');
  assert.equal(inspection.alert?.cause, 'temperature');
  assert.equal(inspection.alert?.stage, 'inspection');
  assert.ok(inspection.alert?.advice.includes('海关查验'));
  const yard = ingestSample({ containerId: 'EISU-1288420', temperature: -10, sampledAt: nextSampleTime(), power: 'mains', sourceDevice: 'RTG-B07-P3' });
  assert.equal(yard.alert?.level, 'warning');
  assert.equal(yard.alert?.stage, 'yard-storage');
  assert.ok(yard.alert?.advice.includes('堆场'));
});

test('duplicate and out-of-order samples are sidelined without touching alerts', () => {
  const before = activeAlertFor('TEMU-1774029')?.occurrences ?? 0;
  const at = new Date(Date.now() - 3600000).toISOString();
  ingestSample({ containerId: 'TEMU-1774029', temperature: 9.5, sampledAt: at, power: 'mains', sourceDevice: 'D05-PLUG-04' });
  const dup = ingestSample({ containerId: 'TEMU-1774029', temperature: 9.5, sampledAt: at, power: 'mains', sourceDevice: 'D05-PLUG-04' });
  assert.equal(dup.sample.status, 'duplicate');
  const stale = ingestSample({ containerId: 'TEMU-1774029', temperature: 11, sampledAt: new Date(Date.now() - 7200000).toISOString(), power: 'mains', sourceDevice: 'D05-PLUG-04' });
  assert.equal(stale.sample.status, 'stale');
  assert.equal(activeAlertFor('TEMU-1774029')?.occurrences, before);
});

test('acknowledge never mutates the original readings', () => {
  const alert = activeAlertFor('TEMU-1774029');
  assert.ok(alert);
  const sample = samples.find(item => item.id === alert.triggeringSampleId);
  const snapshot = { temperature: sample?.temperature, sampledAt: sample?.sampledAt, triggering: alert.triggeringTemperature, min: alert.thresholdMin, max: alert.thresholdMax };
  const acknowledged = acknowledgeAlert(alert.id, '测试值班员');
  assert.equal(acknowledged.status, 'acknowledged');
  assert.equal(acknowledged.acknowledgedBy, '测试值班员');
  assert.equal(sample?.temperature, snapshot.temperature);
  assert.equal(sample?.sampledAt, snapshot.sampledAt);
  assert.equal(acknowledged.triggeringTemperature, snapshot.triggering);
  assert.equal(acknowledged.thresholdMin, snapshot.min);
  assert.equal(acknowledged.thresholdMax, snapshot.max);
});

test('resolve requires a fresh normal sample and then closes the loop', () => {
  const alert = activeAlertFor('TEMU-1774029');
  assert.ok(alert);
  assert.throws(() => resolveAlert(alert.id), /仍未回到阈值/);
  ingestSample({ containerId: 'TEMU-1774029', temperature: 10.1, sampledAt: nextSampleTime(), power: 'mains', sourceDevice: 'D05-PLUG-04' });
  assert.throws(() => resolveAlert(alert.id), /仍未回到阈值/);
  ingestSample({ containerId: 'TEMU-1774029', temperature: 5, sampledAt: nextSampleTime(), power: 'mains', sourceDevice: 'D05-PLUG-04' });
  const resolved = resolveAlert(alert.id, '测试值班员');
  assert.equal(resolved.status, 'resolved');
  assert.ok(resolved.resolvedBySampleId);
  assert.throws(() => acknowledgeAlert(alert.id), /已恢复/);
});

test('device offline raises a power alert with gate-specific advice', () => {
  createContainer({ id: 'TEST-RF-GATE1', voyageId: 'VOY-AX7', size: '40', isoType: '45R1', direction: 'export', status: 'at-gate', weightT: 20, reefer: true, temperature: 4, customs: 'released', priority: 'reefer', yardSlot: 'C03-R02-T1' });
  const result = ingestSample({ containerId: 'TEST-RF-GATE1', temperature: 4.2, sampledAt: nextSampleTime(), power: 'offline', sourceDevice: 'GATE-CANOPY-1' });
  assert.equal(result.alert?.cause, 'power');
  assert.equal(result.alert?.level, 'critical');
  assert.equal(result.alert?.stage, 'gate-wait');
  assert.ok(result.alert?.advice.includes('闸口'));
  assert.ok(result.alert?.advice.includes('应急缓冲区'));
});

test('critical alert dispatch to yard task is idempotent', () => {
  const alert = activeAlertFor('TEST-RF-GATE1');
  assert.ok(alert);
  const first = dispatchAlert(alert.id, 'task', '测试值班员');
  const second = dispatchAlert(alert.id, 'task', '测试值班员');
  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.equal(first.task?.id, second.task?.id);
  assert.equal(tasks.filter(task => task.sourceAlertId === alert.id && task.status !== 'done').length, 1);
  assert.throws(() => dispatchAlert(alert.id, 'manual', '测试值班员', ''), /处置说明/);
  const manual = dispatchAlert(alert.id, 'manual', '测试值班员', '闸口员现场复核机组，已重接电源线');
  assert.equal(manual.record?.kind, 'manual');
});

test('suppression absorbs repeats and reopens when readings worsen', () => {
  ingestSample({ containerId: 'TEMU-1774029', temperature: 9, sampledAt: nextSampleTime(), power: 'mains', sourceDevice: 'D05-PLUG-04' });
  const alert = activeAlertFor('TEMU-1774029');
  assert.ok(alert);
  assert.throws(() => suppressAlert(alert.id, '测试值班员', ''), /原因/);
  suppressAlert(alert.id, '测试值班员', '已知除霜周期，观察 30 分钟');
  ingestSample({ containerId: 'TEMU-1774029', temperature: 9.2, sampledAt: nextSampleTime(), power: 'mains', sourceDevice: 'D05-PLUG-04' });
  assert.equal(alert.status, 'suppressed');
  assert.equal(alert.suppressedOccurrences, 1);
  ingestSample({ containerId: 'TEMU-1774029', temperature: 12, sampledAt: nextSampleTime(), power: 'mains', sourceDevice: 'D05-PLUG-04' });
  assert.equal(alert.status, 'open');
});

test('threshold changes apply to new samples while open alerts keep their snapshot', () => {
  const eisuAlert = activeAlertFor('EISU-1288420');
  assert.ok(eisuAlert);
  assert.equal(eisuAlert.thresholdMax, -12);
  ingestSample({ containerId: 'EISU-1288420', temperature: -18, sampledAt: nextSampleTime(), power: 'mains', sourceDevice: 'RTG-B07-P3' });
  resolveAlert(eisuAlert.id);
  updateThresholds('TH-FROZEN', { max: -13 });
  ingestSample({ containerId: 'EISU-1288420', temperature: -12.5, sampledAt: nextSampleTime(), power: 'mains', sourceDevice: 'RTG-B07-P3' });
  const reopened = activeAlertFor('EISU-1288420');
  assert.ok(reopened);
  assert.equal(reopened.thresholdMax, -13);
  assert.equal(alerts.find(item => item.id === eisuAlert.id)?.thresholdMax, -12);
  assert.throws(() => updateThresholds('TH-FROZEN', { min: -10 }), /下限必须小于上限/);
  assert.equal(thresholds.find(item => item.id === 'TH-FROZEN')?.max, -13);
});

test('clock drift is flagged and non-reefer containers are rejected', () => {
  const drift = ingestSample({ containerId: 'EISU-1288420', temperature: -18, sampledAt: new Date(Date.now() + 30 * 60000).toISOString(), power: 'mains', sourceDevice: 'RTG-B07-P3' });
  assert.equal(drift.sample.clockDrift, true);
  assert.ok(drift.sample.flags.some(flag => flag.includes('时钟漂移')));
  assert.throws(() => ingestSample({ containerId: 'MSCU-4829017', temperature: 5, sampledAt: nextSampleTime(), power: 'mains', sourceDevice: 'X-1' }), /不是冷藏箱/);
  assert.ok(containers.some(item => item.id === 'TEST-RF-GATE1'));
});

test('escalate lifts warning alerts to critical', () => {
  const alert = activeAlertFor('EISU-1288420');
  assert.ok(alert);
  assert.equal(alert.level, 'warning');
  const escalated = escalateAlert(alert.id, '测试值班员');
  assert.equal(escalated.level, 'critical');
  assert.equal(escalated.status, 'escalated');
});

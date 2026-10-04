import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, containers, createContainer, tasks } from './domain.js';
import { acknowledgeAlarm, alarms, dispatchAlarm, escalateAlarm, handlingRecords, ingestSample, markAlarmRead, recoverAlarm, reeferOverview, samples, suppressAlarm, updateThreshold } from './reefer.js';

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString();
let containerSeq = 1;
function makeReefer(options: { status?: Container['status']; customs?: Container['customs']; temperature?: number } = {}) {
  const id = `TSTU-9${String(containerSeq++).padStart(5, '0')}`;
  createContainer({
    id, voyageId: 'VOY-AX7', size: '40', isoType: '45R1', direction: 'import', status: options.status ?? 'in-yard',
    weightT: 20, reefer: true, temperature: options.temperature ?? -18, customs: options.customs ?? 'released',
    priority: 'reefer', yardSlot: 'B07-R09-T1'
  });
  return id;
}
const alarmsFor = (id: string) => alarms.filter(item => item.containerId === id);

test('temperature breach raises one alarm with level derived from stage and cargo profile', () => {
  const id = makeReefer({ temperature: -18 });
  const result = ingestSample({ containerId: id, temperature: -10, sampledAt: minutesAgo(1), power: 'connected', deviceId: 'RDU-B07-01' });
  assert.equal(result.duplicate, false);
  assert.equal(result.evaluation?.level, 'critical'); // 堆场冻货 ±3/±5，偏差 8°C
  const alarm = result.alarms[0];
  assert.equal(alarm.status, 'open');
  assert.equal(alarm.unread, true);
  assert.equal(alarm.reading.temperature, -10);
  assert.equal(alarmsFor(id).length, 1);
  // 采样不改写台账中的设定温度
  assert.equal(containers.find(item => item.id === id)?.temperature, -18);
});

test('duplicate samples are idempotent and never raise duplicate alarms', () => {
  const id = makeReefer();
  const payload = { containerId: id, temperature: -9, sampledAt: minutesAgo(2), power: 'connected' as const, deviceId: 'RDU-B07-01' };
  const first = ingestSample(payload);
  assert.ok(first.alarms[0]);
  const second = ingestSample(payload);
  assert.equal(second.duplicate, true);
  assert.equal(alarmsFor(id).length, 1);
  assert.equal(samples.filter(item => item.containerId === id).length, 1);
});

test('acknowledgement never mutates the original reading snapshot', () => {
  const id = makeReefer();
  const alarm = ingestSample({ containerId: id, temperature: -8, sampledAt: minutesAgo(1), power: 'battery', deviceId: 'RDU-B07-01' }).alarms[0];
  const snapshot = { ...alarm.reading };
  const acked = acknowledgeAlarm(alarm.id, '测试值班员');
  assert.equal(acked?.status, 'acknowledged');
  assert.equal(acked?.unread, false);
  assert.deepEqual(alarm.reading, snapshot);
});

test('escalation upgrades level in place without spawning a second alarm', () => {
  const id = makeReefer();
  const alarm = ingestSample({ containerId: id, temperature: -14.5, sampledAt: minutesAgo(1), power: 'connected', deviceId: 'RDU-B07-01' }).alarms[0];
  assert.equal(alarm.level, 'warning'); // 偏差 3.5°C ≥ 告警线 3，低于严重线 5
  escalateAlarm(alarm.id, '测试值班员');
  assert.equal(alarm.level, 'critical');
  assert.equal(alarm.status, 'escalated');
  assert.equal(alarm.escalateCount, 1);
  assert.equal(alarmsFor(id).length, 1);
});

test('recovery requires a fresh normal sample and closes the loop automatically', () => {
  const id = makeReefer();
  const alarm = ingestSample({ containerId: id, temperature: -8, sampledAt: minutesAgo(3), power: 'connected', deviceId: 'RDU-B07-01' }).alarms[0];
  assert.throws(() => recoverAlarm(alarm.id), /晚于触发读数/); // 没有新采样不能闭环
  ingestSample({ containerId: id, temperature: -7.5, sampledAt: minutesAgo(2), power: 'connected', deviceId: 'RDU-B07-01' });
  assert.throws(() => recoverAlarm(alarm.id), /仍未恢复正常/); // 新采样仍异常不能闭环
  const normal = ingestSample({ containerId: id, temperature: -17.6, sampledAt: minutesAgo(1), power: 'connected', deviceId: 'RDU-B07-01' });
  assert.equal(normal.evaluation, null);
  assert.equal(alarm.status, 'recovered');
  assert.ok(alarm.recoverySampleId);
  assert.throws(() => recoverAlarm(alarm.id), /已恢复闭环/);
});

test('suppression mutes repeated anomalies and needs manual recovery confirmation', () => {
  const id = makeReefer();
  const alarm = ingestSample({ containerId: id, temperature: -8, sampledAt: minutesAgo(4), power: 'connected', deviceId: 'RDU-B07-01' }).alarms[0];
  suppressAlarm(alarm.id, 30, '测试值班员');
  assert.equal(alarm.status, 'suppressed');
  ingestSample({ containerId: id, temperature: -7, sampledAt: minutesAgo(1), power: 'connected', deviceId: 'RDU-B07-01' });
  assert.equal(alarmsFor(id).length, 1); // 抑制期内不重复开告警
  assert.equal(alarm.suppressedHits, 1);
  assert.equal(alarm.unread, false);
  ingestSample({ containerId: id, temperature: -18, sampledAt: minutesAgo(0.5), power: 'connected', deviceId: 'RDU-B07-01' });
  assert.equal(alarm.status, 'suppressed'); // 抑制中的告警不被采样自动闭环
  const recovered = recoverAlarm(alarm.id, '测试值班员'); // 但可凭新的正常采样人工确认闭环
  assert.equal(recovered?.status, 'recovered');
});

test('dispatch creates at most one active yard task per container anomaly', () => {
  const id = makeReefer();
  const alarm = ingestSample({ containerId: id, temperature: -6, sampledAt: minutesAgo(2), power: 'connected', deviceId: 'RDU-B07-01' }).alarms[0];
  const first = dispatchAlarm(alarm.id, 'task', '测试值班员');
  assert.ok(first?.task);
  assert.equal(tasks.find(item => item.id === first.task?.id)?.originAlarmId, alarm.id);
  assert.throws(() => dispatchAlarm(alarm.id, 'task', '测试值班员'), /重复派单/);
  // 同一箱的第二条告警也不能再派搬运任务
  ingestSample({ containerId: id, temperature: -6, sampledAt: minutesAgo(1), power: 'offline', deviceId: 'RDU-B07-01' });
  const second = alarmsFor(id).find(item => item.category === 'device-offline');
  assert.ok(second);
  assert.throws(() => dispatchAlarm(second.id, 'task', '测试值班员'), /进行中/);
  const manual = dispatchAlarm(second.id, 'manual', '测试值班员', '现场复核并接便携电源');
  assert.ok(manual?.record);
  assert.equal(handlingRecords[0].containerId, id);
  // 告警恢复后，未执行的处置任务自动闭环
  ingestSample({ containerId: id, temperature: -18, sampledAt: minutesAgo(0.2), power: 'connected', deviceId: 'RDU-B07-01' });
  assert.equal(tasks.find(item => item.id === first.task?.id)?.status, 'done');
});

test('clock drift is flagged and stale samples are archived without evaluation', () => {
  const id = makeReefer();
  const future = ingestSample({ containerId: id, temperature: -5, sampledAt: new Date(Date.now() + 20 * 60000).toISOString(), power: 'connected', deviceId: 'RDU-B07-01' });
  assert.ok(future.sample.flags.includes('clock-drift'));
  const stale = ingestSample({ containerId: id, temperature: 10, sampledAt: minutesAgo(90), power: 'connected', deviceId: 'RDU-B07-01' });
  assert.ok(stale.sample.flags.includes('stale-sample'));
  assert.equal(stale.evaluation, null);
  assert.equal(alarmsFor(id).filter(item => item.category === 'temperature').length, 1); // 仅漂移那条触发
});

test('threshold changes re-evaluate open alarms but never auto-recover them', () => {
  const id = makeReefer({ status: 'on-quay', temperature: 4 });
  const alarm = ingestSample({ containerId: id, temperature: 8, sampledAt: minutesAgo(2), power: 'connected', deviceId: 'RDU-GATE-03' }).alarms[0];
  assert.equal(alarm.level, 'critical'); // 船边保鲜货 ±2.4/±4，偏差 4°C
  const updated = updateThreshold('on-quay', { warnDelta: 6, critDelta: 9 }, '测试值班员');
  assert.ok(updated && updated.reevaluated >= 1);
  assert.equal(alarm.status, 'open'); // 读数回落到新限值内也只提示，必须等新采样闭环
  assert.match(alarm.thresholdNote ?? '', /等待下一条正常采样/);
  assert.equal(alarm.unread, true);
  updateThreshold('on-quay', { warnDelta: 3, critDelta: 5 }, '测试值班员'); // 还原默认阈值
  assert.equal(alarm.thresholdNote, undefined);
});

test('inspection and gate stages produce different handling advice', () => {
  const inspectionId = makeReefer({ customs: 'inspection', temperature: 4 });
  const gateId = makeReefer({ status: 'at-gate', temperature: 4 });
  const a = ingestSample({ containerId: inspectionId, temperature: 8, sampledAt: minutesAgo(1), power: 'connected', deviceId: 'RDU-B07-01' }).alarms[0];
  const b = ingestSample({ containerId: gateId, temperature: 8, sampledAt: minutesAgo(1), power: 'connected', deviceId: 'RDU-GATE-03' }).alarms[0];
  assert.match(a.advice, /查验/);
  assert.match(b.advice, /闸口/);
  assert.notEqual(a.advice, b.advice);
});

test('offline devices open a single device-offline alarm and unread state survives reloads', () => {
  const overview = reeferOverview(); // 首次巡检：为 D05 离线采集器下的 TEMU 开告警
  const offlineAlarms = () => alarms.filter(item => item.containerId === 'TEMU-1774029' && item.category === 'device-offline');
  assert.equal(offlineAlarms().length, 1);
  reeferOverview(); // 再次巡检幂等，不重复开告警
  assert.equal(offlineAlarms().length, 1);
  const alarm = offlineAlarms()[0];
  assert.equal(alarm.level, 'critical'); // 查验阶段设备离线按严重处理
  assert.equal(alarm.unread, true); // 未读状态保存在服务端，页面刷新后仍在
  markAlarmRead(alarm.id);
  assert.equal(alarms.find(item => item.id === alarm.id)?.unread, false);
  assert.ok(overview.devices.some(device => device.id === 'RDU-D05-02' && device.offline));
});

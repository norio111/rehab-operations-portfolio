import test from "node:test";
import assert from "node:assert/strict";
import {
  equipmentTiming,
  estimatedWaitForPatient,
  extendTurnover,
  nextCandidateForEquipment,
  occupiedSlots,
  runScheduler,
  eligibleItemFor,
  startTurnover,
  usageTiming,
} from "../lib/rehab-scheduler.mjs";

// ---- テストデータ生成ヘルパー ----
const NOW = 1000000;

function eq(id, capacity, inUse = [], opts = {}) {
  return {
    id,
    name: id,
    capacity,
    inUse,
    turnovers: opts.turnovers ?? [],
    standardDurationMin: opts.standardDurationMin ?? 15,
    turnoverMin: opts.turnoverMin ?? 3,
  };
}

// itemsSpec: [{ eqId, status?, waitingSince? }]
function patient(id, orderMode, itemsSpec, opts = {}) {
  return {
    id,
    no: id,
    receivedAt: opts.receivedAt ?? NOW,
    currentEquipmentId: opts.currentEquipmentId ?? null,
    idleSince: opts.idleSince ?? NOW,
    orderMode,
    items: itemsSpec.map((s, idx) => ({
      equipmentId: s.eqId,
      status: s.status ?? "waiting",
      startedAt: s.startedAt ?? null,
      plannedEndAt: s.plannedEndAt ?? null,
      plannedDurationMin: s.plannedDurationMin ?? 15,
      // fixedは最初の項目のみ、flexibleは全項目に待ち始め時刻が付く(本体と同じ規約)
      waitingSince:
        s.waitingSince !== undefined
          ? s.waitingSince
          : orderMode === "flexible" || idx === 0
          ? NOW
          : null,
    })),
  };
}

function assigned(pats, patientId) {
  return pats.find((p) => p.id === patientId).currentEquipmentId;
}

// ---- 制約1: 機器のcapacityを超えて割り当てない ----
test("capacity=1の機器に待機2名 → 割当は1名だけ", () => {
  const eqs = [eq("平行棒", 1)];
  const pats = [
    patient("p1", "fixed", [{ eqId: "平行棒" }]),
    patient("p2", "fixed", [{ eqId: "平行棒" }]),
  ];
  const { eqs: e2, pats: p2 } = runScheduler(eqs, pats, NOW);
  assert.equal(e2[0].inUse.length, 1);
  const inProgress = p2.filter((p) => p.currentEquipmentId !== null);
  assert.equal(inProgress.length, 1);
});

// ---- 制約2: 患者は同時に1台しか使えない ----
test("2機器が空いていても、1人の患者に割り当たるのは1台だけ", () => {
  const eqs = [eq("ホットパック", 4), eq("牽引", 2)];
  const pats = [
    patient("p1", "flexible", [{ eqId: "ホットパック" }, { eqId: "牽引" }]),
  ];
  const { eqs: e2, pats: p2 } = runScheduler(eqs, pats, NOW);
  const totalAssigned = e2.reduce((n, e) => n + e.inUse.length, 0);
  assert.equal(totalAssigned, 1);
  assert.notEqual(assigned(p2, "p1"), null);
});

// ---- 制約3: fixedモードは希望順を飛ばさない ----
test("fixed: 1番目の機器が満員でも、空いている2番目を先に割り当てない", () => {
  const eqs = [eq("平行棒", 1, ["other"]), eq("牽引", 2)]; // 平行棒は他人が使用中
  const pats = [
    patient("p1", "fixed", [{ eqId: "平行棒" }, { eqId: "牽引" }]),
  ];
  const { pats: p2 } = runScheduler(eqs, pats, NOW);
  assert.equal(assigned(p2, "p1"), null); // 牽引が空いていても待つ
});

// ---- 制約4: flexibleモードは空いたものから消化する ----
test("flexible: 1番目の機器が満員なら、空いている2番目に割り当てる", () => {
  const eqs = [eq("平行棒", 1, ["other"]), eq("牽引", 2)];
  const pats = [
    patient("p1", "flexible", [{ eqId: "平行棒" }, { eqId: "牽引" }]),
  ];
  const { pats: p2 } = runScheduler(eqs, pats, NOW);
  assert.equal(assigned(p2, "p1"), "牽引");
});

// ---- 制約5: 公平性は waitingSince(待ち始め)順 ----
test("待ち始めが早い患者が優先される(受付順ではない)", () => {
  const eqs = [eq("平行棒", 1)];
  const pats = [
    // p1は受付は早いが、この項目を待ち始めたのは遅い
    patient("p1", "fixed", [{ eqId: "平行棒", waitingSince: NOW + 500 }], { receivedAt: NOW }),
    patient("p2", "fixed", [{ eqId: "平行棒", waitingSince: NOW + 100 }], { receivedAt: NOW + 50 }),
  ];
  const { pats: p2 } = runScheduler(eqs, pats, NOW + 1000);
  assert.equal(assigned(p2, "p2"), "平行棒");
  assert.equal(assigned(p2, "p1"), null);
});

// ---- 制約6: 施行中の患者は候補にならない ----
test("すでに機器を使用中の患者は、他機器の候補から除外される", () => {
  const p = patient("p1", "flexible", [{ eqId: "牽引" }], { currentEquipmentId: "ホットパック" });
  assert.equal(eligibleItemFor(p, "牽引"), null);
});

test("割当時に個別の予定利用時間から予定終了時刻を設定する", () => {
  const machines = [eq("牽引", 1, [], { standardDurationMin: 15 })];
  const patients = [patient("p1", "fixed", [{ eqId: "牽引", plannedDurationMin: 22 }])];
  const result = runScheduler(machines, patients, NOW);
  const item = result.pats[0].items[0];

  assert.equal(item.status, "in_progress");
  assert.equal(item.startedAt, NOW);
  assert.equal(item.plannedEndAt, NOW + 22 * 60_000);
});

test("予定時間を超えても自動完了せず、超過情報だけを返す", () => {
  const item = {
    status: "in_progress",
    startedAt: NOW,
    plannedDurationMin: 10,
    plannedEndAt: NOW + 10 * 60_000,
  };
  const timing = usageTiming(item, NOW + 12 * 60_000);

  assert.equal(timing.overdue, true);
  assert.equal(timing.remainingMs, -2 * 60_000);
  assert.equal(item.status, "in_progress");
});

test("利用終了後は清掃枠が台を占有し、標準清掃時間の経過後に次患者を割り当てる", () => {
  const inUse = eq("平行棒", 1, ["p1"], { turnoverMin: 4 });
  const cleaning = startTurnover(inUse, "p1", 1, NOW);
  const waiting = patient("p2", "fixed", [{ eqId: "平行棒" }]);

  assert.equal(occupiedSlots(cleaning), 1);
  assert.equal(cleaning.turnovers[0].readyAt, NOW + 4 * 60_000);
  const blocked = runScheduler([cleaning], [waiting], NOW + 3 * 60_000);
  assert.equal(assigned(blocked.pats, "p2"), null);

  const assignedAfterReady = runScheduler([cleaning], blocked.pats, NOW + 4 * 60_000);
  assert.equal(assigned(assignedAfterReady.pats, "p2"), "平行棒");
  assert.equal(assignedAfterReady.eqs[0].turnovers.length, 0);
});

test("清掃延長は例外操作として自動解放時刻を後ろへ延ばす", () => {
  const cleaning = startTurnover(
    eq("牽引", 1, ["p1"], { turnoverMin: 3 }),
    "p1",
    1,
    NOW,
  );
  const extended = extendTurnover(cleaning, cleaning.turnovers[0].id, 2);

  assert.equal(extended.turnovers[0].readyAt, NOW + 5 * 60_000);
  assert.equal(cleaning.turnovers[0].readyAt, NOW + 3 * 60_000);
});

test("予定利用可能時刻に使用時間と清掃・交代時間を含める", () => {
  const machine = eq("牽引", 1, ["p1"], { turnoverMin: 5 });
  const active = patient(
    "p1",
    "fixed",
    [{
      eqId: "牽引",
      status: "in_progress",
      startedAt: NOW,
      plannedEndAt: NOW + 20 * 60_000,
      plannedDurationMin: 20,
    }],
    { currentEquipmentId: "牽引", idleSince: null },
  );
  const timing = equipmentTiming(machine, [active], NOW);

  assert.equal(timing.earliestAvailableAt, NOW + 25 * 60_000);
  assert.equal(timing.waitMs, 25 * 60_000);
});

test("待ち時間見積りは公平性順と各利用後の清掃時間を反映する", () => {
  const machine = eq("平行棒", 1, [], { turnoverMin: 3 });
  const first = patient("p1", "fixed", [{ eqId: "平行棒", waitingSince: NOW, plannedDurationMin: 10 }]);
  const second = patient("p2", "fixed", [{ eqId: "平行棒", waitingSince: NOW + 1, plannedDurationMin: 8 }]);
  const estimate = estimatedWaitForPatient(machine, [second, first], "p2", NOW);

  assert.equal(estimate.estimatedStartAt, NOW + 13 * 60_000);
  assert.equal(estimate.waitMs, 13 * 60_000);
});

test("清掃中の次候補表示は待ち始め順で、患者状態を変更しない", () => {
  const later = patient("p1", "fixed", [{ eqId: "牽引", waitingSince: NOW + 20 }]);
  const earlier = patient("p2", "fixed", [{ eqId: "牽引", waitingSince: NOW + 10 }]);
  const candidate = nextCandidateForEquipment([later, earlier], "牽引");

  assert.equal(candidate.patient.id, "p2");
  assert.equal(earlier.currentEquipmentId, null);
  assert.equal(earlier.items[0].status, "waiting");
});

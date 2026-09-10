import test from "node:test";
import assert from "node:assert/strict";
import {
  cancelCollectionRequest,
  completeReturn,
  daysUntilDischarge,
  dischargeTiming,
  requestCollection,
} from "../lib/discharge-returns.mjs";

const NOW = 1_000_000;

function pendingRow() {
  return {
    patient_id: "DEMO-P001",
    status: "pending",
    unreturned_equipment: [
      { equipment_id: "DEMO-E001", name: "デモ車椅子A" },
      { equipment_id: "DEMO-E002", name: "クッション" },
    ],
    collectionTasks: [],
    history: [],
  };
}

test("回収依頼で内部タスクを生成し、状態を回収依頼済みに同時更新する", () => {
  const original = pendingRow();
  const requested = requestCollection(original, "PT_A", NOW);

  assert.equal(requested.status, "requested");
  assert.equal(requested.collectionTasks.length, 1);
  assert.deepEqual(requested.collectionTasks[0].equipmentIds, ["DEMO-E001", "DEMO-E002"]);
  assert.equal(requested.collectionTasks[0].status, "open");
  assert.equal(requested.history[0].action, "request_collection");
  assert.equal(original.status, "pending");
});

test("返却完了で状態を返却済みにし、回収タスクも完了する", () => {
  const requested = requestCollection(pendingRow(), "PT_A", NOW);
  const returned = completeReturn(requested, "PT_B", NOW + 60_000);

  assert.equal(returned.status, "returned");
  assert.equal(returned.returnedAt, NOW + 60_000);
  assert.equal(returned.collectionTasks[0].status, "completed");
  assert.equal(returned.collectionTasks[0].completedBy, "PT_B");
  assert.equal(returned.history.at(-1).action, "complete_return");
});

test("回収依頼の取消時はタスクを取消済みにして未対応へ戻す", () => {
  const requested = requestCollection(pendingRow(), "PT_A", NOW);
  const cancelled = cancelCollectionRequest(requested, "PT_A", NOW + 30_000);

  assert.equal(cancelled.status, "pending");
  assert.equal(cancelled.collectionTasks[0].status, "cancelled");
  assert.equal(cancelled.history.at(-1).action, "cancel_collection");
});

test("退院までの日数と表示文言が当日・翌日・2日以降で一致する", () => {
  const today = new Date(2026, 8, 10, 23, 30);

  assert.deepEqual(dischargeTiming("2026-09-10", today), {
    days: 0,
    relativeLabel: "本日退院",
    plannedDateLabel: "2026年9月10日",
  });
  assert.equal(dischargeTiming("2026-09-11", today).relativeLabel, "退院は明日");
  assert.equal(dischargeTiming("2026-09-12", today).relativeLabel, "退院まであと2日");
  assert.equal(dischargeTiming("2026-09-13", today).relativeLabel, "退院まであと3日");
});

test("退院までの日数は時刻ではなく暦日の差で計算する", () => {
  const lateToday = new Date(2026, 8, 10, 23, 59, 59);
  assert.equal(daysUntilDischarge("2026-09-11", lateToday), 1);
});

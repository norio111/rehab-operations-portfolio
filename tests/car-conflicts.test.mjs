import test from "node:test";
import assert from "node:assert/strict";
import {
  activeOn,
  carBoardToday,
  facilityPresetRange,
  findConflict,
  futureBulkCandidates,
  planBulkReservations,
  initialCarBoardWeek,
  isTodayLane,
  needsReservationChangeScope,
  moveReservationRange,
  overlaps,
  resizeReservationLeft,
  resizeReservationRight,
  rangeFromStartEnd,
  reservationMatchesCandidate,
  reservationDialogReducer,
  snapToMinutes,
  timelinePercent,
  timeValueToMinutes,
  validateReservationCandidate,
  validateReservationChange,
  validateTimeRange,
} from "../lib/car-conflicts.mjs";

// 予約生成ヘルパー
function res(id, carId, weekday, start, duration, weeks = [1, 2, 3, 4], cancelled = []) {
  return { id, carId, staff: id, weekday, start, duration, weeks, cancelled };
}

const T = (h, m = 0) => h * 60 + m;

const bulkRequest = (weekdays = ["火"], start = T(10)) => ({
  carId: "c1", weekdays, weeks: [1, 2, 3, 4, 5], start, duration: 60,
});

test("一括候補は過去日と月外の日を除き、曜日ごとに未来の週だけを生成する", () => {
  const candidates = futureBulkCandidates(bulkRequest(["火", "木"]), new Date(2026, 8, 10, 9));
  assert.deepEqual(candidates.map(({ weekday, weeks }) => ({ weekday, weeks })), [
    { weekday: "火", weeks: [3, 4, 5] },
    { weekday: "木", weeks: [2, 3, 4] },
  ]);
});

test("今日の開始が現在より前なら除外し、同時刻と未来時刻は含める", () => {
  const request = bulkRequest(["木"]);
  assert.deepEqual(futureBulkCandidates(request, new Date(2026, 8, 10, 10, 0, 1))[0].weeks, [3, 4]);
  assert.deepEqual(futureBulkCandidates(request, new Date(2026, 8, 10, 10))[0].weeks, [2, 3, 4]);
  assert.deepEqual(futureBulkCandidates(request, new Date(2026, 8, 10, 9, 59))[0].weeks, [2, 3, 4]);
});

test("過去日に重複があっても未来分の一括登録は成功する", () => {
  const existing = [res("past", "c1", "火", T(10), 60, [1, 2])];
  const before = structuredClone(existing);
  const plan = planBulkReservations(existing, bulkRequest(), new Date(2026, 8, 10));
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.candidates[0].weeks, [3, 4, 5]);
  assert.deepEqual(existing, before);
});

test("今日の過去時刻の重複も判定対象から除外する", () => {
  const existing = [res("earlier-today", "c1", "木", T(10), 60, [2])];
  const plan = planBulkReservations(existing, bulkRequest(["木"]), new Date(2026, 8, 10, 10, 30));
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.candidates[0].weeks, [3, 4]);
});

test("未来の重複がある場合は一括登録全体を拒否し、登録候補を返さない", () => {
  const existing = [res("future", "c1", "火", T(10), 60, [4])];
  const plan = planBulkReservations(existing, bulkRequest(), new Date(2026, 8, 10));
  assert.equal(plan.ok, false);
  assert.equal(plan.conflict.week, 4);
  assert.equal(plan.conflict.hit.id, "future");
  assert.deepEqual(plan.candidates, []);
});

test("未来の定期予約でもキャンセル済みの週は空きとして扱う", () => {
  const existing = [res("series", "c1", "火", T(10), 60, [1, 2, 3, 4, 5], ["3", "4", "5"])];
  const plan = planBulkReservations(existing, bulkRequest(), new Date(2026, 8, 10));
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.candidates[0].weeks, [3, 4, 5]);
});

test("全候補が過去なら既存予約を重複検索せず、空の計画を返す", () => {
  const existing = new Proxy([], {
    get() { throw new Error("過去候補で既存予約を参照してはいけない"); },
  });
  assert.deepEqual(
    planBulkReservations(existing, bulkRequest(), new Date(2026, 8, 30, 18)),
    { ok: true, candidates: [] },
  );
});

// ---- 境界1: ぴったり隣接する予約は衝突しない ----
test("10:00-11:00 の直後に 11:00-12:00 は登録できる(半開区間)", () => {
  assert.equal(overlaps(T(10), 60, T(11), 60), false);
  assert.equal(overlaps(T(11), 60, T(10), 60), false);
});

// ---- 境界2: 1分でも重なれば衝突 ----
test("10:00-11:00 と 10:59開始 は衝突する", () => {
  assert.equal(overlaps(T(10), 60, T(10, 59), 60), true);
});

// ---- 包含関係も衝突 ----
test("既存予約を完全に包む予約・包まれる予約はどちらも衝突する", () => {
  assert.equal(overlaps(T(9), 480, T(10), 60), true); // 包む
  assert.equal(overlaps(T(10), 30, T(9), 480), true); // 包まれる
});

// ---- キャンセル週の解放 ----
test("キャンセル済みの週は空き枠として扱われる", () => {
  const rs = [res("r1", "c1", "月", T(10), 60, [1, 2, 3, 4], ["3"])];
  assert.equal(activeOn(rs, "c1", 2, "月").length, 1); // 第2週は有効
  assert.equal(activeOn(rs, "c1", 3, "月").length, 0); // 第3週はキャンセル済み
  // 第3週なら同時刻に登録できる
  const conflict = findConflict(rs, {
    carId: "c1", weekdays: ["月"], weeks: [3], start: T(10), duration: 60,
  });
  assert.equal(conflict, null);
});

// ---- 定期登録は全対象週×曜日で判定される ----
test("毎週登録(第1-4週)は、1週でも既存と重なれば衝突を検出する", () => {
  const rs = [res("r1", "c1", "火", T(13), 80, [2])]; // 第2週火曜だけの単発予約
  const conflict = findConflict(rs, {
    carId: "c1", weekdays: ["火"], weeks: [1, 2, 3, 4], start: T(13), duration: 60,
  });
  assert.notEqual(conflict, null);
  assert.equal(conflict.week, 2);
  assert.equal(conflict.weekday, "火");
});

// ---- 別の車・別の曜日は独立 ----
test("同時刻でも車が違えば衝突しない / 曜日が違えば衝突しない", () => {
  const rs = [res("r1", "c1", "月", T(10), 60)];
  assert.equal(
    findConflict(rs, { carId: "c2", weekdays: ["月"], weeks: [1], start: T(10), duration: 60 }),
    null
  );
  assert.equal(
    findConflict(rs, { carId: "c1", weekdays: ["水"], weeks: [1], start: T(10), duration: 60 }),
    null
  );
});

// ---- ドラッグ移動時の自己除外 ----
test("ignoreIdで自分自身は衝突相手にならない(同位置への移動が可能)", () => {
  const rs = [res("r1", "c1", "月", T(10), 60)];
  const conflict = findConflict(rs, {
    carId: "c1", weekdays: ["月"], weeks: [1, 2, 3, 4],
    start: T(10, 10), duration: 60, ignoreId: "r1",
  });
  assert.equal(conflict, null);
});

test("操作時刻を10分単位へスナップする", () => {
  assert.equal(snapToMinutes(T(9, 4)), T(9));
  assert.equal(snapToMinutes(T(9, 6)), T(9, 10));
});

test("バー本体の移動は利用時間を維持し、営業時間内へ収める", () => {
  const reservation = res("r1", "c1", "月", T(10), 80);
  assert.deepEqual(moveReservationRange(reservation, T(11, 7)), {
    start: T(11, 10),
    duration: 80,
  });
  assert.deepEqual(moveReservationRange(reservation, T(17, 30)), {
    start: T(16, 40),
    duration: 80,
  });
  assert.deepEqual(moveReservationRange(reservation, T(7)), {
    start: T(8),
    duration: 80,
  });
});

test("右端リサイズは開始を固定して終了を10分単位で変更する", () => {
  const reservation = res("r1", "c1", "月", T(10), 60);
  assert.deepEqual(resizeReservationRight(reservation, T(11, 26)), {
    start: T(10),
    duration: 90,
  });
});

test("左端リサイズは終了を固定して開始と利用時間を変更する", () => {
  const reservation = res("r1", "c1", "月", T(10), 60);
  assert.deepEqual(resizeReservationLeft(reservation, T(9, 34)), {
    start: T(9, 30),
    duration: 90,
  });
});

test("左右リサイズは最短10分を下回らず、8:00〜18:00を越えない", () => {
  const reservation = res("r1", "c1", "月", T(10), 60);
  assert.deepEqual(resizeReservationRight(reservation, T(10, 1)), {
    start: T(10),
    duration: 10,
  });
  assert.deepEqual(resizeReservationRight(reservation, T(19)), {
    start: T(10),
    duration: 480,
  });
  assert.deepEqual(resizeReservationLeft(reservation, T(7)), {
    start: T(8),
    duration: 180,
  });
  assert.deepEqual(resizeReservationLeft(reservation, T(10, 59)), {
    start: T(10, 50),
    duration: 10,
  });
});

test("共通検証は重複を拒否し、検証失敗時も元予約を変更しない", () => {
  const source = res("source", "c1", "月", T(10), 60, [1]);
  const blocker = res("blocker", "c1", "月", T(12), 60, [1]);
  const reservations = [source, blocker];
  const before = structuredClone(reservations);
  const result = validateReservationChange(
    reservations,
    source,
    { carId: "c1", weekday: "月", start: T(11, 30), duration: 60 },
    [1],
  );

  assert.equal(result.ok, false);
  assert.equal(result.conflict.hit.id, "blocker");
  assert.deepEqual(reservations, before);
});

test("共通検証は隣接予約を許可し、定期予約では全対象週を検証する", () => {
  const source = res("source", "c1", "月", T(10), 60, [1, 2, 3, 4]);
  const weekTwo = res("week-two", "c1", "火", T(12), 60, [2]);
  const reservations = [source, weekTwo];

  const adjacent = validateReservationChange(
    reservations,
    source,
    { carId: "c1", weekday: "月", start: T(11), duration: 60 },
    [1, 2, 3, 4],
  );
  assert.equal(adjacent.ok, true);

  const recurringConflict = validateReservationChange(
    reservations,
    source,
    { carId: "c1", weekday: "火", start: T(12), duration: 60 },
    [1, 2, 3, 4],
  );
  assert.equal(recurringConflict.ok, false);
  assert.equal(recurringConflict.conflict.week, 2);
});

test("今日の曜日は実日付と月内週が表示週に一致するときだけ強調する", () => {
  const now = new Date(2026, 8, 10, 9, 20);
  assert.deepEqual(carBoardToday(now), {
    year: 2026,
    month: 9,
    day: 10,
    weekday: "木",
    weekOfMonth: 2,
    minuteOfDay: T(9, 20),
  });
  assert.equal(isTodayLane(2, "木", now), true);
  assert.equal(isTodayLane(1, "木", now), false);
  assert.equal(isTodayLane(2, "水", now), false);
});

test("起動時は今日を含む月内週を選び、第5週も表示できる", () => {
  assert.equal(initialCarBoardWeek(new Date(2026, 8, 10), [1, 2, 3, 4, 5]), 2);
  assert.equal(initialCarBoardWeek(new Date(2026, 8, 30), [1, 2, 3, 4, 5]), 5);
});

test("24時間設定でも時間軸と予約範囲の計算が成立する", () => {
  const rules = { facilityHours: { dayStart: 0, dayEnd: 1440 } };
  assert.equal(timelinePercent(T(12), rules.facilityHours), 50);
  assert.deepEqual(moveReservationRange(res("r1", "c1", "月", T(1), 60), T(23, 40), rules), {
    start: T(23),
    duration: 60,
  });
  assert.equal(
    validateReservationCandidate(
      [],
      { carId: "c1", weekday: "月", start: T(23), duration: 60 },
      [1],
      rules,
    ).ok,
    true,
  );
});

test("facilityHoursを変えると利用可能時間の判定が変わる", () => {
  const early = { carId: "c1", weekday: "月", start: T(7), duration: 30 };
  assert.equal(validateReservationCandidate([], early, [1]).ok, false);
  assert.equal(
    validateReservationCandidate([], early, [1], {
      facilityHours: { dayStart: 0, dayEnd: 1440 },
    }).ok,
    true,
  );
});

test("時刻入力は終了<=開始・最短未満・営業時間外・10分単位違反を即時エラーにする", () => {
  assert.equal(validateTimeRange(T(10), T(10)).error, "終了時刻は開始時刻より後にしてください");
  assert.equal(validateTimeRange(T(10), T(10, 5)).error, "利用時間は10分以上にしてください");
  assert.match(validateTimeRange(T(7, 50), T(8, 10)).error, /利用可能時間/);
  assert.equal(validateTimeRange(T(9, 5), T(10, 5)).error, "10分単位で指定してください");
});

test("入力エラー時は登録用rangeを返さず、予約は追加されない", () => {
  const reservations = [];
  const validation = validateTimeRange(T(10), T(9, 50));
  if (validation.ok) reservations.push(validation.range);

  assert.equal(validation.ok, false);
  assert.equal("range" in validation, false);
  assert.deepEqual(reservations, []);
});

test("午前・午後・終日プリセットは施設設定から編集可能な初期値を返す", () => {
  assert.deepEqual(facilityPresetRange("morning"), { start: T(8), end: T(12) });
  assert.deepEqual(facilityPresetRange("afternoon"), { start: T(13), end: T(17) });
  assert.deepEqual(facilityPresetRange("allDay"), { start: T(8), end: T(18) });

  const editedMorning = facilityPresetRange("morning");
  editedMorning.start = T(8, 20);
  editedMorning.end = T(11, 40);
  const validation = validateTimeRange(editedMorning.start, editedMorning.end);
  assert.equal(validation.ok, true);
  assert.deepEqual(validation.range, { start: T(8, 20), duration: 200 });
});

test("新規登録は開始・終了から10分単位の任意時間を利用時間へ変換できる", () => {
  const range = rangeFromStartEnd(
    timeValueToMinutes("09:10"),
    timeValueToMinutes("10:00"),
  );
  const validation = validateReservationCandidate(
    [],
    { carId: "c1", weekday: "月", ...range },
    [1],
  );

  assert.deepEqual(range, { start: T(9, 10), duration: 50 });
  assert.equal(validation.ok, true);
});

test("通常クリックは詳細を開き、削除操作を選んだ場合だけ削除確認へ進む", () => {
  const reservation = res("r1", "c1", "月", T(9), 50, [1]);
  const details = reservationDialogReducer(
    { kind: "closed" },
    { type: "open-details", reservation },
  );
  assert.equal(details.kind, "details");
  assert.equal(details.draft.startTime, "09:00");
  assert.equal(details.draft.endTime, "09:50");

  const unchanged = reservationDialogReducer(details, { type: "unknown" });
  assert.equal(unchanged.kind, "details");

  const deletion = reservationDialogReducer(details, { type: "request-delete" });
  assert.equal(deletion.kind, "delete");
  assert.equal(deletion.reservation.id, "r1");
});

test("定期予約だけが今週／毎週の変更範囲確認を必要とする", () => {
  assert.equal(needsReservationChangeScope(res("single", "c1", "月", T(9), 50, [2])), false);
  assert.equal(
    needsReservationChangeScope(res("series", "c1", "月", T(9), 50, [1, 2, 3, 4])),
    true,
  );
});

test("実際の予約内容が変わらない操作では変更確認を不要にできる", () => {
  const reservation = res("series", "c1", "月", T(9), 50, [1, 2, 3, 4]);
  assert.equal(
    reservationMatchesCandidate(reservation, {
      carId: "c1",
      weekday: "月",
      start: T(9),
      duration: 50,
    }),
    true,
  );
  assert.equal(
    reservationMatchesCandidate(reservation, {
      carId: "c1",
      weekday: "月",
      start: T(9, 10),
      duration: 50,
    }),
    false,
  );
});

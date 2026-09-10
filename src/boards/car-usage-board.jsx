import { useEffect, useReducer, useRef, useState } from "react";
import { CAR_FACILITY_SETTINGS } from "../../config/car-facility.mjs";
import {
  activeOn,
  carBoardToday,
  facilityPresetRange,
  initialCarBoardWeek,
  isTodayLane,
  minutesToTimeValue,
  moveReservationRange,
  needsReservationChangeScope,
  planBulkReservations,
  resizeReservationLeft,
  resizeReservationRight,
  reservationMatchesCandidate,
  reservationDialogReducer,
  timelinePercent,
  timeValueToMinutes,
  validateReservationCandidate,
  validateReservationChange,
  validateTimeRange,
} from "../../lib/car-conflicts.mjs";

// ---- config ----
const { facilityHours } = CAR_FACILITY_SETTINGS;
const DAY_START = facilityHours.dayStart;
const DAY_END = facilityHours.dayEnd;
const CARS = [
  { id: "c1", name: "1号車", color: "#BF3B2C" },
  { id: "c2", name: "2号車", color: "#33475B" },
  { id: "c3", name: "3号車", color: "#5E7A3A" },
];
const WEEKDAYS = ["月", "火", "水", "木", "金", "土", "日"];
const WEEKS = [1, 2, 3, 4, 5];
const SNAP_MIN = CAR_FACILITY_SETTINGS.snapMinutes;
const TIME_RULES = {
  facilityHours,
  snap: CAR_FACILITY_SETTINGS.snapMinutes,
  minDuration: CAR_FACILITY_SETTINGS.minDuration,
};
const DEFAULT_FORM_RANGE = { start: 13 * 60, end: 14 * 60 + 20 };

function fmtTime(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

// 予約 = 「誰がこの車をいつ使うか」(スタッフ中心)
const INITIAL = [
  { id: "r1", carId: "c1", staff: "PT_A", weekday: "火", start: 13 * 60, duration: 80, weeks: WEEKS, cancelled: [] },
  { id: "r2", carId: "c2", staff: "OT_A", weekday: "月", start: 10 * 60, duration: 100, weeks: WEEKS, cancelled: ["3"] },
  { id: "r3", carId: "c3", staff: "Ns_A", weekday: "金", start: 14 * 60, duration: 60, weeks: [2, 4], cancelled: [] },
];

export default function CarUsageBoard() {
  const [reservations, setReservations] = useState(INITIAL);
  const [viewWeek, setViewWeek] = useState(() => initialCarBoardWeek(new Date(), WEEKS));
  const [form, setForm] = useState({
    staff: "",
    carId: "c1",
    weekdays: ["火"],
    startTime: minutesToTimeValue(DEFAULT_FORM_RANGE.start),
    endTime: minutesToTimeValue(DEFAULT_FORM_RANGE.end),
    repeat: true,
  });
  const [message, setMessage] = useState(null);
  const [quickAdd, setQuickAdd] = useState(null); // { carId, weekday, start, end, staff }
  const [dialog, dispatchDialog] = useReducer(reservationDialogReducer, { kind: "closed" });
  const [changeTarget, setChangeTarget] = useState(null); // 定期予約の変更範囲確認
  const [pointerPreview, setPointerPreview] = useState(null);
  const dragRef = useRef(null);
  const suppressClickUntilRef = useRef(0);
  const todaySectionRef = useRef(null);
  const didInitialScrollRef = useRef(false);
  const [now, setNow] = useState(() => new Date());

  const totalMin = DAY_END - DAY_START;
  const today = carBoardToday(now);
  const detailsTarget = dialog.kind === "details" ? dialog.reservation : null;
  const deleteTarget = dialog.kind === "delete" ? dialog.reservation : null;
  const formTimeValidation = validateTimeRange(
    timeValueToMinutes(form.startTime),
    timeValueToMinutes(form.endTime),
    TIME_RULES,
  );
  const quickTimeValidation = quickAdd
    ? validateTimeRange(quickAdd.start, quickAdd.end, TIME_RULES)
    : null;
  const detailsTimeValidation = dialog.kind === "details"
    ? validateTimeRange(
        timeValueToMinutes(dialog.draft.startTime),
        timeValueToMinutes(dialog.draft.endTime),
        TIME_RULES,
      )
    : null;

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (didInitialScrollRef.current || !todaySectionRef.current) return;
    didInitialScrollRef.current = true;
    todaySectionRef.current.scrollIntoView({ block: "start", behavior: "auto" });
  }, []);

  // ---------- 登録 ----------
  function tryAdd() {
    if (!formTimeValidation.ok) {
      setMessage({ type: "error", text: formTimeValidation.error });
      return;
    }
    const range = formTimeValidation.range;
    const staff = form.staff.trim() || "スタッフ未入力";
    const weeks = form.repeat ? WEEKS : [viewWeek];

    if (form.weekdays.length === 0) {
      setMessage({ type: "error", text: "曜日を1つ以上選択してください" });
      return;
    }
    const plan = planBulkReservations(
      reservations,
      { carId: form.carId, weekdays: form.weekdays, weeks, ...range },
      new Date(),
      TIME_RULES,
    );
    if (!plan.ok) {
      const carName = CARS.find((c) => c.id === form.carId)?.name;
      const conflict = plan.conflict;
      setMessage({
        type: "error",
        text: conflict
          ? `第${conflict.week}週${conflict.weekday}曜、${carName}は ${conflict.hit.staff}(${fmtTime(
              conflict.hit.start,
            )}〜${fmtTime(conflict.hit.start + conflict.hit.duration)})が使用中のため登録を中止しました`
          : plan.reason,
      });
      return;
    }

    if (plan.candidates.length === 0) {
      setMessage({ type: "ok", text: "登録対象の日時がありません" });
      return;
    }

    setReservations((rs) => [
      ...rs,
      ...plan.candidates.map((candidate) => ({
        ...candidate,
        id: "r" + Date.now() + candidate.weekday,
        staff,
        cancelled: [],
      })),
    ]);
    const wdText = plan.candidates.map((candidate) => candidate.weekday + "曜").join("・");
    setMessage({
      type: "ok",
      text: form.repeat
        ? `${staff} の利用を${wdText}に一括登録しました`
        : `${staff} の利用を第${viewWeek}週${wdText}に登録しました`,
    });
  }

  function suggestCar() {
    if (!formTimeValidation.ok) {
      setMessage({ type: "error", text: formTimeValidation.error });
      return;
    }
    const range = formTimeValidation.range;
    const weeks = form.repeat ? WEEKS : [viewWeek];
    if (form.weekdays.length === 0) {
      setMessage({ type: "error", text: "曜日を1つ以上選択してください" });
      return;
    }
    const checkedAt = new Date();
    const plans = CARS.map((car) => ({
      car,
      plan: planBulkReservations(
        reservations,
        { carId: car.id, weekdays: form.weekdays, weeks, ...range },
        checkedAt,
        TIME_RULES,
      ),
    }));
    if (plans.every(({ plan }) => plan.ok && plan.candidates.length === 0)) {
      setMessage({ type: "ok", text: "登録対象の日時がありません" });
      return;
    }
    const free = plans.filter(({ plan }) => plan.ok).map(({ car }) => car);
    if (free.length === 0) {
      setMessage({ type: "error", text: "この条件では全車が埋まっています" });
    } else {
      setMessage({ type: "ok", text: `空いている車: ${free.map((c) => c.name).join(" / ")}` });
    }
  }

  // ---------- 空きレーンタップ → その場でクイック登録 ----------
  function handleLaneTap(e, carId, weekday) {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    let min = DAY_START + ratio * totalMin;
    min = Math.round(min / SNAP_MIN) * SNAP_MIN;
    const start = Math.max(
      DAY_START,
      Math.min(min, DAY_END - CAR_FACILITY_SETTINGS.minDuration),
    );
    setQuickAdd({
      carId,
      weekday,
      start,
      end: Math.min(start + 60, DAY_END),
      staff: "",
    });
  }

  function applyQuickPreset(name) {
    const preset = facilityPresetRange(name);
    if (!preset) return;
    setQuickAdd((current) => (current ? { ...current, ...preset } : current));
  }

  function confirmQuickAdd() {
    if (!quickAdd) return;
    const { carId, weekday } = quickAdd;
    if (!quickTimeValidation?.ok) {
      setMessage({ type: "error", text: quickTimeValidation?.error ?? "時刻を確認してください" });
      return;
    }
    const range = quickTimeValidation.range;
    const staff = quickAdd.staff.trim() || "スタッフ未入力";

    const validation = validateReservationCandidate(
      reservations,
      { carId, weekday, ...range },
      [viewWeek],
      TIME_RULES,
    );
    if (!validation.ok) {
      setMessage({
        type: "error",
        text: validation.conflict
          ? `${validation.conflict.hit.staff}(${fmtTime(
              validation.conflict.hit.start,
            )}〜${fmtTime(
              validation.conflict.hit.start + validation.conflict.hit.duration,
            )})と重なります`
          : validation.reason,
      });
      return;
    }

    setReservations((rs) => [
      ...rs,
      {
        id: "r" + Date.now(),
        carId,
        staff,
        weekday,
        ...range,
        weeks: [viewWeek], // クイック登録は今見てる週だけ(単発利用を想定)
        cancelled: [],
      },
    ]);
    setMessage({
      type: "ok",
      text: `${staff} / ${CARS.find((c) => c.id === carId)?.name} / 第${viewWeek}週${weekday}曜 ${fmtTime(
        range.start
      )}〜 に登録しました`,
    });
    setQuickAdd(null);
  }

  // ---------- ブロック削除/キャンセル ----------
  function handleBlockTap(r) {
    dispatchDialog({ type: "open-details", reservation: r });
  }

  function saveDetails() {
    if (!detailsTarget || dialog.kind !== "details") return;
    if (!detailsTimeValidation?.ok) {
      setMessage({ type: "error", text: detailsTimeValidation?.error ?? "時刻を確認してください" });
      return;
    }
    const range = detailsTimeValidation.range;
    const candidate = {
      carId: dialog.draft.carId,
      weekday: dialog.draft.weekday,
      ...range,
    };
    const rangeValidation = validateReservationCandidate([], candidate, [viewWeek], TIME_RULES);
    if (!rangeValidation.ok) {
      setMessage({ type: "error", text: rangeValidation.reason });
      return;
    }

    dispatchDialog({ type: "close" });
    if (reservationMatchesCandidate(detailsTarget, candidate)) return;
    if (needsReservationChangeScope(detailsTarget)) {
      setChangeTarget({ r: detailsTarget, candidate, operation: "edit" });
      return;
    }
    applyChangeAllWeeks(detailsTarget, candidate, "edit");
  }

  function requestDeleteFromDetails() {
    dispatchDialog({ type: "request-delete" });
  }

  function cancelThisWeekOnly() {
    if (!deleteTarget) return;
    setReservations((rs) =>
      rs.map((x) =>
        x.id === deleteTarget.id
          ? { ...x, cancelled: [...x.cancelled, String(viewWeek)] }
          : x
      )
    );
    setMessage({
      type: "ok",
      text: `${deleteTarget.staff} の第${viewWeek}週${deleteTarget.weekday}曜をキャンセルしました`,
    });
    dispatchDialog({ type: "close" });
  }

  function deleteEntirely() {
    if (!deleteTarget) return;
    setReservations((rs) => rs.filter((x) => x.id !== deleteTarget.id));
    setMessage({ type: "ok", text: `${deleteTarget.staff} の予約を削除しました` });
    dispatchDialog({ type: "close" });
  }

  // ---------- Pointer Eventsによる移動・左右リサイズ ----------
  function minuteAt(clientX, laneRect) {
    return DAY_START + ((clientX - laneRect.left) / laneRect.width) * totalMin;
  }

  function laneAtPoint(clientX, clientY) {
    return document
      .elementsFromPoint(clientX, clientY)
      .map((element) => element.closest?.('[data-car-lane="true"]'))
      .find(Boolean);
  }

  function previewFor(candidate, reservation, laneElement, operation) {
    const rect = laneElement.getBoundingClientRect();
    return {
      id: reservation.id,
      staff: reservation.staff,
      operation,
      candidate,
      color: CARS.find((car) => car.id === candidate.carId)?.color ?? "#33475B",
      left: rect.left + (timelinePercent(candidate.start, facilityHours) / 100) * rect.width,
      top: rect.top + 4,
      width: (candidate.duration / totalMin) * rect.width,
      height: Math.max(20, rect.height - 8),
    };
  }

  function onReservationPointerDown(event, reservation, operation) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    const barElement = event.currentTarget.closest('[data-reservation-bar="true"]');
    const laneElement = barElement?.closest('[data-car-lane="true"]');
    if (!barElement || !laneElement) return;

    const laneRect = laneElement.getBoundingClientRect();
    const pointerMinute = minuteAt(event.clientX, laneRect);
    const candidate = {
      carId: reservation.carId,
      weekday: reservation.weekday,
      start: reservation.start,
      duration: reservation.duration,
    };
    barElement.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      reservation,
      operation,
      originX: event.clientX,
      originY: event.clientY,
      grabOffsetMin: pointerMinute - reservation.start,
      originLane: laneElement,
      targetLane: laneElement,
      candidate,
      moved: false,
    };
    setPointerPreview(previewFor(candidate, reservation, laneElement, operation));
  }

  function onReservationPointerMove(event) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();

    if (Math.hypot(event.clientX - drag.originX, event.clientY - drag.originY) >= 3) {
      drag.moved = true;
    }
    if (!drag.moved) return;

    let laneElement = drag.originLane;
    let range;
    if (drag.operation === "move") {
      laneElement = laneAtPoint(event.clientX, event.clientY) ?? drag.targetLane;
      drag.targetLane = laneElement;
      const rawStart = minuteAt(event.clientX, laneElement.getBoundingClientRect()) - drag.grabOffsetMin;
      range = moveReservationRange(drag.reservation, rawStart, TIME_RULES);
    } else if (drag.operation === "resize-left") {
      range = resizeReservationLeft(
        drag.reservation,
        minuteAt(event.clientX, drag.originLane.getBoundingClientRect()),
        TIME_RULES,
      );
    } else {
      range = resizeReservationRight(
        drag.reservation,
        minuteAt(event.clientX, drag.originLane.getBoundingClientRect()),
        TIME_RULES,
      );
    }

    const candidate = {
      carId: drag.operation === "move" ? laneElement.dataset.carId : drag.reservation.carId,
      weekday: drag.operation === "move" ? laneElement.dataset.weekday : drag.reservation.weekday,
      ...range,
    };
    drag.candidate = candidate;
    setPointerPreview(previewFor(candidate, drag.reservation, laneElement, drag.operation));
  }

  function onReservationPointerUp(event) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = null;
    setPointerPreview(null);

    suppressClickUntilRef.current = Date.now() + 500;
    if (!drag.moved) {
      handleBlockTap(drag.reservation);
      return;
    }
    if (reservationMatchesCandidate(drag.reservation, drag.candidate)) return;
    if (needsReservationChangeScope(drag.reservation)) {
      setChangeTarget({
        r: drag.reservation,
        candidate: drag.candidate,
        operation: drag.operation,
      });
      return;
    }
    applyChangeAllWeeks(drag.reservation, drag.candidate, drag.operation);
  }

  function onReservationPointerCancel(event) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setPointerPreview(null);
  }

  function handleReservationClick(event, reservation) {
    event.stopPropagation();
    if (Date.now() < suppressClickUntilRef.current) return;
    handleBlockTap(reservation);
  }

  function operationLabel(operation) {
    if (operation === "move") return "移動";
    if (operation === "edit") return "変更";
    return "時間変更";
  }

  function conflictMessage(validation, candidate, operation) {
    if (!validation.conflict) return `${operationLabel(operation)}できません: ${validation.reason}`;
    const { conflict } = validation;
    const carName = CARS.find((car) => car.id === candidate.carId)?.name;
    return `${operationLabel(operation)}できません: 第${conflict.week}週${candidate.weekday}曜の${carName}で、${
      conflict.hit.staff
    }（${fmtTime(conflict.hit.start)}〜${fmtTime(
      conflict.hit.start + conflict.hit.duration,
    )}）と重なります`;
  }

  // 全週まとめて変更。単発予約も同じ共通検証を通る。
  function applyChangeAllWeeks(reservation, candidate, operation) {
    const activeWeeks = reservation.weeks.filter(
      (week) => !reservation.cancelled.includes(String(week)),
    );
    const validation = validateReservationChange(
      reservations,
      reservation,
      candidate,
      activeWeeks,
      TIME_RULES,
    );
    if (!validation.ok) {
      setMessage({ type: "error", text: conflictMessage(validation, candidate, operation) });
      setChangeTarget(null);
      return;
    }

    setReservations((current) =>
      current.map((item) => (item.id === reservation.id ? { ...item, ...candidate } : item)),
    );
    setMessage({
      type: "ok",
      text: `${reservation.staff} の利用を ${CARS.find((car) => car.id === candidate.carId)?.name} / ${
        candidate.weekday
      }曜 ${fmtTime(candidate.start)}〜${fmtTime(candidate.start + candidate.duration)} に${
        operationLabel(operation)
      }しました${reservation.weeks.length > 1 ? "（全週）" : ""}`,
    });
    setChangeTarget(null);
  }

  // この週だけ変更 = 元の定期から今週分をキャンセルし、候補位置に単発予約を作る。
  function applyChangeThisWeekOnly() {
    if (!changeTarget) return;
    const { r: reservation, candidate, operation } = changeTarget;
    const validation = validateReservationChange(
      reservations,
      reservation,
      candidate,
      [viewWeek],
      TIME_RULES,
    );
    if (!validation.ok) {
      setMessage({ type: "error", text: conflictMessage(validation, candidate, operation) });
      setChangeTarget(null);
      return;
    }

    setReservations((current) => [
      ...current.map((item) =>
        item.id === reservation.id
          ? {
              ...item,
              cancelled: item.cancelled.includes(String(viewWeek))
                ? item.cancelled
                : [...item.cancelled, String(viewWeek)],
            }
          : item,
      ),
      {
        id: `r${Date.now()}`,
        ...candidate,
        staff: reservation.staff,
        weeks: [viewWeek],
        cancelled: [],
      },
    ]);
    setMessage({
      type: "ok",
      text: `${reservation.staff} の第${viewWeek}週分だけを ${candidate.weekday}曜 ${fmtTime(
        candidate.start,
      )}〜${fmtTime(candidate.start + candidate.duration)} に${operationLabel(operation)}しました`,
    });
    setChangeTarget(null);
  }

  return (
    <div
      className="min-h-screen bg-[#EFE8D8] text-[#2B2620] font-sans pb-10"
      style={{
        backgroundImage: "radial-gradient(circle at 1px 1px, rgba(43,38,32,0.05) 1px, transparent 0)",
        backgroundSize: "18px 18px",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Shippori+Mincho:wght@600;800&family=Zen+Kaku+Gothic+New:wght@400;500;700&family=JetBrains+Mono:wght@400;600&display=swap');
        .f-display { font-family: 'Shippori Mincho', serif; }
        .f-body { font-family: 'Zen Kaku Gothic New', sans-serif; }
        .f-mono { font-family: 'JetBrains Mono', monospace; }
      
        /* fallback for tailwind arbitrary-value classes (not compiled in this environment) */
        .bg-\[\#33475B\] { background-color: #33475B !important; }
        .bg-\[\#5E7A3A\]\/10 { background-color: rgba(94,122,58,0.1) !important; }
        .bg-\[\#BF3B2C\] { background-color: #BF3B2C !important; }
        .bg-\[\#BF3B2C\]\/10 { background-color: rgba(191,59,44,0.1) !important; }
        .bg-\[\#C6901F\] { background-color: #C6901F !important; }
        .bg-\[\#EFE8D8\] { background-color: #EFE8D8 !important; }
        .bg-\[\#EFE8D8\]\/60 { background-color: rgba(239,232,216,0.6) !important; }
        .bg-\[\#FBF9F4\] { background-color: #FBF9F4 !important; }
        .border-\[\#2B2620\]\/20 { border-color: rgba(43,38,32,0.2) !important; }
        .border-\[\#33475B\] { border-color: #33475B !important; }
        .border-\[\#33475B\]\/20 { border-color: rgba(51,71,91,0.2) !important; }
        .border-\[\#33475B\]\/40 { border-color: rgba(51,71,91,0.4) !important; }
        .border-\[\#BF3B2C\] { border-color: #BF3B2C !important; }
        .border-\[\#BF3B2C\]\/40 { border-color: rgba(191,59,44,0.4) !important; }
        .min-w-\[520px\] { min-width: 520px; }
        .text-\[\#2B2620\] { color: #2B2620 !important; }
        .text-\[\#2B2620\]\/40 { color: rgba(43,38,32,0.4) !important; }
        .text-\[\#2B2620\]\/50 { color: rgba(43,38,32,0.5) !important; }
        .text-\[\#33475B\] { color: #33475B !important; }
        .text-\[\#33475B\]\/60 { color: rgba(51,71,91,0.6) !important; }
        .text-\[\#33475B\]\/70 { color: rgba(51,71,91,0.7) !important; }
        .text-\[\#3E5226\] { color: #3E5226 !important; }
        .text-\[\#BF3B2C\] { color: #BF3B2C !important; }
        .text-\[\#FBF0DA\]\/70 { color: rgba(251,240,218,0.7) !important; }
        .text-\[\#FBF9F4\] { color: #FBF9F4 !important; }
        .text-\[\#FBF9F4\]\/60 { color: rgba(251,249,244,0.6) !important; }
        .text-\[10px\] { font-size: 10px; line-height: 1.4; }
        .tracking-\[0\.2em\] { letter-spacing: 0.2em; }
      `}</style>

      <header className="bg-[#33475B] text-[#FBF9F4] f-body">
        <div className="max-w-3xl mx-auto px-5 py-5">
          <p className="text-xs tracking-[0.2em] text-[#FBF0DA]/70 mb-1">CAR USAGE BOARD</p>
          <h1 className="f-display text-2xl font-bold">社用車 利用ボード</h1>
          <p className="text-xs text-[#FBF9F4]/60 mt-1">
            バー中央をドラッグで移動・左右端をドラッグで時間変更・タップで詳細編集
          </p>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-6 space-y-5 f-body">
        {/* 週切り替え */}
        <div className="flex gap-2">
          {WEEKS.map((w) => (
            <button
              key={w}
              onClick={() => setViewWeek(w)}
              className={`text-sm px-4 py-1.5 rounded-md ${
                viewWeek === w ? "bg-[#33475B] text-[#FBF9F4]" : "bg-[#FBF9F4] text-[#33475B]"
              }`}
            >
              第{w}週
            </button>
          ))}
        </div>

        <div className="bg-[#FBF9F4] rounded-lg px-4 py-3 border border-[#33475B]/15 text-xs flex items-center justify-between gap-3 flex-wrap">
          <span>
            本日: <strong>{today.year}年{today.month}月{today.day}日（{today.weekday}）</strong>
          </span>
          <span className={viewWeek === today.weekOfMonth ? "text-[#BF3B2C] font-semibold" : "text-[#2B2620]/50"}>
            {viewWeek === today.weekOfMonth
              ? `現在の第${viewWeek}週を表示中`
              : `表示中は第${viewWeek}週（本日は第${today.weekOfMonth}週）`}
          </span>
        </div>

        {/* 曜日×車のタイムテーブル */}
        {WEEKDAYS.map((wd) => {
          const todaySection = isTodayLane(viewWeek, wd, now);
          return (
          <section
            key={wd}
            ref={todaySection ? todaySectionRef : null}
            className={`rounded-lg p-3 shadow-sm border-2 ${
              todaySection
                ? "bg-[#FFF8E8] border-[#C6901F]/60"
                : "bg-[#FBF9F4] border-transparent"
            }`}
          >
            <h2 className="text-sm font-semibold text-[#33475B]/70 mb-2 flex items-center gap-2">
              {wd}曜日
              {todaySection && <span className="text-[10px] bg-[#C6901F] text-white px-2 py-0.5 rounded-full">今日</span>}
            </h2>
            <div className="overflow-x-auto">
              <div className="min-w-[520px]">
                <div className="flex ml-14 mb-1">
                  {Array.from({ length: Math.floor(totalMin / 120) + 1 }, (_, i) => (
                    <div key={i} className="flex-1 text-[10px] f-mono text-[#2B2620]/40">
                      {fmtTime(DAY_START + i * 120)}
                    </div>
                  ))}
                </div>
                {CARS.map((car) => (
                  <div key={car.id} className="flex items-center mb-1.5">
                    <div className="w-14 shrink-0 text-xs flex items-center gap-1">
                      <span className="w-2 h-2 rounded-full" style={{ background: car.color }} />
                      {car.name}
                    </div>
                    <div
                      data-car-lane="true"
                      data-car-id={car.id}
                      data-weekday={wd}
                      className="relative flex-1 h-9 bg-[#EFE8D8]/60 rounded-md cursor-pointer"
                      onClick={(e) => handleLaneTap(e, car.id, wd)}
                    >
                      {todaySection && today.minuteOfDay >= DAY_START && today.minuteOfDay <= DAY_END && (
                        <span
                          className="absolute top-0 bottom-0 w-px bg-[#BF3B2C] z-10 pointer-events-none"
                          style={{ left: `${timelinePercent(today.minuteOfDay, facilityHours)}%` }}
                          title={`現在 ${fmtTime(today.minuteOfDay)}`}
                        />
                      )}
                      {activeOn(reservations, car.id, viewWeek, wd).map((r) => {
                        const left = timelinePercent(r.start, facilityHours);
                        const width = (r.duration / totalMin) * 100;
                        return (
                          <button
                            key={r.id}
                            type="button"
                            data-reservation-bar="true"
                            onPointerDown={(event) => onReservationPointerDown(event, r, "move")}
                            onPointerMove={onReservationPointerMove}
                            onPointerUp={onReservationPointerUp}
                            onPointerCancel={onReservationPointerCancel}
                            onClick={(event) => handleReservationClick(event, r)}
                            title="中央をドラッグで移動 / 左右端をドラッグで時間変更 / タップで詳細編集"
                            className="absolute top-1 bottom-1 rounded-md text-[10px] text-[#FBF9F4] px-3 overflow-hidden whitespace-nowrap cursor-grab active:cursor-grabbing"
                            style={{
                              left: `${left}%`,
                              width: `${width}%`,
                              background: car.color,
                              opacity: pointerPreview?.id === r.id ? 0.3 : 1,
                              touchAction: "pan-y",
                            }}
                          >
                            <span
                              onPointerDown={(event) => onReservationPointerDown(event, r, "resize-left")}
                              className="absolute inset-y-0 left-0 w-2 cursor-ew-resize bg-white/25 border-r border-white/40"
                            />
                            <span className="pointer-events-none">
                              {r.staff} {fmtTime(r.start)}〜{fmtTime(r.start + r.duration)}
                              {r.weeks.length === 4 && " ♺"}
                            </span>
                            <span
                              onPointerDown={(event) => onReservationPointerDown(event, r, "resize-right")}
                              className="absolute inset-y-0 right-0 w-2 cursor-ew-resize bg-white/25 border-l border-white/40"
                            />
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>
          );
        })}

        {/* 新規登録 */}
        <section className="bg-[#FBF9F4] rounded-lg p-4 shadow-sm space-y-3">
          <h2 className="text-sm font-semibold text-[#33475B]/70">新規登録</h2>

          <div className="space-y-3 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-[#2B2620]/50">
                利用者(スタッフ名)
                <input
                  value={form.staff}
                  onChange={(e) => setForm({ ...form, staff: e.target.value })}
                  placeholder="PT_A"
                  className="w-full mt-1 px-2 py-1.5 rounded-md border border-[#33475B]/20 bg-white outline-none"
                />
              </label>
              <label className="text-xs text-[#2B2620]/50">
                車両
                <select
                  value={form.carId}
                  onChange={(e) => setForm({ ...form, carId: e.target.value })}
                  className="w-full mt-1 px-2 py-1.5 rounded-md border border-[#33475B]/20 bg-white outline-none"
                >
                  {CARS.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="text-xs text-[#2B2620]/50">
              曜日(複数可)
              <div className="flex gap-1 mt-1">
                {WEEKDAYS.map((w) => {
                  const on = form.weekdays.includes(w);
                  return (
                    <button
                      key={w}
                      type="button"
                      onClick={() =>
                        setForm((f) => ({
                          ...f,
                          weekdays: on ? f.weekdays.filter((x) => x !== w) : [...f.weekdays, w],
                        }))
                      }
                      className={`flex-1 text-sm py-1.5 rounded-md border ${
                        on
                          ? "bg-[#33475B] text-[#FBF9F4] border-[#33475B]"
                          : "border-[#33475B]/20 text-[#33475B]/60 bg-white"
                      }`}
                    >
                      {w}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <label className="text-xs text-[#2B2620]/50">
                開始時刻
                <input
                  type="time"
                  min={minutesToTimeValue(DAY_START)}
                  max={minutesToTimeValue(DAY_END - CAR_FACILITY_SETTINGS.minDuration)}
                  step={SNAP_MIN * 60}
                  value={form.startTime}
                  onChange={(event) => setForm({ ...form, startTime: event.target.value })}
                  className="w-full mt-1 px-2 py-1.5 rounded-md border border-[#33475B]/20 bg-white outline-none f-mono"
                />
              </label>
              <label className="text-xs text-[#2B2620]/50">
                終了時刻
                <input
                  type="time"
                  min={minutesToTimeValue(DAY_START + CAR_FACILITY_SETTINGS.minDuration)}
                  max={minutesToTimeValue(DAY_END)}
                  step={SNAP_MIN * 60}
                  value={form.endTime}
                  onChange={(event) => setForm({ ...form, endTime: event.target.value })}
                  className="w-full mt-1 px-2 py-1.5 rounded-md border border-[#33475B]/20 bg-white outline-none f-mono"
                />
              </label>
              <label className="text-xs text-[#2B2620]/50 flex items-end pb-2">
                <span className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.repeat}
                    onChange={(e) => setForm({ ...form, repeat: e.target.checked })}
                    className="w-4 h-4"
                  />
                  毎週繰り返す
                </span>
              </label>
            </div>

            {!formTimeValidation.ok && (
              <p className="text-xs text-[#BF3B2C] -mt-1" role="alert">
                {formTimeValidation.error}
              </p>
            )}

            <div className="flex gap-2 pt-1">
              <button
                onClick={tryAdd}
                disabled={!formTimeValidation.ok || form.weekdays.length === 0}
                className="bg-[#BF3B2C] text-[#FBF9F4] text-sm font-medium px-5 py-2 rounded-md disabled:opacity-40 disabled:cursor-not-allowed"
              >
                登録
              </button>
              <button
                onClick={suggestCar}
                disabled={!formTimeValidation.ok || form.weekdays.length === 0}
                className="border border-[#33475B]/40 text-[#33475B] text-sm px-4 py-2 rounded-md disabled:opacity-40 disabled:cursor-not-allowed"
              >
                空いてる車を探す
              </button>
            </div>

            {message && (
              <p
                className={`text-xs px-3 py-2 rounded-md ${
                  message.type === "error"
                    ? "bg-[#BF3B2C]/10 text-[#BF3B2C]"
                    : "bg-[#5E7A3A]/10 text-[#3E5226]"
                }`}
              >
                {message.text}
              </p>
            )}
          </div>
        </section>
      </main>

      {pointerPreview && (
        <>
          <div
            className="fixed z-[60] rounded-md text-[10px] text-white px-2 flex items-center justify-center whitespace-nowrap shadow-lg"
            style={{
              pointerEvents: "none",
              left: pointerPreview.left,
              top: pointerPreview.top,
              width: pointerPreview.width,
              height: pointerPreview.height,
              background: pointerPreview.color,
              opacity: 0.9,
            }}
          >
            {pointerPreview.staff}
          </div>
          <div
            className="fixed z-[61] rounded bg-[#2B2620] text-white text-xs f-mono px-2 py-1 shadow-lg whitespace-nowrap"
            style={{
              pointerEvents: "none",
              left: pointerPreview.left + pointerPreview.width / 2,
              top: Math.max(4, pointerPreview.top - 30),
              transform: "translateX(-50%)",
            }}
          >
            {fmtTime(pointerPreview.candidate.start)}–
            {fmtTime(pointerPreview.candidate.start + pointerPreview.candidate.duration)}
          </div>
        </>
      )}

      {/* クイック登録ポップアップ */}
      {quickAdd && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50 p-4" style={{ background: "rgba(43,38,32,0.55)" }}
          onClick={() => setQuickAdd(null)}
        >
          <div
            className="rounded-lg p-5 w-full max-w-xs shadow-xl f-body" style={{ background: "#FBF9F4" }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="f-display text-lg font-bold text-[#33475B] mb-1">クイック登録</h3>
            <p className="text-xs text-[#2B2620]/50 mb-4">
              {CARS.find((c) => c.id === quickAdd.carId)?.name} / 第{viewWeek}週 {quickAdd.weekday}曜{" "}
              <span className="f-mono">{fmtTime(quickAdd.start)}〜{fmtTime(quickAdd.end)}</span>
            </p>
            <label className="text-xs text-[#2B2620]/50 block mb-3">
              利用者(スタッフ名)
              <input
                autoFocus
                value={quickAdd.staff}
                onChange={(e) => setQuickAdd({ ...quickAdd, staff: e.target.value })}
                onKeyDown={(e) => e.key === "Enter" && confirmQuickAdd()}
                placeholder="PT_A"
                className="w-full mt-1 px-2 py-2 rounded-md border border-[#33475B]/20 bg-white outline-none text-sm"
              />
            </label>
            <div className="grid grid-cols-2 gap-2 mb-3">
              <label className="text-xs text-[#2B2620]/50">
                開始時刻
                <input
                  type="time"
                  min={minutesToTimeValue(DAY_START)}
                  max={minutesToTimeValue(DAY_END - CAR_FACILITY_SETTINGS.minDuration)}
                  step={SNAP_MIN * 60}
                  value={minutesToTimeValue(quickAdd.start)}
                  onChange={(event) =>
                    setQuickAdd({ ...quickAdd, start: timeValueToMinutes(event.target.value) })
                  }
                  className="w-full mt-1 px-2 py-1.5 rounded-md border border-[#33475B]/20 bg-white f-mono"
                />
              </label>
              <label className="text-xs text-[#2B2620]/50">
                終了時刻
                <input
                  type="time"
                  min={minutesToTimeValue(DAY_START + CAR_FACILITY_SETTINGS.minDuration)}
                  max={minutesToTimeValue(DAY_END)}
                  step={SNAP_MIN * 60}
                  value={minutesToTimeValue(quickAdd.end)}
                  onChange={(event) =>
                    setQuickAdd({ ...quickAdd, end: timeValueToMinutes(event.target.value) })
                  }
                  className="w-full mt-1 px-2 py-1.5 rounded-md border border-[#33475B]/20 bg-white f-mono"
                />
              </label>
            </div>
            {!quickTimeValidation?.ok && (
              <p className="text-xs text-[#BF3B2C] mb-3" role="alert">
                {quickTimeValidation?.error}
              </p>
            )}
            <div className="text-xs text-[#2B2620]/50 block mb-4">
              時間帯の初期値
              <div className="flex gap-1 mt-1 flex-wrap">
                {["morning", "afternoon", "allDay"].map((name) => {
                  const preset = facilityPresetRange(name);
                  const label = name === "allDay"
                    ? "終日"
                    : CAR_FACILITY_SETTINGS.timePresets[name].label;
                  const active = quickAdd.start === preset.start && quickAdd.end === preset.end;
                  return (
                  <button
                    key={name}
                    type="button"
                    onClick={() => applyQuickPreset(name)}
                    className={`flex-1 text-xs py-1.5 rounded-md border ${
                      active
                        ? "bg-[#33475B] text-[#FBF9F4] border-[#33475B]"
                        : "border-[#33475B]/20 text-[#33475B]/60 bg-white"
                    }`}
                  >
                    {label}
                  </button>
                  );
                })}
              </div>
              <p className="mt-2">初期値を選んだ後も開始・終了時刻を変更できます。</p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={confirmQuickAdd}
                disabled={!quickTimeValidation?.ok}
                className="flex-1 bg-[#BF3B2C] text-[#FBF9F4] text-sm font-medium py-2 rounded-md disabled:opacity-40 disabled:cursor-not-allowed"
              >
                この枠で登録
              </button>
              <button
                onClick={() => setQuickAdd(null)}
                className="px-4 border border-[#2B2620]/20 text-[#2B2620]/50 text-sm rounded-md"
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 予約詳細・編集モーダル */}
      {detailsTarget && dialog.kind === "details" && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50 p-4"
          style={{ background: "rgba(43,38,32,0.55)" }}
          onClick={() => dispatchDialog({ type: "close" })}
        >
          <div
            className="rounded-lg p-5 w-full max-w-sm shadow-xl f-body"
            style={{ background: "#FBF9F4" }}
            onClick={(event) => event.stopPropagation()}
          >
            <h3 className="f-display text-lg font-bold text-[#33475B] mb-1">予約詳細・編集</h3>
            <p className="text-sm mb-4">{detailsTarget.staff}</p>
            <div className="grid grid-cols-2 gap-3 mb-3">
              <label className="text-xs text-[#2B2620]/50">
                車両
                <select
                  value={dialog.draft.carId}
                  onChange={(event) =>
                    dispatchDialog({ type: "update-draft", patch: { carId: event.target.value } })
                  }
                  className="w-full mt-1 px-2 py-1.5 rounded-md border border-[#33475B]/20 bg-white"
                >
                  {CARS.map((car) => <option key={car.id} value={car.id}>{car.name}</option>)}
                </select>
              </label>
              <label className="text-xs text-[#2B2620]/50">
                曜日
                <select
                  value={dialog.draft.weekday}
                  onChange={(event) =>
                    dispatchDialog({ type: "update-draft", patch: { weekday: event.target.value } })
                  }
                  className="w-full mt-1 px-2 py-1.5 rounded-md border border-[#33475B]/20 bg-white"
                >
                  {WEEKDAYS.map((weekday) => <option key={weekday} value={weekday}>{weekday}曜日</option>)}
                </select>
              </label>
              <label className="text-xs text-[#2B2620]/50">
                開始時刻
                <input
                  type="time"
                  min={minutesToTimeValue(DAY_START)}
                  max={minutesToTimeValue(DAY_END - CAR_FACILITY_SETTINGS.minDuration)}
                  step={SNAP_MIN * 60}
                  value={dialog.draft.startTime}
                  onChange={(event) =>
                    dispatchDialog({ type: "update-draft", patch: { startTime: event.target.value } })
                  }
                  className="w-full mt-1 px-2 py-1.5 rounded-md border border-[#33475B]/20 bg-white f-mono"
                />
              </label>
              <label className="text-xs text-[#2B2620]/50">
                終了時刻
                <input
                  type="time"
                  min={minutesToTimeValue(DAY_START + CAR_FACILITY_SETTINGS.minDuration)}
                  max={minutesToTimeValue(DAY_END)}
                  step={SNAP_MIN * 60}
                  value={dialog.draft.endTime}
                  onChange={(event) =>
                    dispatchDialog({ type: "update-draft", patch: { endTime: event.target.value } })
                  }
                  className="w-full mt-1 px-2 py-1.5 rounded-md border border-[#33475B]/20 bg-white f-mono"
                />
              </label>
            </div>
            {!detailsTimeValidation?.ok && (
              <p className="text-xs text-[#BF3B2C] mb-3" role="alert">
                {detailsTimeValidation?.error}
              </p>
            )}
            {needsReservationChangeScope(detailsTarget) && (
              <p className="text-[11px] text-[#2B2620]/45 mb-3">定期予約です。保存後に変更範囲を選択します。</p>
            )}
            <div className="space-y-2">
              <button
                onClick={saveDetails}
                disabled={!detailsTimeValidation?.ok}
                className="w-full bg-[#33475B] text-white text-sm font-medium py-2 rounded-md disabled:opacity-40 disabled:cursor-not-allowed"
              >
                変更を保存
              </button>
              <button
                onClick={requestDeleteFromDetails}
                className="w-full border border-[#BF3B2C]/40 text-[#BF3B2C] text-sm py-2 rounded-md"
              >
                この予約を削除
              </button>
              <button
                onClick={() => dispatchDialog({ type: "close" })}
                className="w-full border border-[#2B2620]/20 text-[#2B2620]/50 text-sm py-2 rounded-md"
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 削除確認モーダル */}
      {deleteTarget && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50 p-4" style={{ background: "rgba(43,38,32,0.55)" }}
          onClick={() => dispatchDialog({ type: "close" })}
        >
          <div
            className="rounded-lg p-5 w-full max-w-xs shadow-xl f-body" style={{ background: "#FBF9F4" }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="f-display text-lg font-bold text-[#33475B] mb-1">予約の削除</h3>
            <p className="text-sm mb-1">{deleteTarget.staff}</p>
            <p className="text-xs text-[#2B2620]/50 mb-4">
              {CARS.find((c) => c.id === deleteTarget.carId)?.name} / {deleteTarget.weekday}曜{" "}
              <span className="f-mono">
                {fmtTime(deleteTarget.start)}〜{fmtTime(deleteTarget.start + deleteTarget.duration)}
              </span>
              {deleteTarget.weeks.length > 1 && "（毎週の定期利用）"}
            </p>
            <div className="space-y-2">
              {deleteTarget.weeks.length > 1 ? (
                <>
                  <button
                    onClick={cancelThisWeekOnly}
                    className="w-full bg-[#C6901F] text-[#FBF9F4] text-sm font-medium py-2 rounded-md"
                  >
                    第{viewWeek}週だけ削除
                  </button>
                  <button
                    onClick={deleteEntirely}
                    className="w-full bg-[#BF3B2C] text-[#FBF9F4] text-sm font-medium py-2 rounded-md"
                  >
                    定期利用すべて削除
                  </button>
                </>
              ) : (
                <button
                  onClick={deleteEntirely}
                  className="w-full bg-[#BF3B2C] text-[#FBF9F4] text-sm font-medium py-2 rounded-md"
                >
                  この予約を削除
                </button>
              )}
              <button
                onClick={() => dispatchDialog({ type: "close" })}
                className="w-full border border-[#2B2620]/20 text-[#2B2620]/50 text-sm py-2 rounded-md"
              >
                やめる
              </button>
            </div>
          </div>
        </div>
      )}
      {/* 定期予約の変更範囲確認モーダル */}
      {changeTarget && (
        <div
          className="fixed inset-0 flex items-center justify-center z-50 p-4" style={{ background: "rgba(43,38,32,0.55)" }}
          onClick={() => setChangeTarget(null)}
        >
          <div
            className="rounded-lg p-5 w-full max-w-xs shadow-xl f-body" style={{ background: "#FBF9F4" }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="f-display text-lg font-bold text-[#33475B] mb-1">
              定期利用の{operationLabel(changeTarget.operation)}
            </h3>
            <p className="text-sm mb-1">{changeTarget.r.staff}</p>
            <p className="text-xs text-[#2B2620]/50 mb-4">
              {CARS.find((c) => c.id === changeTarget.candidate.carId)?.name} / {changeTarget.candidate.weekday}曜{" "}
              <span className="f-mono">
                {fmtTime(changeTarget.candidate.start)}〜
                {fmtTime(changeTarget.candidate.start + changeTarget.candidate.duration)}
              </span>
              に変更します
            </p>
            <div className="space-y-2">
              <button
                onClick={applyChangeThisWeekOnly}
                className="w-full bg-[#C6901F] text-[#FBF9F4] text-sm font-medium py-2 rounded-md"
              >
                第{viewWeek}週だけ変更
              </button>
              <button
                onClick={() =>
                  applyChangeAllWeeks(
                    changeTarget.r,
                    changeTarget.candidate,
                    changeTarget.operation,
                  )
                }
                className="w-full bg-[#33475B] text-[#FBF9F4] text-sm font-medium py-2 rounded-md"
              >
                毎週まとめて変更
              </button>
              <button
                onClick={() => setChangeTarget(null)}
                className="w-full border border-[#2B2620]/20 text-[#2B2620]/50 text-sm py-2 rounded-md"
              >
                やめる
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

import { CAR_FACILITY_SETTINGS } from "../config/car-facility.mjs";

export const CAR_DAY_START = CAR_FACILITY_SETTINGS.facilityHours.dayStart;
export const CAR_DAY_END = CAR_FACILITY_SETTINGS.facilityHours.dayEnd;
export const CAR_SNAP_MIN = CAR_FACILITY_SETTINGS.snapMinutes;
export const CAR_MIN_DURATION = CAR_FACILITY_SETTINGS.minDuration;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(value, maximum));
}

function resolvedRules(options = {}) {
  const facilityHours = options.facilityHours ?? CAR_FACILITY_SETTINGS.facilityHours;
  return {
    dayStart: options.dayStart ?? facilityHours.dayStart,
    dayEnd: options.dayEnd ?? facilityHours.dayEnd,
    snap: options.snap ?? CAR_FACILITY_SETTINGS.snapMinutes,
    minDuration: options.minDuration ?? CAR_FACILITY_SETTINGS.minDuration,
  };
}

export function snapToMinutes(value, step = CAR_SNAP_MIN) {
  return Math.round(value / step) * step;
}

export function timeValueToMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value ?? "");
  if (!match) return Number.NaN;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function minutesToTimeValue(minutes) {
  if (!Number.isFinite(minutes)) return "";
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function rangeFromStartEnd(start, end) {
  return { start, duration: end - start };
}

export function validateTimeRange(start, end, options = {}) {
  const { dayStart, dayEnd, snap, minDuration } = resolvedRules(options);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return { ok: false, error: "開始時刻と終了時刻を入力してください" };
  }
  if (end <= start) {
    return { ok: false, error: "終了時刻は開始時刻より後にしてください" };
  }
  if (end - start < minDuration) {
    return { ok: false, error: `利用時間は${minDuration}分以上にしてください` };
  }
  if (start < dayStart || end > dayEnd) {
    return {
      ok: false,
      error: `利用可能時間は${minutesToTimeValue(dayStart)}〜${minutesToTimeValue(dayEnd)}です`,
    };
  }
  if (start % snap !== 0 || end % snap !== 0) {
    return { ok: false, error: `${snap}分単位で指定してください` };
  }
  return { ok: true, range: rangeFromStartEnd(start, end) };
}

export function facilityPresetRange(name, settings = CAR_FACILITY_SETTINGS) {
  const { facilityHours, timePresets } = settings;
  if (name === "allDay") {
    return { start: facilityHours.dayStart, end: facilityHours.dayEnd };
  }
  const preset = timePresets[name];
  if (!preset) return null;
  return {
    start: Math.max(facilityHours.dayStart, preset.start),
    end: Math.min(facilityHours.dayEnd, preset.end),
  };
}

export function timelinePercent(minute, facilityHours = CAR_FACILITY_SETTINGS.facilityHours) {
  return ((minute - facilityHours.dayStart) / (facilityHours.dayEnd - facilityHours.dayStart)) * 100;
}

export function carBoardToday(now) {
  const date = new Date(now);
  const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
    weekday: weekdays[date.getDay()],
    weekOfMonth: Math.ceil(date.getDate() / 7),
    minuteOfDay: date.getHours() * 60 + date.getMinutes(),
  };
}

export function isTodayLane(viewWeek, weekday, now) {
  const today = carBoardToday(now);
  return today.weekOfMonth === viewWeek && today.weekday === weekday;
}

export function initialCarBoardWeek(now, availableWeeks = [1, 2, 3, 4, 5]) {
  const week = carBoardToday(now).weekOfMonth;
  return availableWeeks.includes(week) ? week : availableWeeks[0];
}

// 現行ボードの第N週は1〜7日、8〜14日…を表す。
// 当月の各週・曜日を実日付へ変換し、存在しない日と過去の開始日時を除く。
export function futureBulkCandidates({ carId, weekdays, weeks, start, duration }, now) {
  const current = new Date(now);
  const year = current.getFullYear();
  const month = current.getMonth();
  const weekdayNames = ["日", "月", "火", "水", "木", "金", "土"];
  return [...new Set(weekdays)].flatMap((weekday) => {
    const targetDay = weekdayNames.indexOf(weekday);
    if (targetDay < 0) return [];
    const futureWeeks = [...new Set(weeks)].filter((week) => {
      if (!Number.isInteger(week) || week < 1 || week > 5) return false;
      const first = new Date(year, month, (week - 1) * 7 + 1);
      const day = first.getDate() + (targetDay - first.getDay() + 7) % 7;
      const date = new Date(year, month, day);
      if (date.getMonth() !== month) return false;
      date.setMinutes(start);
      return date.getTime() >= current.getTime();
    });
    return futureWeeks.length ? [{ carId, weekday, start, duration, weeks: futureWeeks }] : [];
  });
}

// 候補生成（過去除外）を完了してから、残った週だけを共通検証へ渡す。
export function planBulkReservations(reservations, request, now, options = {}) {
  const candidates = futureBulkCandidates(request, now);
  for (const { weeks, ...candidate } of candidates) {
    const validation = validateReservationCandidate(reservations, candidate, weeks, options);
    if (!validation.ok) return { ...validation, candidates: [] };
  }
  return { ok: true, candidates };
}

export function needsReservationChangeScope(reservation) {
  return reservation.weeks.length > 1;
}

export function reservationMatchesCandidate(reservation, candidate) {
  return (
    reservation.carId === candidate.carId &&
    reservation.weekday === candidate.weekday &&
    reservation.start === candidate.start &&
    reservation.duration === candidate.duration
  );
}

export function reservationDialogReducer(state, action) {
  if (action.type === "open-details") {
    const reservation = action.reservation;
    return {
      kind: "details",
      reservation,
      draft: {
        carId: reservation.carId,
        weekday: reservation.weekday,
        startTime: minutesToTimeValue(reservation.start),
        endTime: minutesToTimeValue(reservation.start + reservation.duration),
      },
    };
  }
  if (action.type === "update-draft" && state.kind === "details") {
    return { ...state, draft: { ...state.draft, ...action.patch } };
  }
  if (action.type === "request-delete" && state.kind === "details") {
    return { kind: "delete", reservation: state.reservation };
  }
  if (action.type === "close") return { kind: "closed" };
  return state;
}

export function moveReservationRange(
  reservation,
  rawStart,
  options = {},
) {
  const { dayStart, dayEnd, snap } = resolvedRules(options);
  const latestStart = dayEnd - reservation.duration;
  const start = clamp(snapToMinutes(rawStart, snap), dayStart, latestStart);
  return { start, duration: reservation.duration };
}

export function resizeReservationRight(
  reservation,
  rawEnd,
  options = {},
) {
  const { dayEnd, snap, minDuration } = resolvedRules(options);
  const end = clamp(
    snapToMinutes(rawEnd, snap),
    reservation.start + minDuration,
    dayEnd,
  );
  return { start: reservation.start, duration: end - reservation.start };
}

export function resizeReservationLeft(
  reservation,
  rawStart,
  options = {},
) {
  const { dayStart, snap, minDuration } = resolvedRules(options);
  const end = reservation.start + reservation.duration;
  const start = clamp(snapToMinutes(rawStart, snap), dayStart, end - minDuration);
  return { start, duration: end - start };
}

// 半開区間 [start, start+dur) 同士の重なり判定。
// aStart + aDur === bStart(ぴったり隣接)は衝突しない。
export function overlaps(aStart, aDur, bStart, bDur) {
  return aStart < bStart + bDur && bStart < aStart + aDur;
}

// 指定の車・週・曜日に有効な予約の一覧
// (キャンセル済み週は除外、ignoreIdはドラッグ移動時の自己除外用)
export function activeOn(reservations, carId, week, weekday, ignoreId = null) {
  return reservations.filter(
    (r) =>
      r.carId === carId &&
      r.weekday === weekday &&
      r.weeks.includes(week) &&
      !r.cancelled.includes(String(week)) &&
      r.id !== ignoreId
  );
}

// 登録候補が全対象週×曜日のどこかで既存予約と衝突するかを調べる。
// 衝突する場合は最初に見つかった { week, weekday, hit } を返す。
export function findConflict(reservations, { carId, weekdays, weeks, start, duration, ignoreId = null }) {
  for (const wd of weekdays) {
    for (const w of weeks) {
      const hit = activeOn(reservations, carId, w, wd, ignoreId).find((r) =>
        overlaps(start, duration, r.start, r.duration)
      );
      if (hit) return { week: w, weekday: wd, hit };
    }
  }
  return null;
}

// 移動・左右リサイズが共通で通す最終検証。
// candidate は { carId, weekday, start, duration } に統一する。
export function validateReservationCandidate(
  reservations,
  candidate,
  weeks,
  options = {},
) {
  const { dayStart, dayEnd, snap, minDuration } = resolvedRules(options);
  const ignoreId = options.ignoreId ?? null;
  if (
    candidate.start < dayStart ||
    candidate.start + candidate.duration > dayEnd ||
    candidate.duration < minDuration
  ) {
    return {
      ok: false,
      reason: `利用可能時間は${minutesToTimeValue(dayStart)}〜${minutesToTimeValue(dayEnd)}、最短利用時間は${minDuration}分です`,
    };
  }
  if (candidate.start % snap !== 0 || candidate.duration % snap !== 0) {
    return { ok: false, reason: `${snap}分単位で指定してください` };
  }

  const conflict = findConflict(reservations, {
    carId: candidate.carId,
    weekdays: [candidate.weekday],
    weeks,
    start: candidate.start,
    duration: candidate.duration,
    ignoreId,
  });
  if (conflict) {
    return { ok: false, reason: "別の予約と重なります", conflict };
  }
  return { ok: true, candidate: { ...candidate } };
}

export function validateReservationChange(
  reservations,
  reservation,
  candidate,
  weeks,
  options = {},
) {
  return validateReservationCandidate(reservations, candidate, weeks, {
    ...options,
    ignoreId: reservation.id,
  });
}

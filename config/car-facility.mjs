export const CAR_FACILITY_SETTINGS = Object.freeze({
  // 0:00からの経過分。24時間運用は dayStart: 0, dayEnd: 1440 とする。
  facilityHours: Object.freeze({
    dayStart: 8 * 60,
    dayEnd: 18 * 60,
  }),
  snapMinutes: 10,
  minDuration: 10,
  // UIの時間帯ショートカット。施設ごとの運用時間へ移す場合もここだけを変更する。
  timePresets: Object.freeze({
    morning: Object.freeze({ label: "午前", start: 8 * 60, end: 12 * 60 }),
    afternoon: Object.freeze({ label: "午後", start: 13 * 60, end: 17 * 60 }),
  }),
});

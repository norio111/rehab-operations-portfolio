function actorName(staff) {
  return staff?.trim() || "担当者未入力";
}

function equipmentIds(row) {
  return row.unreturned_equipment.map((equipment) =>
    typeof equipment === "string" ? equipment : equipment.equipment_id,
  );
}

function localDateParts(value) {
  if (typeof value === "string") {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (match) {
      return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
    }
  }
  const date = new Date(value);
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
}

function calendarDayNumber(value) {
  const { year, month, day } = localDateParts(value);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

export function daysUntilDischarge(dischargePlanned, today) {
  return calendarDayNumber(dischargePlanned) - calendarDayNumber(today);
}

export function dischargeTiming(dischargePlanned, today) {
  const days = daysUntilDischarge(dischargePlanned, today);
  const { year, month, day } = localDateParts(dischargePlanned);
  let relativeLabel;
  if (days === 0) relativeLabel = "本日退院";
  else if (days === 1) relativeLabel = "退院は明日";
  else if (days > 1) relativeLabel = `退院まであと${days}日`;
  else relativeLabel = `退院予定日を${Math.abs(days)}日超過`;

  return {
    days,
    relativeLabel,
    plannedDateLabel: `${year}年${month}月${day}日`,
  };
}

export function requestCollection(row, staff, now) {
  if (row.status !== "pending") return row;
  const actor = actorName(staff);
  const task = {
    id: `collection:${row.patient_id}:${now}`,
    patientId: row.patient_id,
    equipmentIds: equipmentIds(row),
    status: "open",
    requestedBy: actor,
    requestedAt: now,
  };
  return {
    ...row,
    status: "requested",
    collectionTasks: [...(row.collectionTasks ?? []), task],
    history: [
      ...(row.history ?? []),
      { status: "requested", action: "request_collection", staff: actor, at: now },
    ],
  };
}

export function completeReturn(row, staff, now) {
  if (row.status !== "requested") return row;
  const actor = actorName(staff);
  return {
    ...row,
    status: "returned",
    returnedAt: now,
    collectionTasks: (row.collectionTasks ?? []).map((task) =>
      task.status === "open"
        ? { ...task, status: "completed", completedBy: actor, completedAt: now }
        : task,
    ),
    history: [
      ...(row.history ?? []),
      { status: "returned", action: "complete_return", staff: actor, at: now },
    ],
  };
}

export function cancelCollectionRequest(row, staff, now) {
  if (row.status !== "requested") return row;
  const actor = actorName(staff);
  return {
    ...row,
    status: "pending",
    collectionTasks: (row.collectionTasks ?? []).map((task) =>
      task.status === "open"
        ? { ...task, status: "cancelled", cancelledBy: actor, cancelledAt: now }
        : task,
    ),
    history: [
      ...(row.history ?? []),
      { status: "pending", action: "cancel_collection", staff: actor, at: now },
    ],
  };
}

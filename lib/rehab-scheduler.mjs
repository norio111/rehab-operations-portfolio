const MINUTE_MS = 60 * 1000;

function asMinutes(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function cloneEquipment(equipment) {
  return {
    ...equipment,
    inUse: [...(equipment.inUse ?? [])],
    turnovers: (equipment.turnovers ?? []).map((turnover) => ({ ...turnover })),
  };
}

function clonePatient(patient) {
  return { ...patient, items: patient.items.map((item) => ({ ...item })) };
}

export function nextItem(patient) {
  return patient.items.find((item) => item.status !== "done") ?? null;
}

export function eligibleItemFor(patient, equipmentId) {
  if (patient.currentEquipmentId !== null) return null;
  if (patient.orderMode === "flexible") {
    return (
      patient.items.find(
        (item) => item.equipmentId === equipmentId && item.status === "waiting",
      ) ?? null
    );
  }
  const item = nextItem(patient);
  return item?.equipmentId === equipmentId && item.status === "waiting" ? item : null;
}

export function occupiedSlots(equipment) {
  return (equipment.inUse?.length ?? 0) + (equipment.turnovers?.length ?? 0);
}

export function usageTiming(item, now) {
  const durationMs = asMinutes(item.plannedDurationMin) * MINUTE_MS;
  const plannedEndAt = item.plannedEndAt ?? (item.startedAt == null ? null : item.startedAt + durationMs);
  if (plannedEndAt == null) {
    return { plannedEndAt: null, remainingMs: null, overdue: false };
  }
  const remainingMs = plannedEndAt - now;
  return { plannedEndAt, remainingMs, overdue: remainingMs < 0 };
}

function compareCandidates(left, right) {
  const leftWait = left.item.waitingSince ?? Number.POSITIVE_INFINITY;
  const rightWait = right.item.waitingSince ?? Number.POSITIVE_INFINITY;
  return leftWait - rightWait;
}

export function candidatesForEquipment(patients, equipmentId) {
  return patients
    .map((patient) => ({ patient, item: eligibleItemFor(patient, equipmentId) }))
    .filter(({ item }) => item !== null)
    .sort(compareCandidates);
}

export function nextCandidateForEquipment(patients, equipmentId) {
  return candidatesForEquipment(patients, equipmentId)[0] ?? null;
}

// 清掃中の台も占有中として扱い、標準清掃時間が終わるまで患者を割り当てない。
export function runScheduler(equipmentList, patientList, now) {
  const equipment = equipmentList.map(cloneEquipment);
  const patients = patientList.map(clonePatient);

  for (const machine of equipment) {
    // 標準清掃時間を過ぎた台は自動的に利用可能へ戻す。
    machine.turnovers = machine.turnovers.filter(
      (turnover) => (turnover.readyAt ?? Number.POSITIVE_INFINITY) > now,
    );
    let freeSlots = Math.max(0, machine.capacity - occupiedSlots(machine));
    while (freeSlots > 0) {
      const candidate = nextCandidateForEquipment(patients, machine.id);
      if (!candidate) break;

      const { patient, item } = candidate;
      const plannedDurationMin = asMinutes(
        item.plannedDurationMin,
        asMinutes(machine.standardDurationMin),
      );
      item.status = "in_progress";
      item.startedAt = now;
      item.plannedDurationMin = plannedDurationMin;
      item.plannedEndAt = now + plannedDurationMin * MINUTE_MS;
      patient.currentEquipmentId = machine.id;
      patient.idleSince = null;
      machine.inUse.push(patient.id);
      freeSlots -= 1;
    }
  }
  return { eqs: equipment, pats: patients };
}

// 利用終了は台をすぐ解放せず、標準清掃時間を持つ清掃枠へ移す。
export function startTurnover(equipment, patientId, patientNo, now) {
  const next = cloneEquipment(equipment);
  if (!next.inUse.includes(patientId)) return next;

  const turnoverMin = asMinutes(next.turnoverMin);
  next.inUse = next.inUse.filter((id) => id !== patientId);
  next.turnovers.push({
    id: `${next.id}:${patientId}:${now}`,
    patientId,
    patientNo,
    startedAt: now,
    readyAt: now + turnoverMin * MINUTE_MS,
  });
  return next;
}

// 通常運用は自動解放とし、人の操作は清掃延長という例外だけに限定する。
export function extendTurnover(equipment, turnoverId, extraMinutes) {
  const next = cloneEquipment(equipment);
  const extensionMs = asMinutes(extraMinutes) * MINUTE_MS;
  next.turnovers = next.turnovers.map((turnover) =>
    turnover.id === turnoverId
      ? { ...turnover, readyAt: (turnover.readyAt ?? turnover.startedAt) + extensionMs }
      : turnover,
  );
  return next;
}

function activeItemFor(machine, patients, patientId) {
  return patients
    .find((patient) => patient.id === patientId)
    ?.items.find(
      (item) => item.equipmentId === machine.id && item.status === "in_progress",
    );
}

export function equipmentSlotAvailableTimes(machine, patients, now) {
  const turnoverMs = asMinutes(machine.turnoverMin) * MINUTE_MS;
  const times = [];

  for (const patientId of machine.inUse ?? []) {
    const item = activeItemFor(machine, patients, patientId);
    const { plannedEndAt } = item ? usageTiming(item, now) : { plannedEndAt: now };
    // 超過中は、今終了してもこの後に清掃時間が必要という最短見込みにする。
    times.push(Math.max(now, plannedEndAt ?? now) + turnoverMs);
  }
  for (const turnover of machine.turnovers ?? []) {
    times.push(Math.max(now, turnover.readyAt ?? now));
  }
  while (times.length < machine.capacity) times.push(now);
  return times.sort((a, b) => a - b).slice(0, machine.capacity);
}

export function equipmentTiming(machine, patients, now) {
  const slotAvailableTimes = equipmentSlotAvailableTimes(machine, patients, now);
  const earliestAvailableAt = slotAvailableTimes[0] ?? now;
  return {
    earliestAvailableAt,
    waitMs: Math.max(0, earliestAvailableAt - now),
    slotAvailableTimes,
  };
}

// 現在の公平性順を保ったまま、その患者が開始できる最短時刻を見積もる。
export function estimatedWaitForPatient(machine, patients, patientId, now) {
  const slots = equipmentSlotAvailableTimes(machine, patients, now);
  const candidates = candidatesForEquipment(patients, machine.id);
  const turnoverMs = asMinutes(machine.turnoverMin) * MINUTE_MS;

  for (const { patient, item } of candidates) {
    const startAt = slots.shift() ?? now;
    if (patient.id === patientId) {
      return { estimatedStartAt: startAt, waitMs: Math.max(0, startAt - now) };
    }
    const durationMin = asMinutes(
      item.plannedDurationMin,
      asMinutes(machine.standardDurationMin),
    );
    slots.push(startAt + durationMin * MINUTE_MS + turnoverMs);
    slots.sort((a, b) => a - b);
  }
  return null;
}

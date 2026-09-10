import { useEffect, useMemo, useState } from "react";
import {
  equipmentTiming,
  estimatedWaitForPatient,
  extendTurnover,
  nextCandidateForEquipment,
  nextItem,
  occupiedSlots,
  runScheduler,
  startTurnover,
  usageTiming,
} from "../../lib/rehab-scheduler.mjs";

const EQUIPMENT_CONFIG = [
  { name: "ホットパック", capacity: 4, standardDurationMin: 15, turnoverMin: 3 },
  { name: "牽引", capacity: 2, standardDurationMin: 15, turnoverMin: 3 },
  { name: "干渉波(IFC)", capacity: 2, standardDurationMin: 15, turnoverMin: 3 },
  { name: "エルゴメーター", capacity: 2, standardDurationMin: 20, turnoverMin: 3 },
  { name: "平行棒歩行", capacity: 1, standardDurationMin: 10, turnoverMin: 2 },
  { name: "バランスボード", capacity: 2, standardDurationMin: 10, turnoverMin: 2 },
  { name: "上肢プーリー", capacity: 2, standardDurationMin: 10, turnoverMin: 2 },
  { name: "立位台", capacity: 1, standardDurationMin: 15, turnoverMin: 3 },
];

const ATTENTION_MS = 5 * 60 * 1000;
const MAX_ITEMS_PER_PATIENT = 5;

const STATUS_COLOR = {
  waiting: "bg-[#C6901F]",
  in_progress: "bg-[#5E7A3A]",
  done: "bg-[#33475B]",
};

function fmtElapsed(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function fmtClock(timestamp) {
  if (timestamp == null) return "--:--";
  return new Intl.DateTimeFormat("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

function numericMinutes(value, minimum = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, number) : minimum;
}

export default function RehabQueueBoard() {
  const [speed, setSpeed] = useState(1);
  const [simNow, setSimNow] = useState(Date.now());
  const [equipment, setEquipment] = useState(
    EQUIPMENT_CONFIG.map((machine, index) => ({
      id: `eq${index}`,
      ...machine,
      inUse: [],
      turnovers: [],
    })),
  );
  const [patients, setPatients] = useState([]);
  const [done, setDone] = useState([]);
  const [nextNo, setNextNo] = useState(1);
  const [selected, setSelected] = useState([]);
  const [durationOverrides, setDurationOverrides] = useState({});
  const [orderMode, setOrderMode] = useState("fixed");

  useEffect(() => {
    const timer = setInterval(() => {
      setSimNow((current) => current + 1000 * speed);
    }, 1000);
    return () => clearInterval(timer);
  }, [speed]);

  useEffect(() => {
    const hasElapsedCleaning = equipment.some((machine) =>
      machine.turnovers.some((turnover) => turnover.readyAt <= simNow),
    );
    if (!hasElapsedCleaning) return;

    const result = runScheduler(equipment, patients, simNow);
    setEquipment(result.eqs);
    setPatients(result.pats);
  }, [simNow, equipment, patients]);

  function setEquipmentMinutes(equipmentId, field, value) {
    setEquipment((current) =>
      current.map((machine) =>
        machine.id === equipmentId
          ? { ...machine, [field]: numericMinutes(value, field === "turnoverMin" ? 0 : 1) }
          : machine,
      ),
    );
  }

  function toggleEquipment(equipmentId) {
    setSelected((current) => {
      if (current.includes(equipmentId)) {
        setDurationOverrides((overrides) => {
          const next = { ...overrides };
          delete next[equipmentId];
          return next;
        });
        return current.filter((id) => id !== equipmentId);
      }
      if (current.length >= MAX_ITEMS_PER_PATIENT) return current;
      const machine = equipment.find((item) => item.id === equipmentId);
      setDurationOverrides((overrides) => ({
        ...overrides,
        [equipmentId]: machine?.standardDurationMin ?? 0,
      }));
      return [...current, equipmentId];
    });
  }

  function addPatient() {
    if (selected.length === 0 || selected.length > MAX_ITEMS_PER_PATIENT) return;
    const newPatient = {
      id: `p${nextNo}`,
      no: nextNo,
      receivedAt: simNow,
      currentEquipmentId: null,
      idleSince: simNow,
      orderMode,
      items: selected.map((equipmentId, index) => ({
        equipmentId,
        status: "waiting",
        startedAt: null,
        plannedEndAt: null,
        plannedDurationMin: numericMinutes(durationOverrides[equipmentId], 1),
        waitingSince: orderMode === "flexible" || index === 0 ? simNow : null,
      })),
    };
    const result = runScheduler(equipment, [...patients, newPatient], simNow);
    setEquipment(result.eqs);
    setPatients(result.pats);
    setNextNo((number) => number + 1);
    setSelected([]);
    setDurationOverrides({});
    setOrderMode("fixed");
  }

  function finishUsage(patientId, equipmentId) {
    let nextPatients = patients.map((patient) => ({
      ...patient,
      items: patient.items.map((item) => ({ ...item })),
    }));
    const patient = nextPatients.find((item) => item.id === patientId);
    const machine = equipment.find((item) => item.id === equipmentId);
    if (!patient || !machine || patient.currentEquipmentId !== equipmentId) return;

    const item = patient.items.find(
      (candidate) => candidate.equipmentId === equipmentId && candidate.status === "in_progress",
    );
    if (!item) return;

    item.status = "done";
    item.endedAt = simNow;
    patient.currentEquipmentId = null;

    let nextEquipment = equipment.map((candidate) =>
      candidate.id === equipmentId
        ? startTurnover(candidate, patientId, patient.no, simNow)
        : { ...candidate, inUse: [...candidate.inUse], turnovers: [...candidate.turnovers] },
    );

    const upcoming = nextItem(patient);
    if (upcoming?.status === "waiting" && upcoming.waitingSince === null) {
      upcoming.waitingSince = simNow;
    }

    if (patient.items.every((candidate) => candidate.status === "done")) {
      nextPatients = nextPatients.filter((candidate) => candidate.id !== patientId);
      setDone((current) => [...current, { ...patient, finishedAt: simNow }]);
    } else {
      patient.idleSince = simNow;
    }

    const result = runScheduler(nextEquipment, nextPatients, simNow);
    setEquipment(result.eqs);
    setPatients(result.pats);
  }

  function extendCleaning(equipmentId, turnoverId) {
    setEquipment((current) =>
      current.map((machine) =>
        machine.id === equipmentId ? extendTurnover(machine, turnoverId, 1) : machine,
      ),
    );
  }

  function checkout(patientId) {
    setDone((current) => current.filter((patient) => patient.id !== patientId));
  }

  const sortedPatients = useMemo(
    () => [...patients].sort((left, right) => left.receivedAt - right.receivedAt),
    [patients],
  );

  return (
    <div
      className="min-h-screen bg-[#EFE8D8] text-[#2B2620] font-sans pb-10"
      style={{
        backgroundImage:
          "radial-gradient(circle at 1px 1px, rgba(43,38,32,0.05) 1px, transparent 0)",
        backgroundSize: "18px 18px",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Shippori+Mincho:wght@600;800&family=Zen+Kaku+Gothic+New:wght@400;500;700&family=JetBrains+Mono:wght@400;600&display=swap');
        .f-display { font-family: 'Shippori Mincho', serif; }
        .f-body { font-family: 'Zen Kaku Gothic New', sans-serif; }
        .f-mono { font-family: 'JetBrains Mono', monospace; }
        @keyframes pulse-ring { 0%,100% { box-shadow: 0 0 0 0 rgba(94,122,58,0.4);} 50% { box-shadow: 0 0 0 6px rgba(94,122,58,0);} }
        .pulsing { animation: pulse-ring 1.6s ease-in-out infinite; }
      `}</style>

      <header className="bg-[#33475B] text-[#FBF9F4] f-body">
        <div className="max-w-5xl mx-auto px-5 py-5 flex items-center justify-between gap-4 flex-wrap">
          <div>
            <p className="text-xs tracking-[0.2em] text-[#FBF0DA]/70 mb-1">REHAB QUEUE SIMULATOR</p>
            <h1 className="f-display text-2xl font-bold">リハビリ順番待ちボード</h1>
            <p className="text-xs text-[#FBF9F4]/60 mt-1">利用終了後は標準清掃時間を経て自動的に次の患者へ</p>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-[#FBF9F4]/70">表示速度</span>
            {[1, 60].map((rate) => (
              <button
                key={rate}
                onClick={() => setSpeed(rate)}
                className={`px-3 py-1.5 rounded-md ${speed === rate ? "bg-[#BF3B2C]" : "bg-[#243544]"}`}
              >
                {rate === 1 ? "等速" : "デモ加速(60倍)"}
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 py-6 space-y-6 f-body">
        <section>
          <div className="flex items-end justify-between gap-3 mb-2">
            <div>
              <h2 className="text-sm font-semibold text-[#33475B]/70">機器の稼働状況と標準時間</h2>
              <p className="text-[11px] text-[#2B2620]/45 mt-0.5">時間の変更は今後受け付ける患者に適用されます</p>
            </div>
            <span className="text-xs f-mono text-[#33475B]/60">現在 {fmtClock(simNow)}</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
            {equipment.map((machine) => {
              const occupied = occupiedSlots(machine);
              const freeSlots = Math.max(0, machine.capacity - occupied);
              const timing = equipmentTiming(machine, patients, simNow);
              const preview = nextCandidateForEquipment(patients, machine.id);
              const users = machine.inUse
                .map((id) => patients.find((patient) => patient.id === id)?.no)
                .filter((number) => number != null);
              return (
                <div key={machine.id} className="rounded-lg p-3 text-sm border bg-[#FBF9F4] border-[#33475B]/15">
                  <div className="flex justify-between gap-2">
                    <span className="font-medium">{machine.name}</span>
                    <span className="text-xs f-mono">空き {freeSlots}/{machine.capacity}</span>
                  </div>
                  <div className="text-[11px] text-[#2B2620]/55 mt-1 min-h-8">
                    {users.length > 0 && <div>使用中 No.{users.join(", ")}</div>}
                    {machine.turnovers.length > 0 && <div className="text-[#B56A16]">清掃中 {machine.turnovers.length}台</div>}
                    {freeSlots === 0 && <div>予定利用可能 {fmtClock(timing.earliestAvailableAt)}（あと {fmtElapsed(timing.waitMs)}）</div>}
                  </div>
                  <div className="grid grid-cols-2 gap-2 mt-2">
                    <label className="text-[10px] text-[#2B2620]/55">
                      標準利用（分）
                      <input
                        type="number"
                        min="1"
                        value={machine.standardDurationMin}
                        onChange={(event) => setEquipmentMinutes(machine.id, "standardDurationMin", event.target.value)}
                        className="mt-0.5 w-full rounded border border-[#33475B]/20 bg-white px-2 py-1 f-mono text-xs"
                      />
                    </label>
                    <label className="text-[10px] text-[#2B2620]/55">
                      清掃・交代（分）
                      <input
                        type="number"
                        min="0"
                        value={machine.turnoverMin}
                        onChange={(event) => setEquipmentMinutes(machine.id, "turnoverMin", event.target.value)}
                        className="mt-0.5 w-full rounded border border-[#33475B]/20 bg-white px-2 py-1 f-mono text-xs"
                      />
                    </label>
                  </div>
                  {machine.turnovers.map((turnover) => (
                    <div key={turnover.id} className="mt-2 rounded border border-[#D18A2C]/35 bg-[#FFF4DC] p-2 text-[11px]">
                      <div className="font-medium text-[#9A5C10]">清掃・交代中（No.{turnover.patientNo}利用後）</div>
                      <div className="text-[#2B2620]/55">
                        {fmtClock(turnover.readyAt)}に自動解放（あと {fmtElapsed(turnover.readyAt - simNow)}）
                      </div>
                      <div className="text-[#2B2620]/55">次候補 {preview ? `No.${preview.patient.no}` : "なし"}</div>
                      <button
                        onClick={() => extendCleaning(machine.id, turnover.id)}
                        className="mt-1.5 w-full rounded border border-[#C6901F]/50 bg-white px-2 py-1 text-[#8B6217]"
                      >
                        清掃を1分延長
                      </button>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </section>

        <section className="bg-[#FBF9F4] rounded-lg p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-[#33475B]/70 mb-2">
            新規受付（次の患者番号: <span className="f-mono">No.{nextNo}</span>）
          </h2>
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <span className="text-xs text-[#2B2620]/50">消化順:</span>
            <button onClick={() => setOrderMode("fixed")} className={`text-xs px-3 py-1 rounded-full border ${orderMode === "fixed" ? "bg-[#33475B] text-white" : "border-[#33475B]/30"}`}>希望順を厳守</button>
            <button onClick={() => setOrderMode("flexible")} className={`text-xs px-3 py-1 rounded-full border ${orderMode === "flexible" ? "bg-[#33475B] text-white" : "border-[#33475B]/30"}`}>順不同でOK</button>
          </div>
          <div className="flex flex-wrap gap-2 mb-3">
            {equipment.map((machine) => {
              const orderIndex = selected.indexOf(machine.id);
              const isSelected = orderIndex !== -1;
              const disabled = !isSelected && selected.length >= MAX_ITEMS_PER_PATIENT;
              return (
                <button
                  key={machine.id}
                  disabled={disabled}
                  onClick={() => toggleEquipment(machine.id)}
                  className={`text-sm px-3 py-1.5 rounded-full border flex items-center gap-1.5 ${isSelected ? "bg-[#33475B] text-white" : "border-[#33475B]/40 text-[#33475B]"}`}
                >
                  {isSelected && <span className="f-mono text-xs bg-[#BF3B2C] rounded-full w-4 h-4">{orderIndex + 1}</span>}
                  {machine.name}
                </button>
              );
            })}
          </div>
          {selected.length > 0 && (
            <div className="rounded-md bg-[#EFE8D8]/60 p-3 mb-3">
              <div className="text-xs font-medium text-[#33475B] mb-2">開始時の予定利用時間（個別変更可）</div>
              <div className="grid sm:grid-cols-2 gap-2">
                {selected.map((equipmentId, index) => {
                  const machine = equipment.find((candidate) => candidate.id === equipmentId);
                  return (
                    <label key={equipmentId} className="flex items-center justify-between gap-2 text-xs">
                      <span>{index + 1}. {machine?.name}</span>
                      <span className="flex items-center gap-1">
                        <input
                          type="number"
                          min="1"
                          value={durationOverrides[equipmentId] ?? machine?.standardDurationMin ?? 0}
                          onChange={(event) => setDurationOverrides((current) => ({ ...current, [equipmentId]: numericMinutes(event.target.value, 1) }))}
                          className="w-16 rounded border border-[#33475B]/20 bg-white px-2 py-1 f-mono"
                        /> 分
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-xs text-[#2B2620]/50">1〜{MAX_ITEMS_PER_PATIENT}項目（現在 {selected.length}）</span>
            <button disabled={selected.length === 0} onClick={addPatient} className="bg-[#BF3B2C] disabled:bg-[#2B2620]/20 text-white text-sm font-medium px-4 py-2 rounded-md">受付する</button>
          </div>
        </section>

        <section>
          <h2 className="text-sm font-semibold text-[#33475B]/70 mb-2">順番待ちボード（{sortedPatients.length}名）</h2>
          <div className="space-y-2">
            {sortedPatients.length === 0 && <p className="text-sm text-[#2B2620]/40 py-6 text-center">現在、待機中の患者はいません</p>}
            {sortedPatients.map((patient) => {
              const totalMs = simNow - patient.receivedAt;
              const idleMs = patient.idleSince == null ? null : simNow - patient.idleSince;
              const attention = idleMs != null && idleMs > ATTENTION_MS;
              return (
                <div key={patient.id} className={`bg-[#FBF9F4] rounded-lg p-3 border ${attention ? "border-[#C24A3B]" : "border-[#33475B]/10"}`}>
                  <div className="flex gap-3 items-start">
                    <div className="w-20 shrink-0">
                      <div className="f-mono text-lg font-semibold text-[#33475B]">No.{patient.no}</div>
                      <div className="f-mono text-xs text-[#2B2620]/40">経過 {fmtElapsed(totalMs)}</div>
                      {idleMs != null && <div className={`f-mono text-[10px] font-semibold ${attention ? "text-[#C24A3B]" : "text-[#2B2620]/40"}`}>待機 {fmtElapsed(idleMs)}</div>}
                      {patient.orderMode === "flexible" && <div className="text-[10px] text-[#5E7A3A]">順不同</div>}
                    </div>
                    <div className="grid sm:grid-cols-2 gap-2 flex-1">
                      {patient.items.map((item, index) => {
                        const machine = equipment.find((candidate) => candidate.id === item.equipmentId);
                        const timing = item.status === "in_progress" ? usageTiming(item, simNow) : null;
                        const estimate = item.status === "waiting" && machine
                          ? estimatedWaitForPatient(machine, patients, patient.id, simNow)
                          : null;
                        return (
                          <div key={item.equipmentId} className={`rounded-md border p-2 text-xs ${timing?.overdue ? "border-[#C24A3B] bg-[#FFF0ED]" : item.status === "in_progress" ? "border-[#5E7A3A]/50 bg-[#F4F8EE] pulsing" : "border-[#33475B]/10"}`}>
                            <div className="flex items-center gap-1.5">
                              <span className="f-mono text-[10px] text-[#2B2620]/40">{patient.orderMode === "fixed" ? index + 1 : "・"}</span>
                              <span className={`w-3 h-3 rounded-full ${STATUS_COLOR[item.status]}`} />
                              <span className={item.status === "done" ? "line-through text-[#2B2620]/40" : "font-medium"}>{machine?.name}</span>
                              <span className="ml-auto f-mono text-[10px]">{item.plannedDurationMin}分</span>
                            </div>
                            {timing && (
                              <div className={`mt-1.5 ${timing.overdue ? "text-[#B42F25] font-semibold" : "text-[#3E5226]"}`}>
                                <div>予定終了 {fmtClock(timing.plannedEndAt)}</div>
                                <div>{timing.overdue ? `超過 ${fmtElapsed(-timing.remainingMs)}` : `残り ${fmtElapsed(timing.remainingMs)}`}</div>
                                <button onClick={() => finishUsage(patient.id, item.equipmentId)} className={`mt-2 w-full rounded px-3 py-1.5 text-white ${timing.overdue ? "bg-[#B42F25]" : "bg-[#5E7A3A]"}`}>利用終了</button>
                              </div>
                            )}
                            {estimate && estimate.waitMs > 0 && (
                              <div className="mt-1 text-[10px] text-[#9A6914]">開始目安 {fmtClock(estimate.estimatedStartAt)}（あと {fmtElapsed(estimate.waitMs)}・清掃時間込み）</div>
                            )}
                            {item.status === "done" && <div className="mt-1 text-[10px] text-[#2B2620]/40">利用終了</div>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {done.length > 0 && (
          <section>
            <h2 className="text-sm font-semibold text-[#33475B]/70 mb-2">治療終了・会計待ち</h2>
            <div className="space-y-2">
              {done.map((patient) => (
                <div key={patient.id} className="bg-[#FBF0DA] rounded-lg p-3 flex items-center justify-between">
                  <span className="f-mono text-sm font-semibold text-[#33475B]">No.{patient.no} 治療終了</span>
                  <button onClick={() => checkout(patient.id)} className="bg-[#33475B] text-white text-xs px-3 py-1.5 rounded-md">会計完了</button>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

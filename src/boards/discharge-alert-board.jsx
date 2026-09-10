import { useState, useMemo } from "react";
import {
  cancelCollectionRequest,
  completeReturn,
  dischargeTiming,
  requestCollection,
} from "../../lib/discharge-returns.mjs";

// discharge_alertビュー(LOANのみをJOIN)の出力を想定したサンプル。
// slot型(時間予約)の機器は「未返却」という状態を持たないため、ここには現れない。
function dateAfterDays(offset) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const SAMPLE_ROWS = [
  {
    patient_id: "DEMO-P001",
    ward: "病棟A",
    discharge_planned: dateAfterDays(1),
    unreturned_equipment: [
      { equipment_id: "DEMO-E001", name: "デモ車椅子A" },
      { equipment_id: "DEMO-E002", name: "クッション(円座)" },
    ],
  },
  {
    patient_id: "DEMO-P002",
    ward: "病棟A",
    discharge_planned: dateAfterDays(2),
    unreturned_equipment: [{ equipment_id: "DEMO-E003", name: "デモ歩行器A" }],
  },
  {
    patient_id: "DEMO-P003",
    ward: "病棟B",
    discharge_planned: dateAfterDays(3),
    unreturned_equipment: [
      { equipment_id: "DEMO-E004", name: "デモ車椅子B" },
      { equipment_id: "DEMO-E005", name: "デモ四点杖A" },
    ],
  },
];

const STAGES = ["pending", "requested", "returned"];
const STAGE_LABEL = { pending: "未対応", requested: "回収依頼済み", returned: "返却済み" };

function urgencyStyle(days) {
  if (days <= 1) return { border: "border-[#BF3B2C]", badge: "bg-[#BF3B2C] text-[#FBF9F4]" };
  if (days <= 2) return { border: "border-[#C6901F]", badge: "bg-[#C6901F] text-[#FBF9F4]" };
  return { border: "border-[#33475B]/20", badge: "bg-[#33475B] text-[#FBF9F4]" };
}

function iconFor(name) {
  if (name.includes("車椅子")) return "🦽";
  if (name.includes("円座") || name.includes("クッション")) return "🛏";
  if (name.includes("歩行器")) return "🚶";
  if (name.includes("杖")) return "🩼";
  return "📦";
}

function fmtTime(d) {
  return new Date(d).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}

export default function DischargeAlertBoard() {
  const [staff, setStaff] = useState("");
  const [rows, setRows] = useState(
    SAMPLE_ROWS.map((r) => ({ ...r, status: "pending", history: [], collectionTasks: [] }))
  );

  const activeCount = rows.filter((r) => r.status !== "returned").length;

  const grouped = useMemo(() => {
    const g = {};
    for (const r of rows) {
      if (!g[r.ward]) g[r.ward] = [];
      g[r.ward].push(r);
    }
    return g;
  }, [rows]);

  function requestCollectionFor(patientId) {
    setRows((rs) =>
      rs.map((r) =>
        r.patient_id === patientId ? requestCollection(r, staff, Date.now()) : r,
      ),
    );
  }

  function markReturned(patientId) {
    setRows((rs) =>
      rs.map((r) => (r.patient_id === patientId ? completeReturn(r, staff, Date.now()) : r)),
    );
  }

  function cancelRequest(patientId) {
    setRows((rs) =>
      rs.map((r) =>
        r.patient_id === patientId ? cancelCollectionRequest(r, staff, Date.now()) : r,
      ),
    );
  }

  const returnedRows = rows.filter((r) => r.status === "returned");

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
      `}</style>

      <header className="bg-[#33475B] text-[#FBF9F4] f-body">
        <div className="max-w-2xl mx-auto px-5 py-5 flex items-center justify-between gap-4 flex-wrap">
          <div>
            <p className="text-xs tracking-[0.2em] text-[#FBF0DA]/70 mb-1">DISCHARGE ALERT VIEW</p>
            <h1 className="f-display text-2xl font-bold">退院前 返却チェック</h1>
          </div>
          <input
            value={staff}
            onChange={(e) => setStaff(e.target.value)}
            placeholder="担当者名（例: PT_A）"
            className="text-sm px-3 py-1.5 rounded-md bg-[#243544] placeholder-[#FBF9F4]/40 outline-none w-48"
          />
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-6 space-y-6 f-body">
        {/* 件数バッジ */}
        <div className="flex items-center gap-3 bg-[#FBF9F4] rounded-lg px-4 py-3 shadow-sm">
          <span
            className={`f-mono text-2xl font-bold w-10 h-10 rounded-full flex items-center justify-center ${
              activeCount > 0 ? "bg-[#BF3B2C] text-[#FBF9F4]" : "bg-[#33475B]/10 text-[#33475B]/40"
            }`}
          >
            {activeCount}
          </span>
          <span className="text-sm">返却確認が必要な患者</span>
        </div>

        {Object.entries(grouped).map(([ward, wardRows]) => {
          const wardActive = wardRows.filter((r) => r.status !== "returned");
          if (wardActive.length === 0) return null;
          return (
            <section key={ward}>
              <h2 className="text-sm font-semibold text-[#33475B]/70 mb-2">{ward}</h2>
              <div className="space-y-3">
                {wardActive.map((r) => {
                  const timing = dischargeTiming(r.discharge_planned, new Date());
                  const s = urgencyStyle(timing.days);
                  const lastHist = r.history[r.history.length - 1];
                  return (
                    <div key={r.patient_id} className={`bg-[#FBF9F4] rounded-lg p-4 border-2 ${s.border}`}>
                      <div className="flex items-start justify-between mb-2">
                        <div className="f-mono text-sm text-[#2B2620]/50">{r.patient_id}</div>
                        <div className={`text-right px-2.5 py-1 rounded-md ${s.badge}`}>
                          <div className="text-xs font-semibold">{timing.relativeLabel}</div>
                          <div className="text-[10px] opacity-80">予定日 {timing.plannedDateLabel}</div>
                        </div>
                      </div>

                      <div className="text-xs text-[#2B2620]/50 mb-1">未返却の貸出物</div>
                      <div className="flex flex-wrap gap-1.5 mb-3">
                        {r.unreturned_equipment.map((eq) => (
                          <span
                            key={eq.equipment_id}
                            className="text-xs bg-[#33475B]/8 border border-[#33475B]/20 px-2 py-1 rounded-md flex items-center gap-1"
                          >
                            <span>{iconFor(eq.name)}</span>
                            {eq.name}
                            <span className="f-mono text-[9px] text-[#2B2620]/35">{eq.equipment_id}</span>
                          </span>
                        ))}
                      </div>

                      {/* ステータス・ステッパー */}
                      <div className="flex items-center gap-1.5 mb-2">
                        {STAGES.map((st, i) => {
                          const currentIdx = STAGES.indexOf(r.status);
                          const stateClass =
                            i < currentIdx
                              ? "bg-[#33475B] text-[#FBF9F4]"
                              : i === currentIdx
                              ? "bg-[#C6901F] text-[#FBF9F4]"
                              : "bg-[#2B2620]/8 text-[#2B2620]/40";
                          return (
                            <span key={st} className={`text-[11px] px-2 py-1 rounded-full ${stateClass}`}>
                              {STAGE_LABEL[st]}
                            </span>
                          );
                        })}
                      </div>

                      {lastHist && (
                        <div className="text-[11px] text-[#2B2620]/40 mb-2">
                          {lastHist.staff} ・ {fmtTime(lastHist.at)} に「{STAGE_LABEL[lastHist.status]}」
                          {lastHist.action === "cancel_collection" ? "へ戻す" : "に更新"}
                        </div>
                      )}

                      {r.status === "requested" && r.collectionTasks.some((task) => task.status === "open") && (
                        <div className="text-[11px] bg-[#FFF4DC] border border-[#C6901F]/30 rounded-md px-2.5 py-2 mb-2 text-[#7B5511]">
                          回収依頼タスクを作成済み
                          <span className="f-mono ml-2">
                            {r.collectionTasks.find((task) => task.status === "open")?.id}
                          </span>
                        </div>
                      )}

                      <div className="flex gap-2">
                        {r.status === "pending" && (
                          <button
                            onClick={() => requestCollectionFor(r.patient_id)}
                            className="text-xs bg-[#33475B] text-[#FBF9F4] px-3 py-1.5 rounded-md"
                          >
                            回収を依頼する
                          </button>
                        )}
                        {r.status === "requested" && (
                          <button
                            onClick={() => markReturned(r.patient_id)}
                            className="text-xs bg-[#5E7A3A] text-[#FBF9F4] px-3 py-1.5 rounded-md"
                          >
                            返却完了
                          </button>
                        )}
                        {r.status === "requested" && (
                          <button
                            onClick={() => cancelRequest(r.patient_id)}
                            className="text-xs border border-[#2B2620]/20 text-[#2B2620]/50 px-3 py-1.5 rounded-md"
                          >
                            依頼を取り消す
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}

        {returnedRows.length > 0 && (
          <section>
            <h2 className="text-sm font-semibold text-[#33475B]/70 mb-2">本日の対応履歴</h2>
            <div className="space-y-1.5">
              {returnedRows.map((r) => {
                const lastHist = r.history[r.history.length - 1];
                return (
                  <div
                    key={r.patient_id}
                    className="bg-[#FBF0DA] rounded-lg px-3 py-2 flex items-center justify-between text-xs"
                  >
                    <span className="f-mono">{r.patient_id}</span>
                    <span className="text-[#2B2620]/50">
                      返却済み ・ {lastHist?.staff} ・ {lastHist ? fmtTime(lastHist.at) : ""}
                    </span>
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

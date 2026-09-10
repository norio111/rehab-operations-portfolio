import { useState } from "react";
import CarUsageBoard from "./boards/car-usage-board.jsx";
import DischargeAlertBoard from "./boards/discharge-alert-board.jsx";
import RehabQueueBoard from "./boards/rehab-queue-board.jsx";

const BOARDS = [
  { id: "rehab", label: "リハビリ順番待ち", component: RehabQueueBoard },
  { id: "discharge", label: "退院前返却チェック", component: DischargeAlertBoard },
  { id: "car", label: "社用車利用", component: CarUsageBoard },
];

export default function App() {
  const [activeBoard, setActiveBoard] = useState(BOARDS[0].id);

  return (
    <div className="min-h-screen bg-[#EFE8D8] text-[#2B2620]">
      <nav
        aria-label="業務ボードの切り替え"
        className="sticky top-0 z-50 border-b border-[#2B2620]/20 bg-[#FBF9F4]/95 px-4 py-3 shadow-sm backdrop-blur"
      >
        <div className="mx-auto flex max-w-5xl gap-2 overflow-x-auto" role="tablist">
          {BOARDS.map((board) => (
            <button
              key={board.id}
              type="button"
              role="tab"
              aria-selected={activeBoard === board.id}
              aria-controls={`${board.id}-panel`}
              id={`${board.id}-tab`}
              onClick={() => setActiveBoard(board.id)}
              className={`shrink-0 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
                activeBoard === board.id
                  ? "bg-[#33475B] text-[#FBF9F4]"
                  : "bg-[#EFE8D8] text-[#33475B] hover:bg-[#E2D8C3]"
              }`}
            >
              {board.label}
            </button>
          ))}
        </div>
      </nav>

      {BOARDS.map((board) => {
        const Board = board.component;
        const isActive = activeBoard === board.id;
        return (
          <section
            key={board.id}
            id={`${board.id}-panel`}
            role="tabpanel"
            aria-labelledby={`${board.id}-tab`}
            hidden={!isActive}
          >
            <Board />
          </section>
        );
      })}
    </div>
  );
}

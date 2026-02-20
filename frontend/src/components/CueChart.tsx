import { useState } from "react";
import {
  ComposedChart,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  Area,
} from "recharts";

import type { PredictResponse } from "../types";

interface Props {
  prediction: PredictResponse;
  entry_sec: number;
  exit_sec: number;
  onCueEdit: (type: "entry" | "exit", sec: number) => void;
  isEditable?: boolean;
  syncId?: string;
  elapsed?: number;
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function nearestBar(bar_times: number[], sec: number): number {
  return bar_times.reduce(
    (best, t, i) =>
      Math.abs(t - sec) < Math.abs(bar_times[best] - sec) ? i : best,
    0,
  );
}

export default function CueChart({
  prediction,
  entry_sec,
  exit_sec,
  onCueEdit,
  isEditable = true,
  syncId,
  elapsed,
}: Props) {
  const [editMode, setEditMode] = useState<"entry" | "exit">("entry");

  const { bar_times, score_in, score_out, num_bars } = prediction;

  const data = bar_times.map((t, i) => ({
    bar: i,
    time: t,
    scoreIn: score_in[i] ?? 0,
    scoreOut: score_out[i] ?? 0,
  }));

  const tickStep = Math.max(1, Math.floor(num_bars / 10));
  const ticks = Array.from(
    { length: Math.ceil(num_bars / tickStep) },
    (_, i) => i * tickStep,
  );

  const entryBar = nearestBar(bar_times, entry_sec);
  const exitBar = nearestBar(bar_times, exit_sec);
  const playheadBar =
    elapsed !== undefined ? nearestBar(bar_times, elapsed) : null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleClick = (payload: any) => {
    if (!isEditable) return;
    const raw = payload?.activeLabel;
    if (raw === undefined || raw === null) return;
    const bar = typeof raw === "number" ? raw : parseInt(String(raw), 10);
    const sec = bar_times[bar];
    if (sec !== undefined) {
      onCueEdit(editMode, sec);
    }
  };

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (!active || !payload?.length) return null;
    const sec = bar_times[label as number] ?? 0;
    return (
      <div className="bg-gray-900 border border-gray-700 rounded p-2 text-xs">
        <p className="text-gray-400 mb-1">
          Bar {label} · {fmtTime(sec)}
        </p>
        {payload.map((p: any) => (
          <p key={p.dataKey} style={{ color: p.color }}>
            {p.name}: {(p.value as number).toFixed(3)}
          </p>
        ))}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-2">
      {/* Edit mode toggle */}
      {isEditable && (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-gray-500">Click chart to set:</span>
          <button
            onClick={() => setEditMode("entry")}
            className={`px-2 py-0.5 rounded text-xs transition-colors ${
              editMode === "entry"
                ? "bg-green-600 text-white"
                : "bg-gray-800 text-gray-400 hover:bg-gray-700"
            }`}
          >
            Entry
          </button>
          <button
            onClick={() => setEditMode("exit")}
            className={`px-2 py-0.5 rounded text-xs transition-colors ${
              editMode === "exit"
                ? "bg-red-600 text-white"
                : "bg-gray-800 text-gray-400 hover:bg-gray-700"
            }`}
          >
            Exit
          </button>
          {prediction.method === "heuristic" && (
            <span className="ml-auto text-yellow-500/70">heuristic</span>
          )}
        </div>
      )}

      {/* Chart */}
      <div className="cursor-crosshair">
        <ResponsiveContainer width="100%" height={160}>
          <ComposedChart
            data={data}
            margin={{ top: 4, right: 8, left: -24, bottom: 0 }}
            onClick={handleClick}
            syncId={syncId}
          >
            <CartesianGrid strokeDasharray="2 4" stroke="#1e2035" />
            <XAxis
              dataKey="bar"
              ticks={ticks}
              tickFormatter={(v) => fmtTime(bar_times[v as number] ?? 0)}
              tick={{ fill: "#64748b", fontSize: 10 }}
              tickLine={false}
            />
            <YAxis
              domain={[0, 1]}
              tick={{ fill: "#64748b", fontSize: 10 }}
              tickLine={false}
            />
            <Tooltip content={<CustomTooltip />} />

            <Area
              type="monotone"
              dataKey="scoreIn"
              name="Entry"
              stroke="#22c55e"
              fill="#22c55e22"
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 3 }}
            />
            <Area
              type="monotone"
              dataKey="scoreOut"
              name="Exit"
              stroke="#ef4444"
              fill="#ef444422"
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 3 }}
            />

            {/* Entry cue marker */}
            <ReferenceLine
              x={entryBar}
              stroke="#22c55e"
              strokeDasharray="4 3"
              strokeWidth={2}
              label={{
                value: `▶ ${fmtTime(entry_sec)}`,
                fill: "#22c55e",
                fontSize: 10,
                position: "top",
              }}
            />

            {/* Exit cue marker */}
            <ReferenceLine
              x={exitBar}
              stroke="#ef4444"
              strokeDasharray="4 3"
              strokeWidth={2}
              label={{
                value: `⏹ ${fmtTime(exit_sec)}`,
                fill: "#ef4444",
                fontSize: 10,
                position: "top",
              }}
            />

            {/* Playhead */}
            {playheadBar !== null && (
              <ReferenceLine
                x={playheadBar}
                stroke="rgba(255,255,255,0.85)"
                strokeDasharray="3 4"
                strokeWidth={1.5}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Time summary */}
      <div className="flex justify-between text-xs text-gray-500 px-1">
        <span>
          <span className="text-green-400">▶ Entry</span>{" "}
          <span className="font-mono text-gray-300">{fmtTime(entry_sec)}</span>
        </span>
        <span>
          <span className="text-red-400">⏹ Exit</span>{" "}
          <span className="font-mono text-gray-300">{fmtTime(exit_sec)}</span>
        </span>
        <span className="text-gray-600">
          {fmtTime(exit_sec - entry_sec)} body
        </span>
      </div>
    </div>
  );
}

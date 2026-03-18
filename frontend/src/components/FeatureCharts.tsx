/**
 * FeatureCharts — stacked per-bar feature visualisations.
 *
 * Renders compact per-bar feature visualisations for the DJ deck.
 *
 * Current deck view intentionally shows only:
 *   1. Energy landscape  — overall energy + bass + mids + highs
 *
 * All arrays are already normalised [0,1] by the backend.
 * Entry / exit cue positions are shown as reference lines.
 */
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  Legend,
} from "recharts";
import type { PredictResponse } from "../types";

interface Props {
  prediction: PredictResponse;
  entry_sec: number;
  exit_sec: number;
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function MiniTooltip({ active, payload, label, bar_times }: any) {
  if (!active || !payload?.length) return null;
  const sec = bar_times?.[label as number] ?? 0;
  return (
    <div className="bg-[#0a0a16] border border-white/10 rounded p-1.5 text-[10px] shadow-xl">
      <p className="text-gray-500 mb-0.5">
        Bar {label} · {fmtTime(sec)}
      </p>
      {payload.map((p: any) => (
        <p key={p.dataKey} style={{ color: p.color }}>
          {p.name}: {(p.value as number).toFixed(2)}
        </p>
      ))}
    </div>
  );
}

interface MiniChartProps {
  title: string;
  data: object[];
  bar_times: number[];
  entryBar: number;
  exitBar: number;
  playheadBar: number | null;
  tickStep: number;
  syncId?: string;
  series: { key: string; name: string; color: string; opacity?: number }[];
}

function MiniChart({
  title,
  data,
  bar_times,
  entryBar,
  exitBar,
  playheadBar,
  tickStep,
  syncId,
  series,
}: MiniChartProps) {
  const ticks = Array.from(
    { length: Math.ceil(data.length / tickStep) },
    (_, i) => i * tickStep,
  );

  return (
    <div>
      <p className="text-[10px] uppercase tracking-widest text-gray-600 font-semibold mb-1 px-1">
        {title}
      </p>
      <ResponsiveContainer width="100%" height={80}>
        <AreaChart
          data={data}
          margin={{ top: 2, right: 8, left: -28, bottom: 0 }}
          syncId={syncId}
        >
          <CartesianGrid strokeDasharray="2 4" stroke="#1e2035" />
          <XAxis
            dataKey="bar"
            ticks={ticks}
            tickFormatter={(v) => fmtTime(bar_times[v as number] ?? 0)}
            tick={{ fill: "#475569", fontSize: 9 }}
            tickLine={false}
          />
          <YAxis domain={[0, 1]} tick={false} tickLine={false} />
          <Tooltip
            content={<MiniTooltip bar_times={bar_times} />}
            isAnimationActive={false}
          />
          {series.length > 1 && (
            <Legend
              iconType="circle"
              iconSize={6}
              wrapperStyle={{ fontSize: 9, paddingTop: 0 }}
            />
          )}
          {series.map((s) => (
            <Area
              key={s.key}
              type="monotone"
              dataKey={s.key}
              name={s.name}
              stroke={s.color}
              fill={s.color}
              fillOpacity={s.opacity ?? 0.15}
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 2 }}
              isAnimationActive={false}
            />
          ))}
          <ReferenceLine
            x={entryBar}
            stroke="#22c55e"
            strokeDasharray="3 3"
            strokeWidth={1.5}
          />
          <ReferenceLine
            x={exitBar}
            stroke="#ef4444"
            strokeDasharray="3 3"
            strokeWidth={1.5}
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
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function FeatureCharts({
  prediction,
  entry_sec,
  exit_sec,
  syncId,
  elapsed,
}: Props) {
  const {
    bar_times,
    num_bars,
    energy,
    bass_energy,
    high_energy,
    mid_energy,
  } = prediction;

  const tickStep = Math.max(1, Math.floor(num_bars / 8));
  const entryBar = nearestBar(bar_times, entry_sec);
  const exitBar = nearestBar(bar_times, exit_sec);
  const playheadBar =
    elapsed !== undefined ? nearestBar(bar_times, elapsed) : null;

  // ── Build base data rows (shared bar index) ─────────────────────────────
  const baseData = bar_times.map((_, i) => ({ bar: i }));

  // ── 1. Energy landscape ─────────────────────────────────────────────────
  const hasEnergy = energy || bass_energy || high_energy || mid_energy;
  const energyData = hasEnergy
    ? baseData.map((row, i) => ({
        ...row,
        energy: energy?.[i] ?? null,
        bass: bass_energy?.[i] ?? null,
        high: high_energy?.[i] ?? null,
        mid: mid_energy?.[i] ?? null,
      }))
    : null;

  // Nothing to show
  if (!energyData) {
    return (
      <div className="text-[10px] text-gray-700 italic px-1 py-2">
        No feature data available for this track.
      </div>
    );
  }

  const sharedProps = {
    bar_times,
    entryBar,
    exitBar,
    playheadBar,
    tickStep,
    syncId,
  };

  // Build energy series dynamically based on what's present
  const energySeries = [
    energy && { key: "energy", name: "Energy", color: "#94a3b8", opacity: 0.2 },
    bass_energy && {
      key: "bass",
      name: "Bass",
      color: "#f97316",
      opacity: 0.25,
    },
    mid_energy && { key: "mid", name: "Mids", color: "#a78bfa", opacity: 0.2 },
    high_energy && {
      key: "high",
      name: "Highs",
      color: "#38bdf8",
      opacity: 0.15,
    },
  ].filter(Boolean) as {
    key: string;
    name: string;
    color: string;
    opacity: number;
  }[];

  return (
    <div className="flex flex-col gap-4">
      <div className="border-t border-white/5 pt-1" />

      {energyData && energySeries.length > 0 && (
        <MiniChart
          title="Energy Landscape"
          data={energyData}
          series={energySeries}
          {...sharedProps}
        />
      )}
    </div>
  );
}

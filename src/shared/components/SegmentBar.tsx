import { calcProgressPercent } from "../format";
import type { SegmentView, TaskView } from "../types";

export function normalizeSegments(segments: SegmentView[], maxBuckets = 32): SegmentView[] {
  if (segments.length <= maxBuckets) return segments;
  const buckets: SegmentView[] = [];
  for (let b = 0; b < maxBuckets; b++) {
    const startIdx = Math.floor((b * segments.length) / maxBuckets);
    const endIdx = Math.floor(((b + 1) * segments.length) / maxBuckets) - 1;
    if (startIdx > endIdx) continue;
    const segStart = segments[startIdx].start;
    const segEnd = segments[endIdx].end;
    let doneBytes = 0;
    let allDone = true;
    let anyActive = false;
    for (let i = startIdx; i <= endIdx; i++) {
      const seg = segments[i];
      doneBytes += Math.max(0, seg.current - seg.start);
      if (seg.state !== "completed") {
        allDone = false;
      }
      if (seg.state === "downloading") {
        anyActive = true;
      }
    }
    buckets.push({
      index: buckets.length,
      start: segStart,
      current: Math.min(segEnd, segStart + doneBytes),
      end: segEnd,
      state: allDone ? "completed" : doneBytes > 0 || anyActive ? "downloading" : "pending",
    });
  }
  return buckets;
}

export function SegmentBar({ task }: { task: TaskView }) {
  const total = task.total ?? 0;
  const isDone = task.state === "completed" || task.state === "seeding";

  if (total > 0 && task.segments && task.segments.length > 1 && !isDone) {
    const displaySegments = normalizeSegments(task.segments);
    return (
      <div className="segment-strip" title={`${displaySegments.length} segments`}>
        {displaySegments.map((seg) => {
          const leftPct = Math.max(0, Math.min(100, (seg.start / total) * 100));
          const widthPct = Math.max(
            0,
            Math.min(100 - leftPct, ((seg.current - seg.start) / total) * 100),
          );
          if (widthPct <= 0) return null;
          return (
            <div
              key={`${seg.index}-${seg.start}`}
              className={`segment-piece ${seg.state === "completed" ? "done" : ""}`}
              style={{
                left: `${leftPct.toFixed(2)}%`,
                width: `${widthPct.toFixed(2)}%`,
              }}
            />
          );
        })}
      </div>
    );
  }

  const pct = isDone ? 100 : calcProgressPercent(task.downloaded, task.total);
  return (
    <div className={`progress ${isDone ? "done" : "http"}`}>
      <i style={{ width: `${pct.toFixed(1)}%` }} />
    </div>
  );
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes) || bytes < 0) {
    return "—";
  }
  if (bytes === 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return unitIndex === 0 ? `${Math.round(value)} B` : `${value.toFixed(1)} ${units[unitIndex]}`;
}

export function formatSpeed(bps: number | null | undefined): { value: string; unit: string; full: string } {
  if (!bps || bps <= 0) {
    return { value: "0.0", unit: "KiB/s", full: "0 B/s" };
  }
  const units = ["B/s", "KiB/s", "MiB/s", "GiB/s"];
  let value = bps;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const formatted = unitIndex === 0 ? `${Math.round(value)}` : value.toFixed(1);
  return {
    value: formatted,
    unit: units[unitIndex],
    full: `${formatted} ${units[unitIndex]}`,
  };
}

export function formatEta(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || seconds < 0 || !Number.isFinite(seconds)) {
    return "--:--";
  }
  if (seconds === 0) return "00:00";
  const s = Math.round(seconds);
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (hrs > 0) {
    return `${pad(hrs)}:${pad(mins)}:${pad(secs)}`;
  }
  return `${pad(mins)}:${pad(secs)}`;
}

export function calcProgressPercent(downloaded: number, total: number | null): number {
  if (!total || total <= 0) return 0;
  return Math.max(0, Math.min(100, (downloaded / total) * 100));
}

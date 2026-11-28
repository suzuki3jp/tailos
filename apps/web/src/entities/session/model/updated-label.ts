export function updatedLabel(updatedAt: number, now = Date.now()) {
  const minutes = Math.floor(Math.max(0, now - updatedAt) / 60_000);
  if (minutes === 0) return "Updated just now";
  const format = new Intl.RelativeTimeFormat("en", { numeric: "always" });
  if (minutes < 60) return `Updated ${format.format(-minutes, "minute")}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${format.format(-hours, "hour")}`;
  return `Updated ${format.format(-Math.floor(hours / 24), "day")}`;
}

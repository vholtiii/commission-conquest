const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function formatMoney(amount: number): string {
  const sign = amount < 0 ? "-" : "";
  return `${sign}$${Math.abs(Math.round(amount)).toLocaleString()}`;
}

export function formatDelta(amount: number): string {
  const sign = amount >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(Math.round(amount)).toLocaleString()}`;
}

export function formatDate(date: { year: number; month: number; day: number }): string {
  const month = MONTHS[Math.max(0, Math.min(11, date.month - 1))] ?? "January";
  return `${month} ${date.day}, ${date.year}`;
}

export function titleCase(input: string): string {
  return input
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

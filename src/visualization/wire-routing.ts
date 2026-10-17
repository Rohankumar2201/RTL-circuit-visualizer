export interface Pt { x: number; y: number }

export function forwardPath(a: Pt, b: Pt, rank?: { k: number; K: number }): string {
  if (Math.abs(a.y - b.y) < 0.5) return `M${a.x} ${a.y}H${b.x}`;
  const gap = b.x - a.x;
  const chan = gap < 44 || !rank ? a.x + gap / 2 : a.x + 16 + ((gap - 32) * (rank.k + 1)) / (rank.K + 1);
  return `M${a.x} ${a.y}H${chan}V${b.y}H${b.x}`;
}

export function backwardPath(a: Pt, b: Pt, laneY: number): string {
  return `M${a.x} ${a.y}H${a.x + 14}V${laneY}H${b.x - 14}V${b.y}H${b.x}`;
}

/** Routes above the node field: out of the source, up to a lane, across, and down into the target. */
export function overPath(a: Pt, b: Pt, laneY: number): string {
  return `M${a.x} ${a.y}H${a.x + 14}V${laneY}H${b.x - 14}V${b.y}H${b.x}`;
}

export function connectionPath(a: Pt, b: Pt, o: { backward: boolean; rank?: { k: number; K: number }; laneY: number; overY?: number }): string {
  if (o.backward) return backwardPath(a, b, o.laneY);
  if (o.overY !== undefined) return overPath(a, b, o.overY);
  return forwardPath(a, b, o.rank);
}

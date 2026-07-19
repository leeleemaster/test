export type V = { x: number; y: number };

/** Row-major 2x2 matrix. */
export type M2 = {
  xx: number;
  xy: number;
  yx: number;
  yy: number;
};

export const IDENTITY_M2: M2 = { xx: 1, xy: 0, yx: 0, yy: 1 };

const DEG = Math.PI / 180;

export const deg2rad = (degrees: number) => degrees * DEG;
export const rad2deg = (radians: number) => radians / DEG;
export const normalizeDeg = (value: number) => ((value % 360) + 360) % 360;

export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function add(a: V, b: V): V {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: V, b: V): V {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function rotateVector(point: V, degrees: number): V {
  return applyM2(rotationM2(degrees), point);
}

export function applyM2(matrix: M2, point: V): V {
  return {
    x: matrix.xx * point.x + matrix.xy * point.y,
    y: matrix.yx * point.x + matrix.yy * point.y,
  };
}

/** Matrix composition: result(point) = left(right(point)). */
export function multiplyM2(left: M2, right: M2): M2 {
  return {
    xx: left.xx * right.xx + left.xy * right.yx,
    xy: left.xx * right.xy + left.xy * right.yy,
    yx: left.yx * right.xx + left.yy * right.yx,
    yy: left.yx * right.xy + left.yy * right.yy,
  };
}

export function rotationM2(degrees: number): M2 {
  const radians = deg2rad(degrees);
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return { xx: cosine, xy: -sine, yx: sine, yy: cosine };
}

export function scaleM2(scaleX: number, scaleY: number): M2 {
  return { xx: scaleX, xy: 0, yx: 0, yy: scaleY };
}

export function transformPointAroundAnchor(point: V, anchor: V, scale: V): V {
  return {
    x: anchor.x + (point.x - anchor.x) * scale.x,
    y: anchor.y + (point.y - anchor.y) * scale.y,
  };
}

/**
 * Apply a group-frame scale to a child's local linear transform without losing shear.
 * relativeRotationDeg = child rotation - group rotation.
 */
export function scaleLinearInParentFrame(
  linear: M2,
  relativeRotationDeg: number,
  scale: V,
): M2 {
  const toParent = rotationM2(relativeRotationDeg);
  const toChild = rotationM2(-relativeRotationDeg);
  return multiplyM2(
    toChild,
    multiplyM2(scaleM2(scale.x, scale.y), multiplyM2(toParent, linear)),
  );
}

/**
 * Scale for one resize axis. Crossing the fixed anchor is clamped instead of mirrored.
 */
export function anchoredAxisScale(
  pointer: number,
  anchor: number,
  direction: -1 | 0 | 1,
  startHalf: number,
  minHalf: number,
  maxFactor: number,
) {
  if (direction === 0) return 1;
  if (!Number.isFinite(pointer) || !Number.isFinite(anchor) || startHalf <= 0) return 1;

  const signedSpan = direction * (pointer - anchor);
  const nextHalf = clamp(signedSpan / 2, minHalf, startHalf * maxFactor);
  return nextHalf / startHalf;
}

export function matrixAxisLengths(matrix: M2): V {
  return {
    x: Math.hypot(matrix.xx, matrix.yx),
    y: Math.hypot(matrix.xy, matrix.yy),
  };
}

export function isFiniteV(point: V) {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

export function isFiniteM2(matrix: M2) {
  return [matrix.xx, matrix.xy, matrix.yx, matrix.yy].every(Number.isFinite);
}

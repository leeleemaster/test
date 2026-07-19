import { describe, expect, it } from 'vitest';
import {
  IDENTITY_M2,
  anchoredAxisScale,
  applyM2,
  multiplyM2,
  rotateVector,
  rotationM2,
  scaleLinearInParentFrame,
  scaleM2,
  transformPointAroundAnchor,
} from './transform-math';

const expectPointClose = (actual: { x: number; y: number }, expected: { x: number; y: number }) => {
  expect(actual.x).toBeCloseTo(expected.x, 10);
  expect(actual.y).toBeCloseTo(expected.y, 10);
};

describe('anchored transforms', () => {
  it('keeps the opposite anchor fixed', () => {
    const anchor = { x: -12, y: 7 };
    expectPointClose(transformPointAroundAnchor(anchor, anchor, { x: 2.5, y: 0.4 }), anchor);
  });

  it('returns to the exact snapshot when the scale returns to one', () => {
    const anchor = { x: -4, y: 3 };
    const point = { x: 8, y: -5 };
    const moved = transformPointAroundAnchor(point, anchor, { x: 3, y: 0.5 });
    const restored = transformPointAroundAnchor(
      moved,
      anchor,
      { x: 1 / 3, y: 2 },
    );
    expectPointClose(restored, point);
  });

  it('clamps a handle that crosses its anchor instead of mirroring it', () => {
    expect(anchoredAxisScale(-20, 0, 1, 10, 2, 100)).toBeCloseTo(0.2);
    expect(anchoredAxisScale(40, 0, 1, 10, 2, 100)).toBeCloseTo(2);
  });
});

describe('parent-frame non-uniform scaling', () => {
  it('matches a full affine transform for a rotated child', () => {
    const relativeRotation = 45;
    const scale = { x: 2, y: 0.6 };
    const localPoint = { x: 3, y: -2 };
    const nextLinear = scaleLinearInParentFrame(IDENTITY_M2, relativeRotation, scale);

    const expectedInParent = applyM2(
      scaleM2(scale.x, scale.y),
      rotateVector(localPoint, relativeRotation),
    );
    const actualInParent = rotateVector(applyM2(nextLinear, localPoint), relativeRotation);

    expectPointClose(actualInParent, expectedInParent);
  });

  it('round-trips a sheared child without accumulating per-frame deltas', () => {
    const base = multiplyM2(rotationM2(12), scaleM2(1.3, 0.8));
    const expanded = scaleLinearInParentFrame(base, 37, { x: 2.4, y: 0.7 });
    const restored = scaleLinearInParentFrame(expanded, 37, { x: 1 / 2.4, y: 1 / 0.7 });

    expect(restored.xx).toBeCloseTo(base.xx, 10);
    expect(restored.xy).toBeCloseTo(base.xy, 10);
    expect(restored.yx).toBeCloseTo(base.yx, 10);
    expect(restored.yy).toBeCloseTo(base.yy, 10);
  });
});

import { describe, expect, it } from 'vitest';
import {
  cameraDuration,
  cameraProgress,
  centerDelta,
  markLayout,
} from '../../packages/extraction/src/camera';

describe('cameraDuration', () => {
  it('gives a long glide that still scales with distance', () => {
    expect(cameraDuration(80)).toBe(480);
    expect(cameraDuration(400)).toBeGreaterThan(cameraDuration(80));
    expect(cameraDuration(400)).toBeLessThan(cameraDuration(2400));
    expect(cameraDuration(4000)).toBe(1100);
  });
});

describe('cameraProgress', () => {
  it('winds up, drifts past the target, and rests there', () => {
    expect(cameraProgress(0, 400)).toBe(0);
    expect(cameraProgress(0.06, 400)).toBeLessThan(0);
    expect(cameraProgress(0.78, 400)).toBeGreaterThan(1);
    expect(cameraProgress(1, 400)).toBeCloseTo(1, 3);
  });

  it('skips the wind-up on a short hop', () => {
    expect(cameraProgress(0.05, 40)).toBeGreaterThanOrEqual(0);
    expect(cameraProgress(1, 40)).toBeCloseTo(1, 3);
  });
});

describe('centerDelta', () => {
  it('is how far the viewport must move to put the box in the middle', () => {
    expect(centerDelta({ left: 0, top: 500, width: 100, height: 80 }, 0, 800)).toBe(140);
    expect(centerDelta({ left: 0, top: 200, width: 100, height: 40 }, 0, 800)).toBe(-180);
  });
});

describe('markLayout', () => {
  it('puts a ring around the quote and a chip above it', () => {
    expect(markLayout({ left: 100, top: 200, width: 320, height: 48 })).toEqual({
      plate: {
        width: 344,
        height: 72,
        transform: 'translate3d(88px, 188px, 0)',
      },
      chip: {
        transform: 'translate3d(100px, 164px, 0)',
      },
    });
  });

  it('stays on-screen when the passage is flush left and near the top', () => {
    const mark = markLayout({ left: 4, top: 10, width: 200, height: 20 });
    expect(mark.plate.transform).toBe('translate3d(8px, 8px, 0)');
    expect(mark.chip.transform).toBe('translate3d(8px, 8px, 0)');
  });
});

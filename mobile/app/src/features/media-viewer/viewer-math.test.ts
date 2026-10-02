import { clampOffset, fittedSize, settlePage, shouldDismiss } from './viewer-math';

describe('image viewer geometry', () => {
  it('fits an image inside the screen, keeping its shape', () => {
    const wide = fittedSize({ width: 1200, height: 800 }, { width: 400, height: 800 });
    expect(wide.width).toBeCloseTo(400);
    expect(wide.height).toBeCloseTo(800 / 3);
    expect(fittedSize({ width: 500, height: 2000 }, { width: 400, height: 800 })).toEqual({ width: 200, height: 800 });
    expect(fittedSize({ width: 0, height: 0 }, { width: 400, height: 800 })).toEqual({ width: 400, height: 800 });
  });

  it('lets a zoomed image pan only as far as it overhangs the screen', () => {
    // 400 wide at 2x overhangs 200 on each side.
    expect(clampOffset(500, 400, 400, 2)).toBe(200);
    expect(clampOffset(-500, 400, 400, 2)).toBe(-200);
    expect(clampOffset(50, 400, 400, 2)).toBe(50);
    // A short image zoomed 2x that still fits vertically does not pan vertically.
    expect(clampOffset(80, 300, 800, 2)).toBe(0);
  });

  it('turns at most one page per swipe, by distance or speed, inside the list', () => {
    expect(settlePage(0, -150, 0, 400, 3)).toBe(1);
    expect(settlePage(1, 150, 0, 400, 3)).toBe(0);
    expect(settlePage(1, -20, -900, 400, 3)).toBe(2);
    expect(settlePage(1, -40, 0, 400, 3)).toBe(1);
    expect(settlePage(2, -300, -2000, 400, 3)).toBe(2);
    expect(settlePage(0, 300, 2000, 400, 3)).toBe(0);
  });

  it('dismisses on a long or fast vertical drag, either way', () => {
    expect(shouldDismiss(150, 0)).toBe(true);
    expect(shouldDismiss(-150, 0)).toBe(true);
    expect(shouldDismiss(30, 1200)).toBe(true);
    expect(shouldDismiss(60, 200)).toBe(false);
  });
});

import { forwardRef, useImperativeHandle, useRef } from 'react';
import { GRID_SIZE, rasterize, type Modules } from '@lumina/protocol';

export const QUIET_MODULES = 4;
const SIDE = GRID_SIZE + QUIET_MODULES * 2;

export interface GridCanvasHandle {
  draw(modules: Modules): void;
}

// One canvas pixel per module, scaled up by CSS with nearest-neighbour so
// module edges stay hard. Drawing is imperative to keep React out of the
// 30 Hz hot path.
export const GridCanvas = forwardRef<GridCanvasHandle, { className?: string }>(function GridCanvas({ className }, ref) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useImperativeHandle(ref, () => ({
    draw(modules) {
      const ctx = canvas.current?.getContext('2d');
      if (!ctx) return;
      const img = rasterize(modules, 1, QUIET_MODULES);
      ctx.putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
    },
  }));

  return (
    <canvas
      ref={canvas}
      width={SIDE}
      height={SIDE}
      data-testid="grid"
      className={className}
      style={{ imageRendering: 'pixelated', aspectRatio: '1 / 1' }}
    />
  );
});

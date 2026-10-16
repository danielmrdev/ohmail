/**
 * THE FRAMEBUFFER READ. Playwright's `page.screenshot` re-renders the page through the protocol, so
 * a caret painted twice by the browser's own repaint path cannot appear in it. `xwd -root` reads the
 * X server's framebuffer — the pixels the person would see — and this parses that XWD (ZPixmap,
 * 24 or 32 bpp) and counts caret-shaped bars of the harness's caret colour (pure red) inside a rect.
 * A caret is a vertical run ≥ 10 px, ≤ 4 px wide; two clusters of columns are two carets.
 */
import { execFileSync } from "node:child_process";

export interface Frame { width: number; height: number; px: (x: number, y: number) => [number, number, number] }

export function grabFrame(display: string): Frame {
  const buf = execFileSync("xwd", ["-root", "-silent", "-display", display], { maxBuffer: 256 * 1024 * 1024 });
  const u32 = (i: number) => buf.readUInt32BE(i * 4);
  const headerSize = u32(0), format = u32(2), width = u32(4), height = u32(5);
  const byteOrder = u32(7), bpp = u32(11), bytesPerLine = u32(12);
  const rMask = u32(14), gMask = u32(15), bMask = u32(16), ncolors = u32(19);
  if (format !== 2 || (bpp !== 32 && bpp !== 24)) throw new Error(`xwd: unsupported format ${format} bpp ${bpp}`);
  const bytes = bpp / 8;
  const data = headerSize + ncolors * 12;
  const shift = (m: number) => { let s = 0; while (((m >>> s) & 1) === 0 && s < 32) s++; return s; };
  const rs = shift(rMask), gs = shift(gMask), bs = shift(bMask);
  const px = (x: number, y: number): [number, number, number] => {
    const o = data + y * bytesPerLine + x * bytes;
    const v = bytes === 4
      ? (byteOrder === 1 ? buf.readUInt32BE(o) : buf.readUInt32LE(o))
      : (byteOrder === 1 ? buf.readUIntBE(o, 3) : buf.readUIntLE(o, 3));
    return [(v & rMask) >>> rs, (v & gMask) >>> gs, (v & bMask) >>> bs];
  };
  return { width, height, px };
}

/** The first pure-magenta pixel — the harness's probe square — as the page's origin on screen. */
export function findProbe(f: Frame): { x: number; y: number } | null {
  for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) {
    const [r, g, b] = f.px(x, y);
    if (r >= 240 && g <= 20 && b >= 240) return { x, y };
  }
  return null;
}

export interface Caret { x0: number; x1: number; y0: number; y1: number }

/** Caret-red vertical bars inside the rect, as column clusters. */
export function carets(f: Frame, rect: { x: number; y: number; w: number; h: number }): Caret[] {
  const isRed = (x: number, y: number) => { const [r, g, b] = f.px(x, y); return r >= 180 && g <= 90 && b <= 90; };
  const cols: Array<{ x: number; y0: number; y1: number } | null> = [];
  for (let x = rect.x; x < rect.x + rect.w; x++) {
    let best: { y0: number; y1: number } | null = null, run = -1;
    for (let y = rect.y; y <= rect.y + rect.h; y++) {
      const red = y < rect.y + rect.h && isRed(x, y);
      if (red && run < 0) run = y;
      if (!red && run >= 0) { if (y - run >= 10 && (!best || y - run > best.y1 - best.y0)) best = { y0: run, y1: y }; run = -1; }
    }
    cols.push(best ? { x, ...best } : null);
  }
  const out: Caret[] = [];
  for (const c of cols) {
    if (!c) continue;
    const last = out[out.length - 1];
    if (last && c.x === last.x1 + 1 && Math.abs(c.y0 - last.y0) <= 3) { last.x1 = c.x; last.y0 = Math.min(last.y0, c.y0); last.y1 = Math.max(last.y1, c.y1); }
    else out.push({ x0: c.x, x1: c.x, y0: c.y0, y1: c.y1 });
  }
  return out.filter((c) => c.x1 - c.x0 + 1 <= 4);
}

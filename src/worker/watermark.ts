const NEWLINE = 0x0a;

export interface WatermarkedRead {
  readonly lines: string[];
  readonly watermark: number;
  readonly regressed: boolean;
}

export interface WatermarkOptions {
  readonly flushPartial?: boolean;
}

export function readWatermarkedLines(
  bytes: Buffer,
  watermark: number,
  options: WatermarkOptions = {},
): WatermarkedRead {
  if (watermark < 0) {
    throw new Error(`readWatermarkedLines: watermark must not be negative (got ${watermark})`);
  }
  if (bytes.length < watermark) {
    return { lines: [], watermark, regressed: true };
  }

  const lines: string[] = [];
  let cursor = watermark;
  for (let i = watermark; i < bytes.length; i++) {
    if (bytes[i] !== NEWLINE) continue;
    lines.push(bytes.subarray(cursor, i).toString("utf8"));
    cursor = i + 1;
  }

  if (options.flushPartial && cursor < bytes.length) {
    lines.push(bytes.subarray(cursor, bytes.length).toString("utf8"));
    cursor = bytes.length;
  }

  return { lines, watermark: cursor, regressed: false };
}

export class WatermarkedLineReader {
  constructor(private cursor = 0) {}

  get watermark(): number {
    return this.cursor;
  }

  read(bytes: Buffer, options: WatermarkOptions = {}): string[] {
    const result = readWatermarkedLines(bytes, this.cursor, options);
    this.cursor = result.watermark;
    return result.lines;
  }
}

export type Pt = { x: number; y: number };

export type Line = { name: string; a: Pt; b: Pt; cm: number; confidence: 'high' | 'low' };

export type MeasureResponse = {
  garment: string;
  px_per_cm: number;
  image_size: [number, number];
  lines: Line[];
  warnings: string[];
  measurements_cm: Record<string, number>;
};

/** A photo taken in the capture screen. Sizes are the displayed (EXIF-oriented) pixels. */
export type Shot = { uri: string; width: number; height: number; tiltDeg: number; takenAt: string };

/** One test run: what the app measured vs. what the tape said. */
export type TestRecord = {
  id: string;
  takenAt: string;
  tiltDeg: number;
  scaleMethod: 'calibration';
  calibrationCm: number;
  pxPerCm: number;
  measured: Record<string, number>;
  truth: Record<string, number | null>;
  note: string;
};

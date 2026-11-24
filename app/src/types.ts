export type Pt = { x: number; y: number };

export type Line = { name: string; a: Pt; b: Pt; cm: number; confidence: 'high' | 'low' };

export type MeasureResponse = {
  garment: string;
  px_per_cm: number;
  image_size: [number, number];
  lines: Line[];
  warnings: string[];
  measurements_cm: Record<string, number>;
  /** What the server used for the scale (absent when px_per_cm was sent directly). */
  reference?: {
    type: ReferenceKind;
    px_per_cm: number;
    detected: boolean;
    corners?: [number, number][];
    points?: [number, number][];
    size_cm?: [number, number];
  };
};

/** Objects of known size the user can lay next to the garment for scale. */
export type ReferenceKind = 'tape' | 'a4' | 'card' | 'rect';

/** How the scale of a test was obtained. 'ar' is the separate AR flow. */
export type ScaleMethod = ReferenceKind | 'ar';

/** What the app sends to the server for the scale. Corners are image px, any order;
 *  leave them out for a4/card/rect and the server finds the object itself. */
export type Scale =
  | { type: 'tape'; p1: Pt; p2: Pt; cm: number }
  | { type: 'a4' | 'card'; corners?: Pt[] }
  | { type: 'rect'; wCm: number; hCm: number; corners?: Pt[] }
  | { type: 'px_per_cm'; pxPerCm: number };

/** Scale details kept with a test record. */
export type ScaleInfo = {
  method: ScaleMethod;
  /** tape only: the distance between the two taps */
  calibrationCm: number | null;
  /** a4 / card / rect: object size and whether the server found it by itself */
  reference?: { wCm: number; hCm: number; autoDetected: boolean };
};

/** A photo taken in the capture screen. Sizes are the displayed (EXIF-oriented) pixels. */
export type Shot = {
  uri: string;
  width: number;
  height: number;
  tiltDeg: number;
  takenAt: string;
  /** set by the AR flow when the scale is already known */
  pxPerCm?: number;
  arDistanceCm?: number;
};

/** One test run: what the app measured vs. what the tape said. */
export type TestRecord = {
  id: string;
  takenAt: string;
  tiltDeg: number;
  /** 'calibration' = tape in records saved before reference options existed */
  scaleMethod: ScaleMethod | 'calibration';
  calibrationCm: number | null;
  reference?: ScaleInfo['reference'];
  pxPerCm: number;
  measured: Record<string, number>;
  truth: Record<string, number | null>;
  note: string;
};

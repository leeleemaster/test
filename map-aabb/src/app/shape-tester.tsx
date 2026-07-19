import { useCallback, useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {
  IDENTITY_M2,
  anchoredAxisScale,
  applyM2,
  isFiniteM2,
  isFiniteV,
  matrixAxisLengths,
  multiplyM2,
  normalizeDeg,
  rad2deg,
  rotateVector,
  scaleLinearInParentFrame,
  scaleM2,
  transformPointAroundAnchor,
  type M2,
  type V,
} from './transform-math';

/**
 * 그룹 도형 / 단일 도형 변환 테스터 (MapLibre 맵 위 SVG 오버레이)
 *
 * GROUP_TRANSFORM_ISSUES.md 케이스를 실제 맵 위에서 검증한다.
 * - 단일 도형: 이동 / 회전 / 리사이즈
 * - 그룹 도형: 여러 개 선택 → 선택 사각형이 자식들에게 회전/스케일 전달
 * - 좌표계: 도형 중심은 lng/lat, 로컬 정점은 미터(+Y = 북쪽). mercator로 화면 투영.
 *   → screen Y(아래로 증가)와 북쪽(+Y) 반전이 실제로 발생 (가이드의 MAP 모드).
 * - 버그 재현: 회전 각도를 로컬 미터 프레임이 아닌 화면 프레임 부호로 측정 → C-1 (90° 점프).
 */

const STYLE_URL = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
const CENTER: [number, number] = [126.978, 37.5665];

type LngLat = { lng: number; lat: number };

type Shape = {
  id: string;
  color: string;
  center: LngLat;      // 도형 중심 (지도 좌표)
  rotationDeg: number; // 로컬 미터 프레임(+Y 북) 기준 회전
  linear: M2;          // 로컬 정점에 적용되는 일반 2x2 변형(비균일 스케일·전단 포함)
  local: V[];          // 중심 기준 로컬 미터 정점
};

/**
 * lng/lat 중심 기준 로컬 미터 프레임.
 * +Y = 북(mercator y 감소 방향), +X = 동.
 */
class MeterFrame {
  private merc: maplibregl.MercatorCoordinate;
  private mPer: number;
  constructor(center: LngLat) {
    this.merc = maplibregl.MercatorCoordinate.fromLngLat([center.lng, center.lat], 0);
    this.mPer = this.merc.meterInMercatorCoordinateUnits();
  }
  /** 로컬 미터 → lng/lat */
  toLngLat(v: V): LngLat {
    const mx = this.merc.x + v.x * this.mPer;
    const my = this.merc.y - v.y * this.mPer; // 북쪽 = mercator y 감소
    const ll = new maplibregl.MercatorCoordinate(mx, my, 0).toLngLat();
    return { lng: ll.lng, lat: ll.lat };
  }
  /** lng/lat → 로컬 미터 */
  toMeters(ll: LngLat): V {
    const m = maplibregl.MercatorCoordinate.fromLngLat([ll.lng, ll.lat], 0);
    return { x: (m.x - this.merc.x) / this.mPer, y: -(m.y - this.merc.y) / this.mPer };
  }
}

let idCounter = 0;
function makePoly(center: LngLat, n: number, r: number, color: string): Shape {
  const local: V[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + Math.PI / 2;
    local.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return { id: `s${idCounter++}`, color, center, rotationDeg: 0, linear: { ...IDENTITY_M2 }, local };
}
function makeRect(center: LngLat, w: number, h: number, color: string): Shape {
  return {
    id: `s${idCounter++}`,
    color,
    center,
    rotationDeg: 0,
    linear: { ...IDENTITY_M2 },
    local: [
      { x: -w / 2, y: h / 2 },
      { x: w / 2, y: h / 2 },
      { x: w / 2, y: -h / 2 },
      { x: -w / 2, y: -h / 2 },
    ],
  };
}
/** 중심에서 동/북으로 미터만큼 떨어진 지점 */
function offsetLngLat(base: LngLat, eastM: number, northM: number): LngLat {
  return new MeterFrame(base).toLngLat({ x: eastM, y: northM });
}

function initialShapes(): Shape[] {
  idCounter = 0;
  const c: LngLat = { lng: CENTER[0], lat: CENTER[1] };
  return [
    makeRect(offsetLngLat(c, -260, -40), 140, 90, '#4f8cff'),
    makePoly(offsetLngLat(c, -80, 20), 3, 70, '#ff6b6b'),
    makePoly(offsetLngLat(c, 120, -20), 6, 60, '#28c07f'),
    makeRect(offsetLngLat(c, 320, -30), 110, 110, '#f5a623'),
    makePoly(offsetLngLat(c, 40, 220), 5, 65, '#a678f0'),
  ];
}

function shapeLocalBounds(shape: Shape): { center: V; half: V } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const lp of shape.local) {
    const transformed = applyM2(shape.linear, lp);
    minX = Math.min(minX, transformed.x);
    minY = Math.min(minY, transformed.y);
    maxX = Math.max(maxX, transformed.x);
    maxY = Math.max(maxY, transformed.y);
  }
  return {
    center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
    half: { x: (maxX - minX) / 2, y: (maxY - minY) / 2 },
  };
}
/** 도형의 로컬 미터 정점 (스케일+회전 적용, 중심 기준) */
function shapeLocalWorldVerts(shape: Shape): V[] {
  return shape.local.map((lp) => rotateVector(applyM2(shape.linear, lp), shape.rotationDeg));
}

/**
 * 선택된 자식들의 tight 그룹 박스 (회전된 그룹 로컬 프레임의 AABB).
 * rotationDeg는 지속 상태(groupRotation)에서 받는다. 나머지는 자식에서 도출 → 항상 tight.
 */
function computeGroupBox(sel: Shape[], rotationDeg: number): GroupBox {
  let sx = 0;
  let sy = 0;
  for (const s of sel) {
    const m = maplibregl.MercatorCoordinate.fromLngLat([s.center.lng, s.center.lat], 0);
    sx += m.x;
    sy += m.y;
  }
  const cm = new maplibregl.MercatorCoordinate(sx / sel.length, sy / sel.length, 0).toLngLat();
  const center: LngLat = { lng: cm.lng, lat: cm.lat };
  const mf = new MeterFrame(center);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of sel) {
    const sf = new MeterFrame(s.center);
    for (const v of shapeLocalWorldVerts(s)) {
      const gl = rotateVector(mf.toMeters(sf.toLngLat(v)), -rotationDeg); // 그룹 로컬 축
      minX = Math.min(minX, gl.x);
      minY = Math.min(minY, gl.y);
      maxX = Math.max(maxX, gl.x);
      maxY = Math.max(maxY, gl.y);
    }
  }
  return {
    center,
    rotationDeg,
    boxCenterLocal: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
    half: { x: (maxX - minX) / 2, y: (maxY - minY) / 2 },
  };
}

const HANDLE = 8;
const ROT_OFFSET_M = 45;

// ---- 드래그 상태 ----
type Snapshot = { id: string; center: LngLat; rotationDeg: number; linear: M2 };

/**
 * 그룹 선택 박스 (OBB). 회전각만 지속 상태(groupRotation)로 두고,
 * 박스 자체는 "회전된 그룹 로컬 프레임의 AABB"로 매 렌더 tight하게 도출한다.
 * - 회전: 자식이 그룹 로컬에서 안 움직임 → 박스가 강체로 회전 (안 튐)
 * - 스케일: 박스가 자식을 항상 tight하게 감쌈 (안 삐져나옴)
 */
type GroupBox = {
  center: LngLat;      // 프레임 원점 (자식 중심들의 centroid)
  rotationDeg: number;
  boxCenterLocal: V;   // AABB 중심 (그룹 로컬 미터)
  half: V;             // AABB half (그룹 로컬 미터)
};

type Drag =
  | { kind: 'move'; ids: string[]; snaps: Snapshot[]; pointerStart: LngLat }
  | {
      kind: 'rotate';
      ids: string[];
      snaps: Snapshot[];
      frame: MeterFrame;          // 원점 = 도형 중심 (피벗)
      handleAngleStart: number;
    }
  | {
      kind: 'group-rotate';
      ids: string[];
      snaps: Snapshot[];
      center: LngLat;             // 그룹 피벗 (고정, E-5)
      frame: MeterFrame;
      rotStart: number;
      handleAngleStart: number;
    }
  | {
      kind: 'resize';
      id: string;
      snap: Snapshot;
      halfStart: V;
      anchorLocal: V;
      dir: V;                     // 핸들 방향 (-1/0/1)
    }
  | {
      kind: 'group-scale';
      ids: string[];
      snaps: Snapshot[];
      center: LngLat;             // 그룹 프레임 시작 중심 (고정)
      frame: MeterFrame;
      rotStart: number;           // 그룹 회전 (드래그 내내 고정)
      halfStart: V;               // 그룹 half 시작값 (미터)
      anchorLocal: V;             // 반대편 모서리 (그룹 로컬)
      dir: V;                     // 핸들 방향 (그룹 로컬축)
    };

/** 8개 핸들 방향: 모서리 4 + 각 변 중앙(L·R·T·B) 4. +Y = 위(북). */
const HANDLE_DIRS: V[] = [
  { x: -1, y: 1 },  // TL
  { x: 0, y: 1 },   // T
  { x: 1, y: 1 },   // TR
  { x: 1, y: 0 },   // R
  { x: 1, y: -1 },  // BR
  { x: 0, y: -1 },  // B
  { x: -1, y: -1 }, // BL
  { x: -1, y: 0 },  // L
];
function cursorForDir(dir: V): string {
  if (dir.x !== 0 && dir.y !== 0) return dir.x * dir.y > 0 ? 'nesw-resize' : 'nwse-resize';
  return dir.x !== 0 ? 'ew-resize' : 'ns-resize';
}
function cursorForScreenAxis(center: V, handle: V, fallbackDir: V): string {
  const dx = handle.x - center.x;
  const dy = handle.y - center.y;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < 1e-6) {
    return cursorForDir(fallbackDir);
  }
  const angle = ((rad2deg(Math.atan2(dy, dx)) % 180) + 180) % 180;
  if (angle < 22.5 || angle >= 157.5) return 'ew-resize';
  if (angle < 67.5) return 'nwse-resize';
  if (angle < 112.5) return 'ns-resize';
  return 'nesw-resize';
}
function preparePrimaryPointer(e: React.PointerEvent) {
  if (e.button !== 0) return false;
  e.preventDefault();
  e.stopPropagation();
  e.currentTarget.setPointerCapture?.(e.pointerId);
  return true;
}
const MIN_HALF_M = 2; // 최소 half 크기(미터)
const MAX_SCALE_FACTOR = 100;

type CameraControlSnapshot = Array<{
  wasEnabled: boolean;
  enable: () => void;
  disable: () => void;
}>;

type ShapeTesterProps = {
  diagnostics?: boolean;
  initialPitch?: number;
  initialBearing?: number;
};

export function ShapeTester({ diagnostics = false, initialPitch = 0, initialBearing = 0 }: ShapeTesterProps = {}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [, forceTick] = useState(0);

  const [shapes, setShapes] = useState<Shape[]>(() => initialShapes());
  const [selected, setSelected] = useState<string[]>([]);
  const [buggyAngle, setBuggyAngle] = useState(false);
  const [groupRotation, setGroupRotation] = useState(0); // 그룹 지속 회전각 (나머지는 자식에서 도출)
  const [cameraState, setCameraState] = useState({ pitch: initialPitch, bearing: initialBearing, zoom: 15 });
  const [cameraLocked, setCameraLocked] = useState(false);

  const shapesRef = useRef(shapes);
  shapesRef.current = shapes;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const buggyRef = useRef(buggyAngle);
  buggyRef.current = buggyAngle;
  const groupRotationRef = useRef(groupRotation);
  groupRotationRef.current = groupRotation;
  const dragRef = useRef<Drag | null>(null);
  const cameraControlsRef = useRef<CameraControlSnapshot | null>(null);

  const unlockCameraControls = useCallback(() => {
    const controls = cameraControlsRef.current;
    cameraControlsRef.current = null;
    if (!controls) return;
    for (const control of controls) {
      if (control.wasEnabled) control.enable();
    }
    setCameraLocked(false);
  }, []);

  const lockCameraControls = useCallback(() => {
    const map = mapRef.current;
    if (!map || cameraControlsRef.current) return;
    map.stop();
    const handlers = [
      map.dragPan,
      map.dragRotate,
      map.scrollZoom,
      map.boxZoom,
      map.doubleClickZoom,
      map.keyboard,
      map.touchZoomRotate,
      map.touchPitch,
    ];
    cameraControlsRef.current = handlers.map((handler) => ({
      wasEnabled: handler.isEnabled(),
      enable: () => handler.enable(),
      disable: () => handler.disable(),
    }));
    for (const control of cameraControlsRef.current) control.disable();
    setCameraLocked(true);
  }, []);

  const beginTransform = useCallback((drag: Drag) => {
    lockCameraControls();
    dragRef.current = drag;
  }, [lockCameraControls]);

  const cancelActiveTransform = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    const snapshots = drag.kind === 'resize' ? [drag.snap] : drag.snaps;
    setShapes((prev) => prev.map((shape) => {
      const snapshot = snapshots.find((item) => item.id === shape.id);
      return snapshot
        ? {
            ...shape,
            center: { ...snapshot.center },
            rotationDeg: snapshot.rotationDeg,
            linear: { ...snapshot.linear },
          }
        : shape;
    }));
    if (drag.kind === 'group-rotate') setGroupRotation(drag.rotStart);
    dragRef.current = null;
    unlockCameraControls();
  }, [unlockCameraControls]);

  const finishActiveTransform = useCallback(() => {
    dragRef.current = null;
    unlockCameraControls();
  }, [unlockCameraControls]);

  // ---- 맵 초기화 ----
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE_URL,
      center: CENTER,
      zoom: 15,
      pitch: initialPitch,
      bearing: initialBearing,
      attributionControl: false,
    });
    mapRef.current = map;
    const rerender = () => {
      forceTick((tick) => tick + 1);
      setCameraState({ pitch: map.getPitch(), bearing: map.getBearing(), zoom: map.getZoom() });
    };
    const cancelIfTransforming = () => {
      if (dragRef.current) cancelActiveTransform();
    };
    map.on('load', () => {
      setMapReady(true);
      rerender();
    });
    map.on('move', rerender);
    map.on('movestart', cancelIfTransforming);
    // 빈 곳(맵 캔버스) 클릭 시 선택 해제. 도형/핸들은 위에서 이벤트를 가로챈다.
    map.on('click', () => setSelected([]));
    return () => {
      map.off('move', rerender);
      map.off('movestart', cancelIfTransforming);
      unlockCameraControls();
      map.remove();
      mapRef.current = null;
    };
  }, [cancelActiveTransform, initialBearing, initialPitch, unlockCameraControls]);

  // ---- 투영 헬퍼 ----
  const project = useCallback((ll: LngLat): V => {
    const p = mapRef.current!.project([ll.lng, ll.lat]);
    return { x: p.x, y: p.y };
  }, []);
  const screenToGround = useCallback((screen: V): LngLat | null => {
    const map = mapRef.current;
    if (!map || !isFiniteV(screen)) return null;
    const lngLat = map.unproject([screen.x, screen.y]);
    if (!Number.isFinite(lngLat.lng) || !Number.isFinite(lngLat.lat)) return null;
    return { lng: lngLat.lng, lat: lngLat.lat };
  }, []);
  const pointerScreen = useCallback((e: PointerEvent | React.PointerEvent): V => {
    const r = containerRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }, []);
  const pointerLngLat = useCallback(
    (e: PointerEvent | React.PointerEvent): LngLat | null => screenToGround(pointerScreen(e)),
    [pointerScreen, screenToGround],
  );

  /** 도형 중심 기준으로 로컬 미터 정점 → 화면 */
  const shapeScreenVerts = useCallback(
    (shape: Shape): V[] => {
      const frame = new MeterFrame(shape.center);
      return shapeLocalWorldVerts(shape).map((v) => project(frame.toLngLat(v)));
    },
    [project],
  );

  /** 회전 각도 측정: 버그 모드면 부호 반전 (C-1) */
  const measureAngle = useCallback((center: V, p: V): number => {
    const raw = rad2deg(Math.atan2(p.y - center.y, p.x - center.x));
    return buggyRef.current ? -raw : raw;
  }, []);

  // ---- 그룹 회전각 리셋 (선택 SET이 바뀔 때만) ----
  useEffect(() => {
    setGroupRotation(0);
  }, [selected]);

  // ---- 그룹 박스 도출 (매 렌더, tight) ----
  const groupSel = selected.length >= 2 ? shapes.filter((s) => selected.includes(s.id)) : [];
  const groupBox =
    mapReady && groupSel.length >= 2 ? computeGroupBox(groupSel, groupRotation) : null;

  // ---- 드래그 시작 ----
  const snapOf = (ids: string[]): Snapshot[] =>
    shapesRef.current
      .filter((s) => ids.includes(s.id))
      .map((s) => ({ id: s.id, center: { ...s.center }, rotationDeg: s.rotationDeg, linear: { ...s.linear } }));

  const beginMove = (e: React.PointerEvent, ids: string[]) => {
    if (!preparePrimaryPointer(e)) return;
    const pointerStart = pointerLngLat(e);
    if (!pointerStart) return;
    // 그룹 박스는 자식에서 도출되므로 이동 시 자동으로 따라온다 (별도 처리 불필요).
    beginTransform({ kind: 'move', ids, snaps: snapOf(ids), pointerStart });
  };
  const beginSingleRotate = (e: React.PointerEvent, id: string) => {
    if (!preparePrimaryPointer(e)) return;
    const s = shapesRef.current.find((x) => x.id === id);
    if (!s) return;
    const pointer = pointerLngLat(e);
    if (!pointer) return;
    const frame = new MeterFrame(s.center);
    const pm = frame.toMeters(pointer);
    beginTransform({
      kind: 'rotate',
      ids: [id],
      snaps: snapOf([id]),
      frame,
      handleAngleStart: measureAngle({ x: 0, y: 0 }, pm),
    });
  };
  const beginSingleResize = (e: React.PointerEvent, id: string, dir: V) => {
    if (!preparePrimaryPointer(e)) return;
    const s = shapesRef.current.find((x) => x.id === id);
    if (!s) return;
    const bounds = shapeLocalBounds(s);
    beginTransform({
      kind: 'resize',
      id,
      snap: snapOf([id])[0],
      halfStart: { ...bounds.half },
      anchorLocal: {
        x: bounds.center.x - dir.x * bounds.half.x,
        y: bounds.center.y - dir.y * bounds.half.y,
      },
      dir,
    });
  };
  const beginGroupRotate = (e: React.PointerEvent) => {
    if (!preparePrimaryPointer(e)) return;
    const sel = shapesRef.current.filter((s) => selectedRef.current.includes(s.id));
    if (sel.length < 2) return;
    const gb = computeGroupBox(sel, groupRotationRef.current);
    const frame = new MeterFrame(gb.center); // 피벗 = centroid (회전에 불변)
    const pointer = pointerLngLat(e);
    if (!pointer) return;
    const pm = frame.toMeters(pointer);
    beginTransform({
      kind: 'group-rotate',
      ids: selectedRef.current,
      snaps: snapOf(selectedRef.current),
      center: gb.center,
      frame,
      rotStart: groupRotationRef.current,
      handleAngleStart: measureAngle({ x: 0, y: 0 }, pm),
    });
  };
  const beginGroupScale = (e: React.PointerEvent, dir: V) => {
    if (!preparePrimaryPointer(e)) return;
    const sel = shapesRef.current.filter((s) => selectedRef.current.includes(s.id));
    if (sel.length < 2) return;
    const gb = computeGroupBox(sel, groupRotationRef.current);
    beginTransform({
      kind: 'group-scale',
      ids: selectedRef.current,
      snaps: snapOf(selectedRef.current),
      center: gb.center,
      frame: new MeterFrame(gb.center),
      rotStart: gb.rotationDeg,
      halfStart: { ...gb.half },
      // 반대편 모서리 (그룹 로컬). 박스가 off-center일 수 있으므로 boxCenterLocal 기준.
      anchorLocal: {
        x: gb.boxCenterLocal.x - dir.x * gb.half.x,
        y: gb.boxCenterLocal.y - dir.y * gb.half.y,
      },
      dir,
    });
  };

  // ---- 전역 pointermove / up (H-4) ----
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d || !mapRef.current) return;

      if (d.kind === 'move') {
        const now = pointerLngLat(e);
        if (!now) return;
        const start = maplibregl.MercatorCoordinate.fromLngLat([d.pointerStart.lng, d.pointerStart.lat], 0);
        const cur = maplibregl.MercatorCoordinate.fromLngLat([now.lng, now.lat], 0);
        const dx = cur.x - start.x;
        const dy = cur.y - start.y;
        setShapes((prev) =>
          prev.map((s) => {
            const snap = d.snaps.find((n) => n.id === s.id);
            if (!snap) return s;
            const sm = maplibregl.MercatorCoordinate.fromLngLat([snap.center.lng, snap.center.lat], 0);
            const ll = new maplibregl.MercatorCoordinate(sm.x + dx, sm.y + dy, 0).toLngLat();
            return { ...s, center: { lng: ll.lng, lat: ll.lat } };
          }),
        );
        return;
      }

      if (d.kind === 'rotate') {
        // 단일 도형 제자리 회전
        const pointer = pointerLngLat(e);
        if (!pointer) return;
        const pm = d.frame.toMeters(pointer);
        if (!isFiniteV(pm)) return;
        const total = measureAngle({ x: 0, y: 0 }, pm) - d.handleAngleStart;
        setShapes((prev) =>
          prev.map((s) => {
            const snap = d.snaps.find((n) => n.id === s.id);
            if (!snap) return s;
            return { ...s, rotationDeg: normalizeDeg(snap.rotationDeg + total) };
          }),
        );
        return;
      }

      if (d.kind === 'group-rotate') {
        const pointer = pointerLngLat(e);
        if (!pointer) return;
        const pm = d.frame.toMeters(pointer);
        if (!isFiniteV(pm)) return;
        const total = measureAngle({ x: 0, y: 0 }, pm) - d.handleAngleStart; // 절대 - 시작 (A-2)
        setShapes((prev) =>
          prev.map((s) => {
            const snap = d.snaps.find((n) => n.id === s.id);
            if (!snap) return s;
            // 자식 중심 오프셋을 그룹 중심 기준 total 만큼 회전 (누산 없음)
            const offset = d.frame.toMeters(snap.center);
            const newCenterLL = d.frame.toLngLat(rotateVector(offset, total));
            return {
              ...s,
              center: newCenterLL,
              rotationDeg: normalizeDeg(snap.rotationDeg + total),
            };
          }),
        );
        // 지속 회전각만 갱신. 박스는 다음 렌더에 자식에서 tight하게 도출 → 강체 회전(안 튐).
        setGroupRotation(normalizeDeg(d.rotStart + total));
        return;
      }

      if (d.kind === 'resize') {
        // 반대편 anchor 고정. 일반 2x2 선형변환을 시작 스냅샷에 절대 적용한다.
        const s0 = d.snap;
        const pointer = pointerLngLat(e);
        if (!pointer) return;
        const frame = new MeterFrame(s0.center); // 원점 = 시작 중심 (고정)
        const pm = frame.toMeters(pointer);
        const pLocal = rotateVector(pm, -s0.rotationDeg); // 도형 로컬 축 (회전 제거)
        if (!isFiniteV(pLocal)) return;
        const cx = d.dir.x !== 0;
        const cy = d.dir.y !== 0;
        const sX = cx
          ? anchoredAxisScale(pLocal.x, d.anchorLocal.x, d.dir.x as -1 | 1, d.halfStart.x, MIN_HALF_M, MAX_SCALE_FACTOR)
          : 1;
        const sY = cy
          ? anchoredAxisScale(pLocal.y, d.anchorLocal.y, d.dir.y as -1 | 1, d.halfStart.y, MIN_HALF_M, MAX_SCALE_FACTOR)
          : 1;
        const resizeScale = { x: sX, y: sY };
        const nextOriginLocal = transformPointAroundAnchor({ x: 0, y: 0 }, d.anchorLocal, resizeScale);
        const newCenter = frame.toLngLat(rotateVector(nextOriginLocal, s0.rotationDeg));
        const newLinear = multiplyM2(scaleM2(sX, sY), s0.linear);
        if (!isFiniteM2(newLinear)) return;
        setShapes((prev) =>
          prev.map((s) =>
            s.id === d.id ? { ...s, center: newCenter, linear: newLinear } : s,
          ),
        );
        return;
      }

      if (d.kind === 'group-scale') {
        // OBB 리사이즈: 중심과 각 자식의 전체 선형변환에 같은 affine을 적용한다.
        const pointer = pointerLngLat(e);
        if (!pointer) return;
        const pm = d.frame.toMeters(pointer);
        const pLocal = rotateVector(pm, -d.rotStart); // 그룹 로컬 축 (회전 제거)
        if (!isFiniteV(pLocal)) return;
        const A = d.anchorLocal;
        const cx = d.dir.x !== 0;
        const cy = d.dir.y !== 0;
        const sX = cx
          ? anchoredAxisScale(pLocal.x, A.x, d.dir.x as -1 | 1, d.halfStart.x, MIN_HALF_M, MAX_SCALE_FACTOR)
          : 1;
        const sY = cy
          ? anchoredAxisScale(pLocal.y, A.y, d.dir.y as -1 | 1, d.halfStart.y, MIN_HALF_M, MAX_SCALE_FACTOR)
          : 1;
        const resizeScale = { x: sX, y: sY };
        setShapes((prev) =>
          prev.map((s) => {
            const snap = d.snaps.find((n) => n.id === s.id);
            if (!snap) return s;
            // 자식 중심을 그룹 로컬 프레임에서 A 기준 스케일 (P' = A + S·(P₀ − A))
            const offLocal = rotateVector(d.frame.toMeters(snap.center), -d.rotStart);
            const newOffLocal = transformPointAroundAnchor(offLocal, A, resizeScale);
            const newCenterLL = d.frame.toLngLat(rotateVector(newOffLocal, d.rotStart));
            const newLinear = scaleLinearInParentFrame(
              snap.linear,
              snap.rotationDeg - d.rotStart,
              resizeScale,
            );
            if (!isFiniteM2(newLinear)) return s;
            return {
              ...s,
              center: newCenterLL,
              linear: newLinear,
            };
          }),
        );
        // 박스는 다음 렌더에 자식에서 tight하게 도출 → 항상 자식을 감쌈(안 삐져나옴).
        return;
      }
    };

    const onUp = () => finishActiveTransform();
    const onCancel = () => cancelActiveTransform();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancelActiveTransform();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onCancel);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onCancel);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [cancelActiveTransform, finishActiveTransform, measureAngle, pointerLngLat]);

  // ---- 도형 선택/이동 ----
  const onShapePointerDown = (e: React.PointerEvent, id: string) => {
    if (e.shiftKey) {
      if (!preparePrimaryPointer(e)) return;
      setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
      return;
    }
    const sel = selectedRef.current;
    if (sel.includes(id) && sel.length >= 2) {
      beginMove(e, sel); // 그룹 이동
      return;
    }
    setSelected([id]);
    beginMove(e, [id]);
  };

  const reset = () => {
    finishActiveTransform();
    setShapes(initialShapes());
    setSelected([]);
  };

  const prepareMixedRotationCase = () => {
    finishActiveTransform();
    const next = initialShapes();
    next[0] = { ...next[0], rotationDeg: 45 };
    next[1] = { ...next[1], rotationDeg: -25 };
    setShapes(next);
    setSelected([next[0].id, next[1].id]);
  };

  const setCamera = (pitch: number, bearing: number) => {
    mapRef.current?.jumpTo({ pitch, bearing });
  };

  const single = selected.length === 1 ? shapes.find((s) => s.id === selected[0]) : null;

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />

      {/* SVG 오버레이 (맵 위). 컨테이너는 이벤트 통과, 도형/핸들만 이벤트 수신 */}
      {mapReady && (
        <svg
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            touchAction: 'none',
            pointerEvents: 'none',
          }}
        >
          {shapes.map((s) => {
            const pts = shapeScreenVerts(s);
            const isSel = selected.includes(s.id);
            return (
              <polygon
                key={s.id}
                points={pts.map((p) => `${p.x},${p.y}`).join(' ')}
                fill={s.color}
                fillOpacity={isSel ? 0.6 : 0.4}
                stroke={s.color}
                strokeWidth={isSel ? 3 : 1.5}
                style={{ cursor: 'move', pointerEvents: 'auto' }}
                onPointerDown={(e) => onShapePointerDown(e, s.id)}
              />
            );
          })}

          {single && (
            <SingleHandles
              shape={single}
              project={project}
              onRotate={(e) => beginSingleRotate(e, single.id)}
              onResize={(e, dir) => beginSingleResize(e, single.id, dir)}
            />
          )}

          {groupBox && (
            <GroupHandles
              box={groupBox}
              project={project}
              onRotate={beginGroupRotate}
              onScale={(e, dir) => beginGroupScale(e, dir)}
              onMove={(e) => beginMove(e, selected)}
            />
          )}
        </svg>
      )}

      {/* 컨트롤 패널 */}
      <div style={panelStyle}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>
          {diagnostics ? 'Pitch / Bearing 변환 테스트' : '도형 변환 테스터'}
        </div>
        {diagnostics && (
          <div style={{ padding: '9px 10px', marginBottom: 10, background: '#0f172a', borderRadius: 8 }}>
            <label style={{ display: 'block', marginBottom: 8 }}>
              Pitch <b>{cameraState.pitch.toFixed(0)}°</b>
              <input
                aria-label="Pitch"
                type="range"
                min={0}
                max={60}
                step={1}
                value={cameraState.pitch}
                onChange={(event) => setCamera(Number(event.target.value), cameraState.bearing)}
                style={{ width: '100%' }}
              />
            </label>
            <label style={{ display: 'block', marginBottom: 8 }}>
              Bearing <b>{cameraState.bearing.toFixed(0)}°</b>
              <input
                aria-label="Bearing"
                type="range"
                min={-180}
                max={180}
                step={1}
                value={cameraState.bearing}
                onChange={(event) => setCamera(cameraState.pitch, Number(event.target.value))}
                style={{ width: '100%' }}
              />
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 5 }}>
              <button style={miniBtnStyle} onClick={() => setCamera(0, 0)}>0 / 0</button>
              <button style={miniBtnStyle} onClick={() => setCamera(45, 45)}>45 / 45</button>
              <button style={miniBtnStyle} onClick={() => setCamera(60, 90)}>60 / 90</button>
            </div>
            <button
              style={{ ...miniBtnStyle, width: '100%', marginTop: 6 }}
              onClick={prepareMixedRotationCase}
            >
              혼합 회전 그룹 준비 (45° / -25°)
            </button>
            <div style={{ marginTop: 8, fontSize: 11, color: cameraLocked ? '#fbbf24' : '#86efac' }}>
              {cameraLocked ? '도형 변환 중 · 카메라 임시 잠금' : `카메라 조작 가능 · zoom ${cameraState.zoom.toFixed(1)}`}
            </div>
          </div>
        )}
        <label style={rowStyle}>
          <input type="checkbox" checked={buggyAngle} onChange={(e) => setBuggyAngle(e.target.checked)} />
          버그 재현 (각도 부호 반전 · C-1)
        </label>
        <button style={btnStyle} onClick={reset}>리셋</button>
        <div style={{ marginTop: 10, fontSize: 12, lineHeight: 1.6, color: '#c7d0e0' }}>
          선택: <b>{selected.length}</b>개{selected.length >= 2 && ' (그룹)'}
          {single && (
            <>
              <br />회전: <b>{single.rotationDeg.toFixed(1)}°</b>
              <br />축 길이: <b>{matrixAxisLengths(single.linear).x.toFixed(2)} × {matrixAxisLengths(single.linear).y.toFixed(2)}</b>
            </>
          )}
          <br />
          <span style={{ color: '#8a93a5' }}>
            · 도형 클릭 = 선택/이동
            <br />· Shift+클릭 = 다중 선택
            <br />· 빈 맵 클릭 = 선택 해제
            <br />· 2개 이상 = 그룹 핸들
            {diagnostics && (
              <>
                <br />· 권장: 60/90에서 8개 핸들·회전·왕복 확인
                <br />· 드래그 중 카메라 변경 시 변환 자동 취소
              </>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

// ---------- 핸들 컴포넌트 ----------
function SingleHandles({
  shape,
  project,
  onRotate,
  onResize,
}: {
  shape: Shape;
  project: (ll: LngLat) => V;
  onRotate: (e: React.PointerEvent) => void;
  onResize: (e: React.PointerEvent, dir: V) => void;
}) {
  const frame = new MeterFrame(shape.center);
  const bounds = shapeLocalBounds(shape);
  const half = bounds.half;
  const c = bounds.center;
  const toScreen = (local: V) => project(frame.toLngLat(rotateVector(local, shape.rotationDeg)));
  // 외곽선 (모서리 4점)
  const outline = [
    { x: c.x - half.x, y: c.y + half.y },
    { x: c.x + half.x, y: c.y + half.y },
    { x: c.x + half.x, y: c.y - half.y },
    { x: c.x - half.x, y: c.y - half.y },
  ].map(toScreen);
  const topEdge = toScreen({ x: c.x, y: c.y + half.y });
  const rotPt = toScreen({ x: c.x, y: c.y + half.y + ROT_OFFSET_M });
  const centerScreen = toScreen(c);

  return (
    <g>
      <polygon
        points={outline.map((p) => `${p.x},${p.y}`).join(' ')}
        fill="none"
        stroke="#fff"
        strokeDasharray="4 3"
        pointerEvents="none"
      />
      <line x1={topEdge.x} y1={topEdge.y} x2={rotPt.x} y2={rotPt.y} stroke="#ffd93b" pointerEvents="none" />
      <circle
        cx={rotPt.x}
        cy={rotPt.y}
        r={HANDLE}
        fill="#ffd93b"
        style={{ cursor: 'grab', pointerEvents: 'auto' }}
        onPointerDown={onRotate}
      />
      {HANDLE_DIRS.map((dir, i) => {
        const p = toScreen({ x: c.x + dir.x * half.x, y: c.y + dir.y * half.y });
        return (
          <rect
            key={i}
            x={p.x - HANDLE / 2}
            y={p.y - HANDLE / 2}
            width={HANDLE}
            height={HANDLE}
            fill="#fff"
            stroke="#333"
            style={{ cursor: cursorForScreenAxis(centerScreen, p, dir), pointerEvents: 'auto' }}
            onPointerDown={(e) => onResize(e, dir)}
          />
        );
      })}
    </g>
  );
}

function GroupHandles({
  box,
  project,
  onRotate,
  onScale,
  onMove,
}: {
  box: GroupBox;
  project: (ll: LngLat) => V;
  onRotate: (e: React.PointerEvent) => void;
  onScale: (e: React.PointerEvent, dir: V) => void;
  onMove: (e: React.PointerEvent) => void;
}) {
  // OBB: 그룹 로컬 → 회전 → 미터 프레임 → 화면 (단일 도형과 동일 방식)
  const mf = new MeterFrame(box.center);
  const c = box.boxCenterLocal;
  const half = box.half;
  const toScreen = (local: V) =>
    project(mf.toLngLat(rotateVector({ x: c.x + local.x, y: c.y + local.y }, box.rotationDeg)));
  const outline = [
    { x: -half.x, y: half.y },
    { x: half.x, y: half.y },
    { x: half.x, y: -half.y },
    { x: -half.x, y: -half.y },
  ].map(toScreen);
  const topEdge = toScreen({ x: 0, y: half.y });
  const rotPt = toScreen({ x: 0, y: half.y + ROT_OFFSET_M });
  const centerScreen = toScreen({ x: 0, y: 0 });

  return (
    <g>
      <polygon
        points={outline.map((p) => `${p.x},${p.y}`).join(' ')}
        fill="#5b8cff14"
        stroke="#5b8cff"
        strokeWidth={2}
        style={{ cursor: 'move', pointerEvents: 'auto' }}
        onPointerDown={onMove}
      />
      <line x1={topEdge.x} y1={topEdge.y} x2={rotPt.x} y2={rotPt.y} stroke="#ffd93b" pointerEvents="none" />
      <circle
        cx={rotPt.x}
        cy={rotPt.y}
        r={HANDLE}
        fill="#ffd93b"
        style={{ cursor: 'grab', pointerEvents: 'auto' }}
        onPointerDown={onRotate}
      />
      {HANDLE_DIRS.map((dir, i) => {
        const p = toScreen({ x: dir.x * half.x, y: dir.y * half.y });
        return (
          <rect
            key={i}
            x={p.x - HANDLE / 2}
            y={p.y - HANDLE / 2}
            width={HANDLE}
            height={HANDLE}
            fill="#5b8cff"
            stroke="#fff"
            style={{ cursor: cursorForScreenAxis(centerScreen, p, dir), pointerEvents: 'auto' }}
            onPointerDown={(e) => onScale(e, dir)}
          />
        );
      })}
    </g>
  );
}

const panelStyle: React.CSSProperties = {
  position: 'absolute',
  top: 16,
  left: 16,
  padding: '14px 16px',
  background: '#182034ee',
  color: '#e7ecf5',
  borderRadius: 10,
  fontFamily: 'system-ui, sans-serif',
  fontSize: 13,
  minWidth: 210,
  boxShadow: '0 6px 24px #0008',
  zIndex: 5,
};
const rowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'center',
  margin: '6px 0',
  cursor: 'pointer',
};
const btnStyle: React.CSSProperties = {
  marginTop: 8,
  padding: '6px 12px',
  background: '#2d3a55',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
};
const miniBtnStyle: React.CSSProperties = {
  padding: '5px 4px',
  background: '#334155',
  color: '#fff',
  border: 'none',
  borderRadius: 5,
  cursor: 'pointer',
  fontSize: 11,
};

export default ShapeTester;

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

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

type V = { x: number; y: number };
type LngLat = { lng: number; lat: number };

type Shape = {
  id: string;
  color: string;
  center: LngLat;      // 도형 중심 (지도 좌표)
  rotationDeg: number; // 로컬 미터 프레임(+Y 북) 기준 회전
  scale: V;
  local: V[];          // 중심 기준 로컬 미터 정점
};

const DEG = Math.PI / 180;
const deg2rad = (d: number) => d * DEG;
const rad2deg = (r: number) => r / DEG;
const normalizeDeg = (v: number) => ((v % 360) + 360) % 360;

function rotate(p: V, deg: number): V {
  const r = deg2rad(deg);
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}
const add = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
const scaleV = (a: V, s: V): V => ({ x: a.x * s.x, y: a.y * s.y });

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
  return { id: `s${idCounter++}`, color, center, rotationDeg: 0, scale: { x: 1, y: 1 }, local };
}
function makeRect(center: LngLat, w: number, h: number, color: string): Shape {
  return {
    id: `s${idCounter++}`,
    color,
    center,
    rotationDeg: 0,
    scale: { x: 1, y: 1 },
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

function localHalfSize(shape: Shape): V {
  let mx = 0;
  let my = 0;
  for (const lp of shape.local) {
    mx = Math.max(mx, Math.abs(lp.x * shape.scale.x));
    my = Math.max(my, Math.abs(lp.y * shape.scale.y));
  }
  return { x: mx, y: my };
}
/** 도형의 로컬 미터 정점 (스케일+회전 적용, 중심 기준) */
function shapeLocalWorldVerts(shape: Shape): V[] {
  return shape.local.map((lp) => rotate(scaleV(lp, shape.scale), shape.rotationDeg));
}

const HANDLE = 8;
const ROT_OFFSET_M = 45;
const ROT_OFFSET_PX = 34; // 그룹 회전 핸들 화면 오프셋

// ---- 드래그 상태 ----
type Snapshot = { id: string; center: LngLat; rotationDeg: number; scale: V };

type Drag =
  | { kind: 'move'; ids: string[]; snaps: Snapshot[]; pointerStart: LngLat }
  | {
      kind: 'rotate' | 'group-rotate';
      ids: string[];
      snaps: Snapshot[];
      pivot: LngLat;              // 회전 중심 (드래그 내내 고정, E-5)
      frame: MeterFrame;
      handleAngleStart: number;
    }
  | {
      kind: 'resize';
      id: string;
      snap: Snapshot;
      halfUnit: V;                // 로컬 half (pre-scale)
      dir: V;                     // 핸들 방향 (-1/0/1)
    }
  | {
      kind: 'group-scale';
      ids: string[];
      snaps: Snapshot[];
      box: ScreenBox;            // 화면 픽셀 박스 (드래그 시작 고정)
      dir: V;                    // 핸들 방향 (화면축)
    }
  ;

/** 화면 픽셀 AABB */
type ScreenBox = { cx: number; cy: number; hx: number; hy: number };

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
const MIN_HALF_M = 2; // 최소 half 크기(미터)

export function ShapeTester() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [, forceTick] = useState(0);

  const [shapes, setShapes] = useState<Shape[]>(() => initialShapes());
  const [selected, setSelected] = useState<string[]>([]);
  const [buggyAngle, setBuggyAngle] = useState(false);

  const shapesRef = useRef(shapes);
  shapesRef.current = shapes;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const buggyRef = useRef(buggyAngle);
  buggyRef.current = buggyAngle;
  const dragRef = useRef<Drag | null>(null);

  // ---- 맵 초기화 ----
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLE_URL,
      center: CENTER,
      zoom: 15,
      pitch: 0,
      maxPitch: 0, // 화면축 = 평면 유지 (앵커 픽셀 고정 보장)
      attributionControl: false,
    });
    map.dragRotate.disable();
    map.touchZoomRotate.disableRotation();
    mapRef.current = map;
    const rerender = () => forceTick((t) => t + 1);
    map.on('load', () => {
      setMapReady(true);
      rerender();
    });
    map.on('move', rerender);
    // 빈 곳(맵 캔버스) 클릭 시 선택 해제. 도형/핸들은 위에서 이벤트를 가로챈다.
    map.on('click', () => setSelected([]));
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // ---- 투영 헬퍼 ----
  const project = useCallback((ll: LngLat): V => {
    const p = mapRef.current!.project([ll.lng, ll.lat]);
    return { x: p.x, y: p.y };
  }, []);
  const unproject = useCallback((s: V): LngLat => {
    const ll = mapRef.current!.unproject([s.x, s.y]);
    return { lng: ll.lng, lat: ll.lat };
  }, []);
  const pointerScreen = useCallback((e: PointerEvent | React.PointerEvent): V => {
    const r = containerRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }, []);
  const pointerLngLat = useCallback(
    (e: PointerEvent | React.PointerEvent): LngLat => unproject(pointerScreen(e)),
    [pointerScreen, unproject],
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

  // ---- 그룹 정보 ----
  // - center/frame: 회전용 (미터 프레임, 피벗 = 중심)
  // - box: 표시·리사이즈용 화면 픽셀 AABB (앵커를 픽셀로 고정하기 위해 화면 공간에서 계산)
  const groupInfo = useMemo(() => {
    if (!mapReady || selected.length < 2 || !mapRef.current) return null;
    const map = mapRef.current;
    const sel = shapesRef.current.filter((s) => selected.includes(s.id));
    // 회전 피벗 = 자식 중심들의 평균 (mercator)
    let sx = 0;
    let sy = 0;
    for (const s of sel) {
      const m = maplibregl.MercatorCoordinate.fromLngLat([s.center.lng, s.center.lat], 0);
      sx += m.x;
      sy += m.y;
    }
    const cm = new maplibregl.MercatorCoordinate(sx / sel.length, sy / sel.length, 0).toLngLat();
    const center: LngLat = { lng: cm.lng, lat: cm.lat };
    const frame = new MeterFrame(center);
    // 화면 픽셀 AABB
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const s of sel) {
      const sf = new MeterFrame(s.center);
      for (const v of shapeLocalWorldVerts(s)) {
        const ll = sf.toLngLat(v);
        const p = map.project([ll.lng, ll.lat]);
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    }
    const box: ScreenBox = {
      cx: (minX + maxX) / 2,
      cy: (minY + maxY) / 2,
      hx: (maxX - minX) / 2,
      hy: (maxY - minY) / 2,
    };
    return { center, frame, box, ids: sel.map((s) => s.id) };
  }, [selected, mapReady, shapes]);

  // ---- 드래그 시작 ----
  const snapOf = (ids: string[]): Snapshot[] =>
    shapesRef.current
      .filter((s) => ids.includes(s.id))
      .map((s) => ({ id: s.id, center: { ...s.center }, rotationDeg: s.rotationDeg, scale: { ...s.scale } }));

  const beginMove = (e: React.PointerEvent, ids: string[]) => {
    dragRef.current = { kind: 'move', ids, snaps: snapOf(ids), pointerStart: pointerLngLat(e) };
  };
  const beginSingleRotate = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    const s = shapesRef.current.find((x) => x.id === id);
    if (!s) return;
    const frame = new MeterFrame(s.center);
    const pm = frame.toMeters(pointerLngLat(e));
    dragRef.current = {
      kind: 'rotate',
      ids: [id],
      snaps: snapOf([id]),
      pivot: { ...s.center },
      frame,
      handleAngleStart: measureAngle({ x: 0, y: 0 }, pm),
    };
  };
  const beginSingleResize = (e: React.PointerEvent, id: string, dir: V) => {
    e.stopPropagation();
    const s = shapesRef.current.find((x) => x.id === id);
    if (!s) return;
    dragRef.current = {
      kind: 'resize',
      id,
      snap: snapOf([id])[0],
      halfUnit: localHalfSize({ ...s, scale: { x: 1, y: 1 } }),
      dir,
    };
  };
  const beginGroupRotate = (e: React.PointerEvent) => {
    e.stopPropagation();
    const g = groupInfo;
    if (!g) return;
    const pm = g.frame.toMeters(pointerLngLat(e));
    dragRef.current = {
      kind: 'group-rotate',
      ids: g.ids,
      snaps: snapOf(g.ids),
      pivot: g.center,
      frame: g.frame,
      handleAngleStart: measureAngle({ x: 0, y: 0 }, pm),
    };
  };
  const beginGroupScale = (e: React.PointerEvent, dir: V) => {
    e.stopPropagation();
    const g = groupInfo;
    if (!g) return;
    dragRef.current = {
      kind: 'group-scale',
      ids: g.ids,
      snaps: snapOf(g.ids),
      box: { ...g.box }, // 화면 픽셀 박스 고정
      dir,
    };
  };

  // ---- 전역 pointermove / up (H-4) ----
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d || !mapRef.current) return;

      if (d.kind === 'move') {
        const now = pointerLngLat(e);
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

      if (d.kind === 'rotate' || d.kind === 'group-rotate') {
        const pm = d.frame.toMeters(pointerLngLat(e));
        const now = measureAngle({ x: 0, y: 0 }, pm);
        const total = now - d.handleAngleStart; // 절대 - 시작 (A-1/A-2)
        setShapes((prev) =>
          prev.map((s) => {
            const snap = d.snaps.find((n) => n.id === s.id);
            if (!snap) return s;
            // 스냅샷 중심 오프셋(미터, 그룹 프레임)을 total 만큼 회전 (누산 없음)
            const offset = d.frame.toMeters(snap.center);
            const newCenterLL = d.frame.toLngLat(rotate(offset, total));
            return {
              ...s,
              center: newCenterLL,
              rotationDeg: normalizeDeg(snap.rotationDeg + total),
            };
          }),
        );
        return;
      }

      if (d.kind === 'resize') {
        // PPT 방식: 반대편(anchor) 고정. 잡은 변/모서리만 이동.
        const s0 = d.snap;
        const frame = new MeterFrame(s0.center); // 원점 = 시작 중심 (고정)
        const pm = frame.toMeters(pointerLngLat(e));
        const pLocal = rotate(pm, -s0.rotationDeg); // 도형 로컬 축 (회전 제거)
        const HXs = d.halfUnit.x * s0.scale.x;
        const HYs = d.halfUnit.y * s0.scale.y;
        const cx = d.dir.x !== 0;
        const cy = d.dir.y !== 0;
        const anchorX = -d.dir.x * HXs; // 반대편 변 (고정)
        const anchorY = -d.dir.y * HYs;
        const newHalfX = cx ? Math.max(MIN_HALF_M, Math.abs(pLocal.x - anchorX) / 2) : HXs;
        const newHalfY = cy ? Math.max(MIN_HALF_M, Math.abs(pLocal.y - anchorY) / 2) : HYs;
        const newScaleX = cx ? newHalfX / d.halfUnit.x : s0.scale.x;
        const newScaleY = cy ? newHalfY / d.halfUnit.y : s0.scale.y;
        // 새 중심 = 잡은 변과 anchor 변의 중점 (제어 축만)
        const centerLocalX = cx ? (Math.sign(pLocal.x - anchorX) * newHalfX + anchorX) : 0;
        const centerLocalY = cy ? (Math.sign(pLocal.y - anchorY) * newHalfY + anchorY) : 0;
        const newCenter = frame.toLngLat(rotate({ x: centerLocalX, y: centerLocalY }, s0.rotationDeg));
        setShapes((prev) =>
          prev.map((s) =>
            s.id === d.id ? { ...s, center: newCenter, scale: { x: newScaleX, y: newScaleY } } : s,
          ),
        );
        return;
      }

      if (d.kind === 'group-scale') {
        // PPT 방식: 그룹 박스 반대편을 화면 픽셀로 고정. 자식들 위치/크기 전달.
        const map = mapRef.current;
        const P = pointerScreen(e); // 화면 픽셀
        const b = d.box;
        const cx = d.dir.x !== 0;
        const cy = d.dir.y !== 0;
        const anchorX = b.cx - d.dir.x * b.hx; // 반대편 변 (화면 픽셀, 고정)
        const anchorY = b.cy - d.dir.y * b.hy;
        const sx = cx ? Math.max(0.05, Math.abs(P.x - anchorX) / Math.max(1, 2 * b.hx)) : 1;
        const sy = cy ? Math.max(0.05, Math.abs(P.y - anchorY) / Math.max(1, 2 * b.hy)) : 1;
        setShapes((prev) =>
          prev.map((s) => {
            const snap = d.snaps.find((n) => n.id === s.id);
            if (!snap) return s;
            // 자식 중심을 화면에서 P' = A + S·(P₀ − A) (앵커 픽셀 고정)
            const c0 = map.project([snap.center.lng, snap.center.lat]);
            const nx = cx ? anchorX + (c0.x - anchorX) * sx : c0.x;
            const ny = cy ? anchorY + (c0.y - anchorY) * sy : c0.y;
            const ll = map.unproject([nx, ny]);
            return {
              ...s,
              center: { lng: ll.lng, lat: ll.lat },
              scale: { x: snap.scale.x * (cx ? sx : 1), y: snap.scale.y * (cy ? sy : 1) },
            };
          }),
        );
        return;
      }
    };

    const onUp = () => {
      dragRef.current = null;
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [measureAngle, pointerLngLat, pointerScreen]);

  // ---- 도형 선택/이동 ----
  const onShapePointerDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    if (e.shiftKey) {
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
    setShapes(initialShapes());
    setSelected([]);
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

          {groupInfo && (
            <GroupHandles
              box={groupInfo.box}
              onRotate={beginGroupRotate}
              onScale={(e, dir) => beginGroupScale(e, dir)}
              onMove={(e) => beginMove(e, groupInfo.ids)}
            />
          )}
        </svg>
      )}

      {/* 컨트롤 패널 */}
      <div style={panelStyle}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>도형 변환 테스터</div>
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
              <br />스케일: <b>{single.scale.x.toFixed(2)} × {single.scale.y.toFixed(2)}</b>
            </>
          )}
          <br />
          <span style={{ color: '#8a93a5' }}>
            · 도형 클릭 = 선택/이동
            <br />· Shift+클릭 = 다중 선택
            <br />· 빈 맵 클릭 = 선택 해제
            <br />· 2개 이상 = 그룹 핸들
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
  const half = localHalfSize(shape);
  const toScreen = (local: V) => project(frame.toLngLat(rotate(local, shape.rotationDeg)));
  // 외곽선 (모서리 4점)
  const outline = [
    { x: -half.x, y: half.y },
    { x: half.x, y: half.y },
    { x: half.x, y: -half.y },
    { x: -half.x, y: -half.y },
  ].map(toScreen);
  const topEdge = toScreen({ x: 0, y: half.y });
  const rotPt = toScreen({ x: 0, y: half.y + ROT_OFFSET_M });

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
        const p = toScreen({ x: dir.x * half.x, y: dir.y * half.y });
        return (
          <rect
            key={i}
            x={p.x - HANDLE / 2}
            y={p.y - HANDLE / 2}
            width={HANDLE}
            height={HANDLE}
            fill="#fff"
            stroke="#333"
            style={{ cursor: cursorForDir(dir), pointerEvents: 'auto' }}
            onPointerDown={(e) => onResize(e, dir)}
          />
        );
      })}
    </g>
  );
}

function GroupHandles({
  box,
  onRotate,
  onScale,
  onMove,
}: {
  box: ScreenBox;
  onRotate: (e: React.PointerEvent) => void;
  onScale: (e: React.PointerEvent, dir: V) => void;
  onMove: (e: React.PointerEvent) => void;
}) {
  const { cx, cy, hx, hy } = box; // 화면 픽셀
  const left = cx - hx;
  const right = cx + hx;
  const top = cy - hy; // 화면 위 = 작은 Y
  const bottom = cy + hy;
  const rotPtY = top - ROT_OFFSET_PX;

  return (
    <g>
      <rect
        x={left}
        y={top}
        width={hx * 2}
        height={hy * 2}
        fill="#5b8cff14"
        stroke="#5b8cff"
        strokeWidth={2}
        style={{ cursor: 'move', pointerEvents: 'auto' }}
        onPointerDown={onMove}
      />
      <line x1={cx} y1={top} x2={cx} y2={rotPtY} stroke="#ffd93b" pointerEvents="none" />
      <circle
        cx={cx}
        cy={rotPtY}
        r={HANDLE}
        fill="#ffd93b"
        style={{ cursor: 'grab', pointerEvents: 'auto' }}
        onPointerDown={onRotate}
      />
      {HANDLE_DIRS.map((dir, i) => {
        // dir는 화면축: x=+1 오른쪽, y=+1 아래
        const px = cx + dir.x * hx;
        const py = cy + dir.y * hy;
        return (
          <rect
            key={i}
            x={px - HANDLE / 2}
            y={py - HANDLE / 2}
            width={HANDLE}
            height={HANDLE}
            fill="#5b8cff"
            stroke="#fff"
            style={{ cursor: cursorForDir(dir), pointerEvents: 'auto' }}
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

export default ShapeTester;

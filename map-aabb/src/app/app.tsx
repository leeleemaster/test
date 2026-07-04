import { useCallback, useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import * as THREE from 'three';
import 'maplibre-gl/dist/maplibre-gl.css';

const INITIAL_CENTER: [number, number] = [126.978, 37.5665];
const ENABLE_MAP_SYMBOL_ICONS = false;
const CUSTOM_LAYER_ID = 'shape-editor-layer';
const OBSERVER_SYMBOL_SOURCE_ID = 'observer-symbol-source';
const OBSERVER_SYMBOL_LAYER_ID = 'observer-symbol-layer';
const OBSERVER_SYMBOL_IMAGE_ID = 'observer-symbol-image';
const COMPARISON_CAT_SOURCE_ID = 'comparison-cat-source';
const COMPARISON_CAT_LAYER_ID = 'comparison-cat-layer';
const COMPARISON_CAT_IMAGE_ID = 'comparison-cat-image';
const STYLE_URL = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
const COMPARISON_CAT_IMAGE_URL = 'https://upload.wikimedia.org/wikipedia/commons/7/7c/201408_cat.png';
const HANDLE_RADIUS = 7;
const TOP_HANDLE_RADIUS = 6;
const ROTATION_HANDLE_OFFSET_METERS = 110;
const MIN_HEIGHT_METERS = 30;
const MAX_HEIGHT_METERS = 500;
const ARC_SEGMENT_COUNT = 24;
const MIN_RING_GAP = 30;
const MIN_RING_DEPTH = 42;
const ICON_DISTANCE_FROM_APEX_METERS = 42;
const COMPARISON_CAT_OFFSET_METERS = 36;
const ICON_TEXTURE_SIZE_PIXELS = 160;
const OBSERVER_SYMBOL_IMAGE_SIZE_PIXELS = 400;
const ICON_SIZE_FACTOR = 0.25;
const ICON_SCREEN_SIZE_PIXELS = ICON_TEXTURE_SIZE_PIXELS * ICON_SIZE_FACTOR;
const ICON_SCALE_SAMPLE_METERS = 1000;
const IMAGE_ROTATE_HANDLE_OFFSET_PIXELS = 28;
const IMAGE_RESIZE_HANDLE_RADIUS = 6;
const IMAGE_MIN_SCALE = 0.45;
const IMAGE_MAX_SCALE = 2.8;
const ROUTE_LOOP_DURATION_MS = 36000;
const DEFAULT_VIEW_ZOOM = 15.2;
const DEFAULT_VIEW_PITCH = 72;
const EDITOR_PRESET_VERSION = 'vehicle-nav-v2';
const SHARED_ICON_SYMBOL_LAYOUT = {
  'icon-size': ICON_SIZE_FACTOR,
  'icon-allow-overlap': true,
  'icon-ignore-placement': true,
  'icon-pitch-alignment': 'viewport' as const,
  'icon-rotation-alignment': 'viewport' as const,
};

type LocalPoint = {
  x: number;
  y: number;
};

type ScreenPoint = {
  x: number;
  y: number;
};

type MercatorPoint = {
  x: number;
  y: number;
};

type ShapeState = {
  centerLng: number;
  centerLat: number;
  rotationZ: number;
  heightMeters: number;
};

type RouteLngLat = {
  lng: number;
  lat: number;
};

type RouteMetrics = {
  cumulativeLengths: number[];
  totalLengthMeters: number;
};

type RouteSample = RouteLngLat & {
  rotationZ: number;
};

type RoutePlaybackState = {
  isPlaying: boolean;
  progressMeters: number;
  loopDurationMs: number;
};

type OutlineStyle = 'solid' | 'dashed' | 'dotted';
type IconRenderMode = 'shared-depth' | 'always-front';
type RingHandleKey = 'apex' | 'left' | 'center' | 'right';
type ImageShapeId = 'observer' | 'panel';
type ImageShapeAltitudeMode = 'ground' | 'top';

type SectorRing = Record<RingHandleKey, LocalPoint>;

type ImageShape = {
  id: ImageShapeId;
  label: string;
  imageHref: string;
  localPoint: LocalPoint;
  altitudeMode: ImageShapeAltitudeMode;
  rotationDeg: number;
  scale: number;
  widthPixels: number;
  heightPixels: number;
};

type ImageShapeMap = Record<ImageShapeId, ImageShape>;

type ProjectedHandle = ScreenPoint & {
  key: RingHandleKey;
  ring: 'bottom' | 'top';
  label: string;
};

type ProjectedImageShape = {
  id: ImageShapeId;
  label: string;
  imageHref: string;
  center: ScreenPoint;
  topCenter: ScreenPoint;
  rotateHandle: ScreenPoint;
  resizeHandle: ScreenPoint;
  widthPixels: number;
  heightPixels: number;
  rotationDeg: number;
  altitudeMeters: number;
  framePathData: string;
};

type OverlayGeometry = {
  center: ScreenPoint;
  rotationAnchor: ScreenPoint;
  rotationHandle: ScreenPoint;
  bottomPathData: string;
  topPathData: string;
  routePathData: string;
  routeWaypointPoints: ScreenPoint[];
  routeCursor: ScreenPoint;
  bottomHandles: ProjectedHandle[];
  topHandles: ProjectedHandle[];
  imageShapes: ProjectedImageShape[];
  verticalConnectors: Array<{ from: ScreenPoint; to: ScreenPoint }>;
};

type DragState =
  | {
      type: 'move-shape';
      startPointerMercator: MercatorPoint;
      startCenterMercator: MercatorPoint;
    }
  | {
      type: 'rotate';
      rotationOffsetDeg: number;
    }
  | {
      type: 'ring-handle';
      ring: 'bottom' | 'top';
      key: RingHandleKey;
    }
  | {
      type: 'image-move';
      imageId: ImageShapeId;
      altitudeMode: ImageShapeAltitudeMode;
      pointerOffset: LocalPoint;
      startPointerMercator?: MercatorPoint;
      startCenterMercator?: MercatorPoint;
      previousPointerMercator?: MercatorPoint;
    }
  | {
      type: 'image-rotate';
      imageId: ImageShapeId;
      center: ScreenPoint;
      rotationOffsetDeg: number;
    }
  | {
      type: 'image-scale';
      imageId: ImageShapeId;
      center: ScreenPoint;
      startDistance: number;
      startScale: number;
    };

type CustomShapeLayer = maplibregl.CustomLayerInterface & {
  camera?: THREE.Camera;
  scene?: THREE.Scene;
  renderer?: THREE.WebGLRenderer;
  group?: THREE.Group;
  mesh?: THREE.Mesh;
  edges?: THREE.LineSegments;
  iconSprite?: THREE.Sprite;
  comparisonCatSprite?: THREE.Sprite;
  observerGuide?: THREE.LineSegments;
  iconTexture?: THREE.Texture;
  comparisonCatTexture?: THREE.Texture;
};

const ringHandleKeys: RingHandleKey[] = ['apex', 'left', 'center', 'right'];
const imageShapeIds: ImageShapeId[] = ['observer', 'panel'];

const initialShapeState: ShapeState = {
  centerLng: INITIAL_CENTER[0],
  centerLat: INITIAL_CENTER[1],
  rotationZ: 16,
  heightMeters: 120,
};

const demoRoutePoints: RouteLngLat[] = [
  { lng: INITIAL_CENTER[0], lat: INITIAL_CENTER[1] },
  { lng: 127.3845, lat: 36.3504 },
  { lng: 128.1146, lat: 36.1196 },
  { lng: 128.6014, lat: 35.8714 },
  { lng: 129.0756, lat: 35.1796 },
  { lng: 128.6014, lat: 35.8714 },
  { lng: 127.3845, lat: 36.3504 },
  { lng: INITIAL_CENTER[0], lat: INITIAL_CENTER[1] },
];

const DEMO_ROUTE_METRICS = buildRouteMetrics(demoRoutePoints);

const initialBottomRing: SectorRing = {
  apex: { x: 0, y: -120 },
  left: { x: -170, y: 60 },
  center: { x: 0, y: 260 },
  right: { x: 170, y: 60 },
};

const initialTopRing: SectorRing = {
  apex: { x: 8, y: -28 },
  left: { x: -105, y: 88 },
  center: { x: 0, y: 195 },
  right: { x: 120, y: 90 },
};

const outlineStyleOptions: Array<{ value: OutlineStyle; label: string }> = [
  { value: 'solid', label: '실선' },
  { value: 'dashed', label: '점선' },
  { value: 'dotted', label: '점점선' },
];

const iconRenderModeOptions: Array<{ value: IconRenderMode; label: string }> = [
  { value: 'shared-depth', label: '3D 깊이' },
  { value: 'always-front', label: '항상 앞' },
];

function clonePoint(point: LocalPoint): LocalPoint {
  return { x: point.x, y: point.y };
}

function cloneRing(ring: SectorRing): SectorRing {
  return {
    apex: clonePoint(ring.apex),
    left: clonePoint(ring.left),
    center: clonePoint(ring.center),
    right: clonePoint(ring.right),
  };
}

function cloneImageShape(shape: ImageShape): ImageShape {
  return {
    ...shape,
    localPoint: clonePoint(shape.localPoint),
  };
}

function cloneImageShapeMap(imageShapes: ImageShapeMap): ImageShapeMap {
  return {
    observer: cloneImageShape(imageShapes.observer),
    panel: cloneImageShape(imageShapes.panel),
  };
}

function rotatePoint(point: LocalPoint, angleRad: number): LocalPoint {
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);

  return {
    x: point.x * cos - point.y * sin,
    y: point.x * sin + point.y * cos,
  };
}

function normalizeDegrees(value: number) {
  return ((value + 180) % 360 + 360) % 360 - 180;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getDistanceBetweenPoints(pointA: ScreenPoint, pointB: ScreenPoint) {
  return Math.hypot(pointB.x - pointA.x, pointB.y - pointA.y);
}

function getAngleBetweenPointsDeg(center: ScreenPoint, point: ScreenPoint) {
  return THREE.MathUtils.radToDeg(Math.atan2(point.y - center.y, point.x - center.x));
}

function getRotatedScreenPoint(center: ScreenPoint, offsetX: number, offsetY: number, rotationDeg: number) {
  const angleRad = THREE.MathUtils.degToRad(rotationDeg);
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);

  return {
    x: center.x + offsetX * cos - offsetY * sin,
    y: center.y + offsetX * sin + offsetY * cos,
  };
}

function getQuadraticPoint(start: LocalPoint, control: LocalPoint, end: LocalPoint, t: number): LocalPoint {
  const mt = 1 - t;

  return {
    x: mt * mt * start.x + 2 * mt * t * control.x + t * t * end.x,
    y: mt * mt * start.y + 2 * mt * t * control.y + t * t * end.y,
  };
}

function getTransformModelData(shape: ShapeState) {
  const mercator = maplibregl.MercatorCoordinate.fromLngLat([shape.centerLng, shape.centerLat], 0);

  return {
    mercator,
    scale: mercator.meterInMercatorCoordinateUnits(),
  };
}

function getRingExtents(ring: SectorRing) {
  return ringHandleKeys.reduce(
    (acc, key) => ({
      minX: Math.min(acc.minX, ring[key].x),
      maxX: Math.max(acc.maxX, ring[key].x),
      minY: Math.min(acc.minY, ring[key].y),
      maxY: Math.max(acc.maxY, ring[key].y),
    }),
    {
      minX: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    },
  );
}

function getCombinedExtents(bottomRing: SectorRing, topRing: SectorRing) {
  const bottomExtents = getRingExtents(bottomRing);
  const topExtents = getRingExtents(topRing);

  return {
    minX: Math.min(bottomExtents.minX, topExtents.minX),
    maxX: Math.max(bottomExtents.maxX, topExtents.maxX),
    minY: Math.min(bottomExtents.minY, topExtents.minY),
    maxY: Math.max(bottomExtents.maxY, topExtents.maxY),
  };
}

function sanitizeSectorRing(inputRing: SectorRing): SectorRing {
  const ring = cloneRing(inputRing);

  ring.left.y = Math.max(ring.left.y, ring.apex.y + MIN_RING_DEPTH);
  ring.right.y = Math.max(ring.right.y, ring.apex.y + MIN_RING_DEPTH);
  ring.center.y = Math.max(ring.center.y, ring.apex.y + MIN_RING_DEPTH * 1.35);

  if (ring.left.x > ring.right.x - MIN_RING_GAP * 2) {
    const midpoint = (ring.left.x + ring.right.x) / 2;
    ring.left.x = midpoint - MIN_RING_GAP;
    ring.right.x = midpoint + MIN_RING_GAP;
  }

  ring.left.x = Math.min(ring.left.x, ring.center.x - MIN_RING_GAP);
  ring.right.x = Math.max(ring.right.x, ring.center.x + MIN_RING_GAP);
  ring.center.x = clamp(ring.center.x, ring.left.x + MIN_RING_GAP, ring.right.x - MIN_RING_GAP);

  const minArcY = Math.min(ring.left.y, ring.center.y, ring.right.y);
  ring.apex.y = Math.min(ring.apex.y, minArcY - MIN_RING_DEPTH);
  ring.apex.x = clamp(
    ring.apex.x,
    ring.left.x + MIN_RING_GAP * 0.25,
    ring.right.x - MIN_RING_GAP * 0.25,
  );

  return ring;
}

function getRingDirection(ring: SectorRing) {
  const dx = ring.center.x - ring.apex.x;
  const dy = ring.center.y - ring.apex.y;
  const length = Math.hypot(dx, dy) || 1;

  return {
    x: dx / length,
    y: dy / length,
  };
}

function sampleOuterArc(ring: SectorRing, segmentCount = ARC_SEGMENT_COUNT) {
  return Array.from({ length: segmentCount + 1 }, (_, index) => (
    getQuadraticPoint(ring.left, ring.center, ring.right, index / segmentCount)
  ));
}

function createSectorPolygon(ring: SectorRing) {
  return [ring.apex, ...sampleOuterArc(ring)];
}

function buildPathData(points: ScreenPoint[]) {
  if (points.length === 0) return '';

  return points.reduce(
    (path, point, index) => (
      index === 0
        ? `M ${point.x} ${point.y}`
        : `${path} L ${point.x} ${point.y}`
    ),
    '',
  ) + ' Z';
}

function buildOpenPathData(points: ScreenPoint[]) {
  if (points.length === 0) return '';

  return points.reduce(
    (path, point, index) => (
      index === 0
        ? `M ${point.x} ${point.y}`
        : `${path} L ${point.x} ${point.y}`
    ),
    '',
  );
}

function getOutlineSvgDasharray(outlineStyle: OutlineStyle) {
  if (outlineStyle === 'dashed') return '12 8';
  if (outlineStyle === 'dotted') return '3 7';
  return undefined;
}

function createOutlineMaterial(outlineStyle: OutlineStyle) {
  if (outlineStyle === 'dashed') {
    return new THREE.LineDashedMaterial({
      color: 0x082f49,
      dashSize: 40,
      gapSize: 24,
    });
  }

  if (outlineStyle === 'dotted') {
    return new THREE.LineDashedMaterial({
      color: 0x082f49,
      dashSize: 6,
      gapSize: 20,
    });
  }

  return new THREE.LineBasicMaterial({ color: 0x082f49 });
}

function createObserverIconCanvas(sizePixels = ICON_TEXTURE_SIZE_PIXELS) {
  const canvas = document.createElement('canvas');
  canvas.width = sizePixels;
  canvas.height = sizePixels;

  const context = canvas.getContext('2d');
  if (!context) {
    return null;
  }

  const scale = sizePixels / ICON_TEXTURE_SIZE_PIXELS;
  const scaled = (value: number) => value * scale;

  context.clearRect(0, 0, canvas.width, canvas.height);

  context.fillStyle = 'rgba(15, 23, 42, 0.16)';
  context.beginPath();
  context.ellipse(scaled(82), scaled(100), scaled(36), scaled(15), 0, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = '#ffffff';
  context.strokeStyle = '#0f172a';
  context.lineWidth = scaled(8);
  context.beginPath();
  context.moveTo(scaled(34), scaled(82));
  context.quadraticCurveTo(scaled(80), scaled(26), scaled(126), scaled(82));
  context.quadraticCurveTo(scaled(80), scaled(132), scaled(34), scaled(82));
  context.closePath();
  context.fill();
  context.stroke();

  const irisGradient = context.createRadialGradient(
    scaled(92),
    scaled(82),
    scaled(8),
    scaled(92),
    scaled(82),
    scaled(28),
  );
  irisGradient.addColorStop(0, '#38bdf8');
  irisGradient.addColorStop(1, '#0369a1');
  context.fillStyle = irisGradient;
  context.beginPath();
  context.arc(scaled(92), scaled(82), scaled(24), 0, Math.PI * 2);
  context.fill();

  context.fillStyle = '#0f172a';
  context.beginPath();
  context.arc(scaled(92), scaled(82), scaled(10), 0, Math.PI * 2);
  context.fill();

  context.fillStyle = 'rgba(255,255,255,0.8)';
  context.beginPath();
  context.arc(scaled(86), scaled(73), scaled(5), 0, Math.PI * 2);
  context.fill();

  return canvas;
}

function createObserverIconTexture() {
  const canvas = createObserverIconCanvas();
  if (!canvas) {
    const fallback = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    fallback.colorSpace = THREE.SRGBColorSpace;
    fallback.needsUpdate = true;
    return fallback;
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function createObserverIconDataUrl() {
  const canvas = createObserverIconCanvas(OBSERVER_SYMBOL_IMAGE_SIZE_PIXELS);
  return canvas ? canvas.toDataURL('image/png') : '';
}

function createPanelImageHref() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="280" height="180" viewBox="0 0 280 180">
      <defs>
        <linearGradient id="cardFill" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#f8fafc" />
          <stop offset="100%" stop-color="#dbeafe" />
        </linearGradient>
      </defs>
      <rect x="10" y="12" width="260" height="156" rx="26" fill="#0f172a" opacity="0.16" />
      <rect x="8" y="8" width="264" height="160" rx="26" fill="url(#cardFill)" stroke="#0f172a" stroke-width="8" />
      <rect x="26" y="28" width="228" height="12" rx="6" fill="#38bdf8" opacity="0.85" />
      <rect x="26" y="52" width="124" height="12" rx="6" fill="#0f172a" opacity="0.2" />
      <text x="28" y="112" font-size="54" font-family="Segoe UI, Arial, sans-serif" font-weight="700" fill="#0f172a">FAN</text>
      <text x="30" y="144" font-size="24" font-family="Segoe UI, Arial, sans-serif" fill="#334155">overlay image</text>
    </svg>`;

  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function createSpriteTextureFromImage(source: CanvasImageSource | ImageData) {
  const canvas = document.createElement('canvas');

  if (source instanceof ImageData) {
    canvas.width = source.width;
    canvas.height = source.height;
    const context = canvas.getContext('2d');
    if (!context) {
      return undefined;
    }

    context.putImageData(source, 0, 0);
  } else {
    const width = 'videoWidth' in source ? source.videoWidth : source.width;
    const height = 'videoHeight' in source ? source.videoHeight : source.height;

    if (!width || !height) {
      return undefined;
    }

    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext('2d');
    if (!context) {
      return undefined;
    }

    context.drawImage(source, 0, 0, width, height);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function createObserverIconImageData() {
  const canvas = createObserverIconCanvas(OBSERVER_SYMBOL_IMAGE_SIZE_PIXELS);
  if (!canvas) {
    return new ImageData(new Uint8ClampedArray([255, 255, 255, 255]), 1, 1);
  }

  const context = canvas.getContext('2d');
  if (!context) {
    return new ImageData(new Uint8ClampedArray([255, 255, 255, 255]), 1, 1);
  }

  return context.getImageData(0, 0, canvas.width, canvas.height);
}

function createIconSprite(
  texture: THREE.Texture,
  localPoint: LocalPoint,
  iconRenderMode: IconRenderMode,
) {
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: iconRenderMode === 'shared-depth',
    depthWrite: false,
    sizeAttenuation: true,
  });

  const sprite = new THREE.Sprite(material);
  sprite.position.set(
    localPoint.x,
    localPoint.y,
    0,
  );
  sprite.scale.set(ICON_SCREEN_SIZE_PIXELS, ICON_SCREEN_SIZE_PIXELS, 1);
  sprite.renderOrder = iconRenderMode === 'always-front' ? 8 : 3;
  sprite.frustumCulled = false;

  return sprite;
}

function projectLocalPointToScreen(
  localPoint: THREE.Vector3,
  group: THREE.Group,
  camera: THREE.Camera,
  canvas: HTMLCanvasElement,
) {
  const worldPoint = localPoint.clone().applyMatrix4(group.matrixWorld);
  const clipPoint = new THREE.Vector4(worldPoint.x, worldPoint.y, worldPoint.z, 1).applyMatrix4(camera.projectionMatrix);

  if (!Number.isFinite(clipPoint.w) || Math.abs(clipPoint.w) < 1e-6) {
    return null;
  }

  const ndcX = clipPoint.x / clipPoint.w;
  const ndcY = clipPoint.y / clipPoint.w;
  const width = canvas.clientWidth || canvas.width;
  const height = canvas.clientHeight || canvas.height;

  return {
    x: (ndcX * 0.5 + 0.5) * width,
    y: (-ndcY * 0.5 + 0.5) * height,
  };
}

function syncIconSpriteScale(
  sprite: THREE.Sprite,
  group: THREE.Group,
  camera: THREE.Camera,
  canvas: HTMLCanvasElement,
) {
  const centerPoint = projectLocalPointToScreen(sprite.position, group, camera, canvas);
  const xSamplePoint = projectLocalPointToScreen(
    sprite.position.clone().add(new THREE.Vector3(ICON_SCALE_SAMPLE_METERS, 0, 0)),
    group,
    camera,
    canvas,
  );
  const ySamplePoint = projectLocalPointToScreen(
    sprite.position.clone().add(new THREE.Vector3(0, ICON_SCALE_SAMPLE_METERS, 0)),
    group,
    camera,
    canvas,
  );

  if (!centerPoint || !xSamplePoint || !ySamplePoint) {
    return;
  }

  const xPixels = Math.hypot(xSamplePoint.x - centerPoint.x, xSamplePoint.y - centerPoint.y);
  const yPixels = Math.hypot(ySamplePoint.x - centerPoint.x, ySamplePoint.y - centerPoint.y);
  const pixelsPerMeter = ((xPixels + yPixels) / 2) / ICON_SCALE_SAMPLE_METERS;

  if (!Number.isFinite(pixelsPerMeter) || pixelsPerMeter <= 1e-6) {
    return;
  }

  const iconSizeMeters = ICON_SCREEN_SIZE_PIXELS / pixelsPerMeter;
  sprite.scale.set(iconSizeMeters, iconSizeMeters, 1);
}

function createObserverGuide(
  iconPosition: THREE.Vector3,
  bottomRing: SectorRing,
  topRing: SectorRing,
  heightMeters: number,
  iconRenderMode: IconRenderMode,
) {
  const shoulder = new THREE.Vector3(
    bottomRing.apex.x,
    bottomRing.apex.y,
    Math.max(heightMeters * 0.12, 10),
  );

  const targetAltitude = Math.max(heightMeters * 0.62, 18);
  const targets = [topRing.left, topRing.center, topRing.right].map((point) => (
    new THREE.Vector3(point.x, point.y, targetAltitude)
  ));

  const positions: number[] = [];
  targets.forEach((target) => {
    positions.push(iconPosition.x, iconPosition.y, iconPosition.z, shoulder.x, shoulder.y, shoulder.z);
    positions.push(shoulder.x, shoulder.y, shoulder.z, target.x, target.y, target.z);
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));

  const material = new THREE.LineBasicMaterial({
    color: 0xf97316,
    transparent: true,
    opacity: 0.72,
    depthTest: iconRenderMode === 'shared-depth',
    depthWrite: false,
  });

  const guide = new THREE.LineSegments(geometry, material);
  guide.renderOrder = iconRenderMode === 'always-front' ? 7 : 2;
  guide.frustumCulled = false;
  return guide;
}

function createSectorGeometry(bottomRing: SectorRing, topRing: SectorRing, heightMeters: number) {
  const bottomContour = createSectorPolygon(bottomRing);
  const topContour = createSectorPolygon(topRing);

  const bottomVectors = bottomContour.map((point) => new THREE.Vector2(point.x, point.y));
  if (THREE.ShapeUtils.isClockWise(bottomVectors)) {
    bottomContour.reverse();
    topContour.reverse();
    bottomVectors.reverse();
  }

  const positions: number[] = [];
  bottomContour.forEach((point) => positions.push(point.x, point.y, 0));
  topContour.forEach((point) => positions.push(point.x, point.y, heightMeters));

  const topOffset = bottomContour.length;
  const capIndices: number[] = [];
  const sideIndices: number[] = [];
  const triangles = THREE.ShapeUtils.triangulateShape(bottomVectors, []);

  triangles.forEach(([a, b, c]) => {
    capIndices.push(c, b, a);
    capIndices.push(topOffset + a, topOffset + b, topOffset + c);
  });

  for (let index = 0; index < bottomContour.length; index += 1) {
    const nextIndex = (index + 1) % bottomContour.length;

    sideIndices.push(index, nextIndex, topOffset + nextIndex);
    sideIndices.push(index, topOffset + nextIndex, topOffset + index);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex([...capIndices, ...sideIndices]);
  geometry.addGroup(0, capIndices.length, 0);
  geometry.addGroup(capIndices.length, sideIndices.length, 1);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function disposeMaterial(material: THREE.Material | THREE.Material[]) {
  if (Array.isArray(material)) {
    material.forEach((item) => item.dispose());
    return;
  }

  material.dispose();
}

function getObserverIconLocalPoint(bottomRing: SectorRing): LocalPoint {
  const direction = getRingDirection(bottomRing);

  return {
    x: bottomRing.apex.x - direction.x * ICON_DISTANCE_FROM_APEX_METERS,
    y: bottomRing.apex.y - direction.y * ICON_DISTANCE_FROM_APEX_METERS,
  };
}

function getComparisonCatLocalPoint(bottomRing: SectorRing): LocalPoint {
  const iconPoint = getObserverIconLocalPoint(bottomRing);
  const direction = getRingDirection(bottomRing);

  return {
    x: iconPoint.x + direction.y * COMPARISON_CAT_OFFSET_METERS,
    y: iconPoint.y - direction.x * COMPARISON_CAT_OFFSET_METERS,
  };
}

function getImageShapeAltitude(imageShape: ImageShape, shape: ShapeState) {
  return imageShape.altitudeMode === 'top' ? shape.heightMeters : 0;
}

function getImageShapeDisplayRotation(shape: ShapeState, imageShape: ImageShape) {
  return normalizeDegrees(shape.rotationZ + imageShape.rotationDeg);
}

function createInitialImageShapes(observerImageHref: string, panelImageHref: string): ImageShapeMap {
  return {
    observer: {
      id: 'observer',
      label: '관찰 아이콘',
      imageHref: observerImageHref,
      localPoint: getObserverIconLocalPoint(initialBottomRing),
      altitudeMode: 'ground',
      rotationDeg: 0,
      scale: 1,
      widthPixels: 58,
      heightPixels: 58,
    },
    panel: {
      id: 'panel',
      label: '이미지 카드',
      imageHref: panelImageHref,
      localPoint: { x: 0, y: 150 },
      altitudeMode: 'top',
      rotationDeg: -10,
      scale: 0.82,
      widthPixels: 108,
      heightPixels: 68,
    },
  };
}

function projectLngLatToScreen(map: maplibregl.Map, point: RouteLngLat): ScreenPoint {
  const projectedPoint = map.project([point.lng, point.lat]);

  return {
    x: projectedPoint.x,
    y: projectedPoint.y,
  };
}

function getLocalMetersBetweenLngLat(start: RouteLngLat, end: RouteLngLat): LocalPoint {
  const averageLatRad = THREE.MathUtils.degToRad((start.lat + end.lat) * 0.5);
  const metersPerDegreeLng = 111320 * Math.cos(averageLatRad);
  const metersPerDegreeLat = 110540;

  return {
    x: (end.lng - start.lng) * metersPerDegreeLng,
    y: (end.lat - start.lat) * metersPerDegreeLat,
  };
}

function getDistanceBetweenLngLat(start: RouteLngLat, end: RouteLngLat) {
  const delta = getLocalMetersBetweenLngLat(start, end);
  return Math.hypot(delta.x, delta.y);
}

function buildRouteMetrics(routePoints: RouteLngLat[]): RouteMetrics {
  const cumulativeLengths = [0];

  for (let index = 0; index < routePoints.length - 1; index += 1) {
    cumulativeLengths.push(
      cumulativeLengths[index] + getDistanceBetweenLngLat(routePoints[index], routePoints[index + 1]),
    );
  }

  return {
    cumulativeLengths,
    totalLengthMeters: cumulativeLengths[cumulativeLengths.length - 1] ?? 0,
  };
}

function sampleRouteAtDistance(
  routePoints: RouteLngLat[],
  routeMetrics: RouteMetrics,
  distanceMeters: number,
): RouteSample {
  if (routePoints.length < 2 || routeMetrics.totalLengthMeters <= 0) {
    return {
      ...routePoints[0],
      rotationZ: initialShapeState.rotationZ,
    };
  }

  const normalizedDistance = ((distanceMeters % routeMetrics.totalLengthMeters) + routeMetrics.totalLengthMeters)
    % routeMetrics.totalLengthMeters;
  let segmentIndex = routeMetrics.cumulativeLengths.length - 2;

  for (let index = 0; index < routeMetrics.cumulativeLengths.length - 1; index += 1) {
    if (normalizedDistance <= routeMetrics.cumulativeLengths[index + 1]) {
      segmentIndex = index;
      break;
    }
  }

  const segmentStartDistance = routeMetrics.cumulativeLengths[segmentIndex];
  const segmentEndDistance = routeMetrics.cumulativeLengths[segmentIndex + 1];
  const segmentDistance = segmentEndDistance - segmentStartDistance;
  const segmentProgress = segmentDistance <= 1e-6
    ? 0
    : (normalizedDistance - segmentStartDistance) / segmentDistance;
  const startPoint = routePoints[segmentIndex];
  const endPoint = routePoints[segmentIndex + 1];
  const headingVector = getLocalMetersBetweenLngLat(startPoint, endPoint);

  return {
    lng: THREE.MathUtils.lerp(startPoint.lng, endPoint.lng, segmentProgress),
    lat: THREE.MathUtils.lerp(startPoint.lat, endPoint.lat, segmentProgress),
    rotationZ: Math.hypot(headingVector.x, headingVector.y) <= 1
      ? initialShapeState.rotationZ
      : getRotationFromModelPoint(headingVector),
  };
}

function localPointToLngLat(localPoint: LocalPoint, shape: ShapeState) {
  const modelData = getTransformModelData(shape);
  const rotatedPoint = rotatePoint(localPoint, THREE.MathUtils.degToRad(shape.rotationZ));

  return new maplibregl.MercatorCoordinate(
    modelData.mercator.x + rotatedPoint.x * modelData.scale,
    modelData.mercator.y - rotatedPoint.y * modelData.scale,
    modelData.mercator.z,
  ).toLngLat();
}

function getRotationFromModelPoint(point: LocalPoint) {
  return normalizeDegrees(THREE.MathUtils.radToDeg(Math.atan2(point.y, point.x)) - 90);
}

function projectLocalPoint(
  map: maplibregl.Map,
  localPoint: LocalPoint,
  altitudeMeters: number,
  shape: ShapeState,
  projectionMatrixArray?: number[] | null,
): ScreenPoint {
  if (!projectionMatrixArray || projectionMatrixArray.length !== 16) {
    const modelData = getTransformModelData(shape);
    const rotatedPoint = rotatePoint(localPoint, THREE.MathUtils.degToRad(shape.rotationZ));
    const point = map.project(new maplibregl.MercatorCoordinate(
      modelData.mercator.x + rotatedPoint.x * modelData.scale,
      modelData.mercator.y - rotatedPoint.y * modelData.scale,
      modelData.mercator.z + altitudeMeters * modelData.scale,
    ).toLngLat());

    return { x: point.x, y: point.y };
  }

  const modelData = getTransformModelData(shape);
  const rotatedPoint = rotatePoint(localPoint, THREE.MathUtils.degToRad(shape.rotationZ));
  const worldPoint = new THREE.Vector4(
    modelData.mercator.x + rotatedPoint.x * modelData.scale,
    modelData.mercator.y - rotatedPoint.y * modelData.scale,
    modelData.mercator.z + altitudeMeters * modelData.scale,
    1,
  ).applyMatrix4(new THREE.Matrix4().fromArray(projectionMatrixArray));

  if (!Number.isFinite(worldPoint.w) || Math.abs(worldPoint.w) < 1e-6) {
    return { x: -9999, y: -9999 };
  }

  const ndcX = worldPoint.x / worldPoint.w;
  const ndcY = worldPoint.y / worldPoint.w;
  const width = map.getCanvas().clientWidth || map.getCanvas().width;
  const height = map.getCanvas().clientHeight || map.getCanvas().height;

  return {
    x: (ndcX * 0.5 + 0.5) * width,
    y: (-ndcY * 0.5 + 0.5) * height,
  };
}

function buildOverlayGeometry(
  map: maplibregl.Map,
  bottomRing: SectorRing,
  topRing: SectorRing,
  shape: ShapeState,
  imageShapes: ImageShapeMap,
  projectionMatrixArray?: number[] | null,
): OverlayGeometry {
  const projectedRoutePoints = demoRoutePoints.map((point) => projectLngLatToScreen(map, point));
  const bottomProjectedPathPoints = createSectorPolygon(bottomRing).map((point) => (
    projectLocalPoint(map, point, 0, shape, projectionMatrixArray)
  ));

  const topProjectedPathPoints = createSectorPolygon(topRing).map((point) => (
    projectLocalPoint(map, point, shape.heightMeters, shape, projectionMatrixArray)
  ));

  const bottomHandles = ringHandleKeys.map((key) => ({
    ring: 'bottom' as const,
    key,
    label: `bottom-${key}`,
    ...projectLocalPoint(map, bottomRing[key], 0, shape, projectionMatrixArray),
  }));

  const topHandles = ringHandleKeys.map((key) => ({
    ring: 'top' as const,
    key,
    label: `top-${key}`,
    ...projectLocalPoint(map, topRing[key], shape.heightMeters, shape, projectionMatrixArray),
  }));

  const verticalConnectors = ringHandleKeys.map((key) => ({
    from: projectLocalPoint(map, bottomRing[key], 0, shape, projectionMatrixArray),
    to: projectLocalPoint(map, topRing[key], shape.heightMeters, shape, projectionMatrixArray),
  }));

  const projectedImageShapes = imageShapeIds.map((imageId) => {
    const imageShape = imageShapes[imageId];
    const altitudeMeters = getImageShapeAltitude(imageShape, shape);
    const center = projectLocalPoint(map, imageShape.localPoint, altitudeMeters, shape, projectionMatrixArray);
    const rotationDeg = getImageShapeDisplayRotation(shape, imageShape);
    const widthPixels = imageShape.widthPixels * imageShape.scale;
    const heightPixels = imageShape.heightPixels * imageShape.scale;
    const halfWidth = widthPixels / 2;
    const halfHeight = heightPixels / 2;
    const corners = [
      getRotatedScreenPoint(center, -halfWidth, -halfHeight, rotationDeg),
      getRotatedScreenPoint(center, halfWidth, -halfHeight, rotationDeg),
      getRotatedScreenPoint(center, halfWidth, halfHeight, rotationDeg),
      getRotatedScreenPoint(center, -halfWidth, halfHeight, rotationDeg),
    ];

    return {
      id: imageShape.id,
      label: imageShape.label,
      imageHref: imageShape.imageHref,
      center,
      topCenter: getRotatedScreenPoint(center, 0, -halfHeight, rotationDeg),
      rotateHandle: getRotatedScreenPoint(center, 0, -halfHeight - IMAGE_ROTATE_HANDLE_OFFSET_PIXELS, rotationDeg),
      resizeHandle: getRotatedScreenPoint(center, halfWidth, halfHeight, rotationDeg),
      widthPixels,
      heightPixels,
      rotationDeg,
      altitudeMeters,
      framePathData: buildPathData(corners),
    };
  });

  const extents = getCombinedExtents(bottomRing, topRing);
  const center = projectLocalPoint(map, { x: 0, y: 0 }, shape.heightMeters * 0.5, shape, projectionMatrixArray);
  const rotationAnchor = projectLocalPoint(
    map,
    { x: (extents.minX + extents.maxX) / 2, y: extents.maxY },
    shape.heightMeters,
    shape,
    projectionMatrixArray,
  );
  const rotationHandle = projectLocalPoint(
    map,
    { x: (extents.minX + extents.maxX) / 2, y: extents.maxY + ROTATION_HANDLE_OFFSET_METERS },
    shape.heightMeters,
    shape,
    projectionMatrixArray,
  );

  return {
    center,
    rotationAnchor,
    rotationHandle,
    bottomPathData: buildPathData(bottomProjectedPathPoints),
    topPathData: buildPathData(topProjectedPathPoints),
    routePathData: buildOpenPathData(projectedRoutePoints),
    routeWaypointPoints: projectedRoutePoints,
    routeCursor: projectLngLatToScreen(map, { lng: shape.centerLng, lat: shape.centerLat }),
    bottomHandles,
    topHandles,
    imageShapes: projectedImageShapes,
    verticalConnectors,
  };
}

export function App() {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const layerRef = useRef<CustomShapeLayer | null>(null);
  const projectionMatrixRef = useRef<number[] | null>(null);
  const isMounted = useRef(false);
  const dragStateRef = useRef<DragState | null>(null);
  const routeAnimationFrameRef = useRef<number | null>(null);
  const presetVersionRef = useRef(EDITOR_PRESET_VERSION);

  const bottomRingRef = useRef<SectorRing>(cloneRing(initialBottomRing));
  const topRingRef = useRef<SectorRing>(cloneRing(initialTopRing));
  const outlineStyleRef = useRef<OutlineStyle>('solid');
  const iconRenderModeRef = useRef<IconRenderMode>('always-front');
  const shapeStateRef = useRef<ShapeState>({ ...initialShapeState });

  const [observerImageHref] = useState(() => createObserverIconDataUrl());
  const [panelImageHref] = useState(() => createPanelImageHref());
  const initialImageShapes = createInitialImageShapes(observerImageHref, panelImageHref);
  const imageShapesRef = useRef<ImageShapeMap>(cloneImageShapeMap(initialImageShapes));

  const [bottomRing, setBottomRing] = useState<SectorRing>(() => cloneRing(initialBottomRing));
  const [topRing, setTopRing] = useState<SectorRing>(() => cloneRing(initialTopRing));
  const [outlineStyle, setOutlineStyle] = useState<OutlineStyle>('solid');
  const [iconRenderMode, setIconRenderMode] = useState<IconRenderMode>('always-front');
  const [shapeState, setShapeState] = useState<ShapeState>({ ...initialShapeState });
  const [imageShapes, setImageShapes] = useState<ImageShapeMap>(() => cloneImageShapeMap(initialImageShapes));
  const [routePlayback, setRoutePlayback] = useState<RoutePlaybackState>({
    isPlaying: false,
    progressMeters: 0,
    loopDurationMs: ROUTE_LOOP_DURATION_MS,
  });
  const [overlay, setOverlay] = useState<OverlayGeometry | null>(null);
  const [activeHandle, setActiveHandle] = useState<string | null>(null);
  const [selectedImageId, setSelectedImageId] = useState<ImageShapeId | null>('observer');

  const syncOverlay = useCallback((
    nextShape = shapeStateRef.current,
    nextBottomRing = bottomRingRef.current,
    nextTopRing = topRingRef.current,
    nextImageShapes = imageShapesRef.current,
  ) => {
    const map = mapRef.current;
    if (!map || !isMounted.current) return;

    setOverlay(buildOverlayGeometry(
      map,
      nextBottomRing,
      nextTopRing,
      nextShape,
      nextImageShapes,
      projectionMatrixRef.current,
    ));
  }, []);

  const syncComparisonCatSymbol = useCallback(
    (
      nextShape = shapeStateRef.current,
      nextBottomRing = bottomRingRef.current,
      _nextIconRenderMode = iconRenderModeRef.current,
    ) => {
      if (!ENABLE_MAP_SYMBOL_ICONS) {
        return;
      }

      const map = mapRef.current;
      if (!map) return;

      if (map.getLayer(COMPARISON_CAT_LAYER_ID)) {
        map.setLayoutProperty(
          COMPARISON_CAT_LAYER_ID,
          'visibility',
          'visible',
        );
      }

      const source = map.getSource(COMPARISON_CAT_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
      if (!source) return;

      const catLngLat = localPointToLngLat(getComparisonCatLocalPoint(nextBottomRing), nextShape);

      source.setData({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { role: 'comparison-cat' },
            geometry: {
              type: 'Point',
              coordinates: [catLngLat.lng, catLngLat.lat],
            },
          },
        ],
      });
    },
    [],
  );

  const syncObserverSymbol = useCallback(
    (
      nextShape = shapeStateRef.current,
      nextBottomRing = bottomRingRef.current,
      _nextIconRenderMode = iconRenderModeRef.current,
    ) => {
      if (!ENABLE_MAP_SYMBOL_ICONS) {
        return;
      }

      const map = mapRef.current;
      if (!map) return;

      if (map.getLayer(OBSERVER_SYMBOL_LAYER_ID)) {
        map.setLayoutProperty(
          OBSERVER_SYMBOL_LAYER_ID,
          'visibility',
          'visible',
        );
      }

      const source = map.getSource(OBSERVER_SYMBOL_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
      if (!source) return;

      const iconLngLat = localPointToLngLat(getObserverIconLocalPoint(nextBottomRing), nextShape);
      source.setData({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { role: 'observer-eye' },
            geometry: {
              type: 'Point',
              coordinates: [iconLngLat.lng, iconLngLat.lat],
            },
          },
        ],
      });
    },
    [],
  );

  const rebuildShapeGeometry = useCallback(
    (
      nextBottomRing = bottomRingRef.current,
      nextTopRing = topRingRef.current,
      nextHeightMeters = shapeStateRef.current.heightMeters,
      nextOutlineStyle = outlineStyleRef.current,
      nextIconRenderMode = iconRenderModeRef.current,
    ) => {
      const layer = layerRef.current;
      if (!layer?.group) return;

      if (layer.mesh) {
        layer.group.remove(layer.mesh);
        layer.mesh.geometry.dispose();
        disposeMaterial(layer.mesh.material);
        layer.mesh = undefined;
      }

      if (layer.edges) {
        layer.group.remove(layer.edges);
        layer.edges.geometry.dispose();
        disposeMaterial(layer.edges.material);
        layer.edges = undefined;
      }

      if (layer.iconSprite) {
        layer.group.remove(layer.iconSprite);
        disposeMaterial(layer.iconSprite.material);
        layer.iconSprite = undefined;
      }

      if (layer.comparisonCatSprite) {
        layer.group.remove(layer.comparisonCatSprite);
        disposeMaterial(layer.comparisonCatSprite.material);
        layer.comparisonCatSprite = undefined;
      }

      if (layer.observerGuide) {
        layer.group.remove(layer.observerGuide);
        layer.observerGuide.geometry.dispose();
        disposeMaterial(layer.observerGuide.material);
        layer.observerGuide = undefined;
      }

      const geometry = createSectorGeometry(nextBottomRing, nextTopRing, nextHeightMeters);
      const capMaterial = new THREE.MeshStandardMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.82,
        roughness: 0.34,
        metalness: 0.08,
        side: THREE.DoubleSide,
      });
      const sideMaterial = new THREE.MeshStandardMaterial({
        color: 0x0f766e,
        transparent: true,
        opacity: 0.94,
        roughness: 0.56,
        metalness: 0.08,
        side: THREE.DoubleSide,
      });

      const mesh = new THREE.Mesh(geometry, [capMaterial, sideMaterial]);
      mesh.frustumCulled = false;
      mesh.renderOrder = 0;

      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geometry),
        createOutlineMaterial(nextOutlineStyle),
      );
      edges.frustumCulled = false;
      edges.renderOrder = 1;
      if (edges.material instanceof THREE.LineDashedMaterial) {
        edges.computeLineDistances();
      }

      const observerIconPoint = imageShapesRef.current.observer.localPoint;
      const observerIconPosition = new THREE.Vector3(observerIconPoint.x, observerIconPoint.y, 0);
      const iconSprite = undefined;
      const comparisonCatSprite = undefined;

      const observerGuide = createObserverGuide(
        observerIconPosition,
        nextBottomRing,
        nextTopRing,
        nextHeightMeters,
        nextIconRenderMode,
      );

      layer.mesh = mesh;
      layer.edges = edges;
      layer.iconSprite = iconSprite;
      layer.comparisonCatSprite = comparisonCatSprite;
      layer.observerGuide = observerGuide;
      layer.group.add(mesh);
      layer.group.add(edges);

      if (observerGuide) {
        layer.group.add(observerGuide);
      }

      if (iconSprite) {
        layer.group.add(iconSprite);
      }

      if (comparisonCatSprite) {
        layer.group.add(comparisonCatSprite);
      }

      syncObserverSymbol(shapeStateRef.current, nextBottomRing, nextIconRenderMode);
      syncComparisonCatSymbol(shapeStateRef.current, nextBottomRing, nextIconRenderMode);

      mapRef.current?.triggerRepaint();
    },
    [syncComparisonCatSymbol, syncObserverSymbol],
  );

  const updateShapeState = useCallback(
    (patch: Partial<ShapeState>) => {
      const nextShape = { ...shapeStateRef.current, ...patch };
      shapeStateRef.current = nextShape;
      setShapeState(nextShape);
      syncOverlay(nextShape, bottomRingRef.current, topRingRef.current, imageShapesRef.current);
      syncObserverSymbol(nextShape, bottomRingRef.current, iconRenderModeRef.current);
      syncComparisonCatSymbol(nextShape, bottomRingRef.current);

      if (patch.heightMeters !== undefined) {
        rebuildShapeGeometry(
          bottomRingRef.current,
          topRingRef.current,
          nextShape.heightMeters,
          outlineStyleRef.current,
          iconRenderModeRef.current,
        );
      }

      mapRef.current?.triggerRepaint();
    },
    [rebuildShapeGeometry, syncComparisonCatSymbol, syncObserverSymbol, syncOverlay],
  );

  const updateBottomRing = useCallback(
    (nextBottomRing: SectorRing) => {
      bottomRingRef.current = nextBottomRing;
      setBottomRing(nextBottomRing);
      syncOverlay(shapeStateRef.current, nextBottomRing, topRingRef.current, imageShapesRef.current);
      rebuildShapeGeometry(
        nextBottomRing,
        topRingRef.current,
        shapeStateRef.current.heightMeters,
        outlineStyleRef.current,
        iconRenderModeRef.current,
      );
      mapRef.current?.triggerRepaint();
    },
    [rebuildShapeGeometry, syncOverlay],
  );

  const updateTopRing = useCallback(
    (nextTopRing: SectorRing) => {
      topRingRef.current = nextTopRing;
      setTopRing(nextTopRing);
      syncOverlay(shapeStateRef.current, bottomRingRef.current, nextTopRing, imageShapesRef.current);
      rebuildShapeGeometry(
        bottomRingRef.current,
        nextTopRing,
        shapeStateRef.current.heightMeters,
        outlineStyleRef.current,
        iconRenderModeRef.current,
      );
      mapRef.current?.triggerRepaint();
    },
    [rebuildShapeGeometry, syncOverlay],
  );

  const updateOutlineStyle = useCallback(
    (nextOutlineStyle: OutlineStyle) => {
      outlineStyleRef.current = nextOutlineStyle;
      setOutlineStyle(nextOutlineStyle);
      rebuildShapeGeometry(
        bottomRingRef.current,
        topRingRef.current,
        shapeStateRef.current.heightMeters,
        nextOutlineStyle,
        iconRenderModeRef.current,
      );
      mapRef.current?.triggerRepaint();
    },
    [rebuildShapeGeometry],
  );

  const updateIconRenderMode = useCallback(
    (nextIconRenderMode: IconRenderMode) => {
      iconRenderModeRef.current = nextIconRenderMode;
      setIconRenderMode(nextIconRenderMode);
      syncObserverSymbol(shapeStateRef.current, bottomRingRef.current, nextIconRenderMode);
      rebuildShapeGeometry(
        bottomRingRef.current,
        topRingRef.current,
        shapeStateRef.current.heightMeters,
        outlineStyleRef.current,
        nextIconRenderMode,
      );
      mapRef.current?.triggerRepaint();
    },
    [rebuildShapeGeometry, syncObserverSymbol],
  );

  const setRouteProgress = useCallback(
    (nextProgressMeters: number) => {
      const nextRouteSample = sampleRouteAtDistance(demoRoutePoints, DEMO_ROUTE_METRICS, nextProgressMeters);

      setRoutePlayback((prev) => ({
        ...prev,
        progressMeters: nextProgressMeters,
      }));
      updateShapeState({
        centerLng: nextRouteSample.lng,
        centerLat: nextRouteSample.lat,
        rotationZ: nextRouteSample.rotationZ,
      });
      const map = mapRef.current;
      if (map) {
        map.jumpTo({
          center: [nextRouteSample.lng, nextRouteSample.lat],
          zoom: map.getZoom(),
          pitch: map.getPitch(),
          bearing: map.getBearing(),
        });
      }
      setSelectedImageId('observer');
    },
    [updateShapeState],
  );

  const toggleRoutePlayback = useCallback(() => {
    setRoutePlayback((prev) => ({
      ...prev,
      isPlaying: !prev.isPlaying,
    }));
    setSelectedImageId('observer');
  }, []);

  const resetRoutePlayback = useCallback(() => {
    if (routeAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(routeAnimationFrameRef.current);
      routeAnimationFrameRef.current = null;
    }

    setRoutePlayback((prev) => ({
      ...prev,
      isPlaying: false,
      progressMeters: 0,
      loopDurationMs: ROUTE_LOOP_DURATION_MS,
    }));
    setRouteProgress(0);
    mapRef.current?.easeTo({
      center: INITIAL_CENTER,
      duration: 700,
    });
  }, [setRouteProgress]);

  const updateImageShape = useCallback(
    (imageId: ImageShapeId, updater: (imageShape: ImageShape) => ImageShape) => {
      const nextImageShapes = cloneImageShapeMap(imageShapesRef.current);
      nextImageShapes[imageId] = updater(nextImageShapes[imageId]);
      imageShapesRef.current = nextImageShapes;
      setImageShapes(nextImageShapes);
      syncOverlay(shapeStateRef.current, bottomRingRef.current, topRingRef.current, nextImageShapes);

      if (imageId === 'observer') {
        rebuildShapeGeometry(
          bottomRingRef.current,
          topRingRef.current,
          shapeStateRef.current.heightMeters,
          outlineStyleRef.current,
          iconRenderModeRef.current,
        );
      }

      mapRef.current?.triggerRepaint();
    },
    [rebuildShapeGeometry, syncOverlay],
  );

  const getPointerMercator = useCallback((clientX: number, clientY: number) => {
    const map = mapRef.current;
    const container = mapContainerRef.current;

    if (!map || !container) return null;

    const rect = container.getBoundingClientRect();
    const point = [clientX - rect.left, clientY - rect.top] as [number, number];
    const lngLat = map.unproject(point);
    const mercator = maplibregl.MercatorCoordinate.fromLngLat(lngLat, 0);

    return { x: mercator.x, y: mercator.y };
  }, []);

  const getPointerScreenPoint = useCallback((clientX: number, clientY: number) => {
    const container = mapContainerRef.current;
    if (!container) return null;

    const rect = container.getBoundingClientRect();
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  }, []);

  const getPointerRotatedLocalAtAltitude = useCallback(
    (clientX: number, clientY: number, altitudeMeters: number) => {
      const container = mapContainerRef.current;
      const projectionMatrixArray = projectionMatrixRef.current;

      if (!container || !projectionMatrixArray || projectionMatrixArray.length !== 16) {
        const mercator = getPointerMercator(clientX, clientY);
        if (!mercator) return null;

        const modelData = getTransformModelData(shapeStateRef.current);
        return {
          x: (mercator.x - modelData.mercator.x) / modelData.scale,
          y: -(mercator.y - modelData.mercator.y) / modelData.scale,
        };
      }

      const rect = container.getBoundingClientRect();
      const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
      const ndcY = 1 - ((clientY - rect.top) / rect.height) * 2;
      const inverseProjectionMatrix = new THREE.Matrix4().fromArray(projectionMatrixArray).invert();
      const nearPoint = new THREE.Vector4(ndcX, ndcY, -1, 1).applyMatrix4(inverseProjectionMatrix);
      const farPoint = new THREE.Vector4(ndcX, ndcY, 1, 1).applyMatrix4(inverseProjectionMatrix);

      if (
        !Number.isFinite(nearPoint.w)
        || !Number.isFinite(farPoint.w)
        || Math.abs(nearPoint.w) < 1e-6
        || Math.abs(farPoint.w) < 1e-6
      ) {
        return null;
      }

      nearPoint.divideScalar(nearPoint.w);
      farPoint.divideScalar(farPoint.w);

      const modelData = getTransformModelData(shapeStateRef.current);
      const nearLocal = {
        x: (nearPoint.x - modelData.mercator.x) / modelData.scale,
        y: -(nearPoint.y - modelData.mercator.y) / modelData.scale,
        z: (nearPoint.z - modelData.mercator.z) / modelData.scale,
      };
      const farLocal = {
        x: (farPoint.x - modelData.mercator.x) / modelData.scale,
        y: -(farPoint.y - modelData.mercator.y) / modelData.scale,
        z: (farPoint.z - modelData.mercator.z) / modelData.scale,
      };
      const deltaZ = farLocal.z - nearLocal.z;

      if (Math.abs(deltaZ) < 1e-6) {
        return null;
      }

      const t = (altitudeMeters - nearLocal.z) / deltaZ;
      if (!Number.isFinite(t)) {
        return null;
      }

      return {
        x: nearLocal.x + (farLocal.x - nearLocal.x) * t,
        y: nearLocal.y + (farLocal.y - nearLocal.y) * t,
      };
    },
    [getPointerMercator],
  );

  const getPointerLocalMetersAtAltitude = useCallback(
    (clientX: number, clientY: number, altitudeMeters: number) => {
      const rotatedLocalPoint = getPointerRotatedLocalAtAltitude(clientX, clientY, altitudeMeters);
      if (!rotatedLocalPoint) return null;

      return rotatePoint(rotatedLocalPoint, -THREE.MathUtils.degToRad(shapeStateRef.current.rotationZ));
    },
    [getPointerRotatedLocalAtAltitude],
  );

  const startDrag = useCallback((dragState: DragState, handleId: string) => {
    setRoutePlayback((prev) => (
      prev.isPlaying
        ? { ...prev, isPlaying: false }
        : prev
    ));
    dragStateRef.current = dragState;
    setActiveHandle(handleId);
    mapRef.current?.dragPan.disable();
  }, []);

  const resetTopRing = useCallback(() => {
    const nextTopRing = cloneRing(initialTopRing);
    topRingRef.current = nextTopRing;
    setTopRing(nextTopRing);
    syncOverlay(shapeStateRef.current, bottomRingRef.current, nextTopRing, imageShapesRef.current);
    rebuildShapeGeometry(
      bottomRingRef.current,
      nextTopRing,
      shapeStateRef.current.heightMeters,
      outlineStyleRef.current,
      iconRenderModeRef.current,
    );
  }, [rebuildShapeGeometry, syncOverlay]);

  const resetImageShapes = useCallback(() => {
    const nextImageShapes = cloneImageShapeMap(initialImageShapes);
    imageShapesRef.current = nextImageShapes;
    setImageShapes(nextImageShapes);
    setSelectedImageId('observer');
    syncOverlay(shapeStateRef.current, bottomRingRef.current, topRingRef.current, nextImageShapes);
    rebuildShapeGeometry(
      bottomRingRef.current,
      topRingRef.current,
      shapeStateRef.current.heightMeters,
      outlineStyleRef.current,
      iconRenderModeRef.current,
    );
  }, [initialImageShapes, rebuildShapeGeometry, syncOverlay]);

  const resetEditor = useCallback(() => {
    const nextBottomRing = cloneRing(initialBottomRing);
    const nextTopRing = cloneRing(initialTopRing);
    const nextShapeState = { ...initialShapeState };
    const nextImageShapes = cloneImageShapeMap(initialImageShapes);

    bottomRingRef.current = nextBottomRing;
    topRingRef.current = nextTopRing;
    shapeStateRef.current = nextShapeState;
    imageShapesRef.current = nextImageShapes;
    setBottomRing(nextBottomRing);
    setTopRing(nextTopRing);
    setShapeState(nextShapeState);
    setImageShapes(nextImageShapes);
    setActiveHandle(null);
    setSelectedImageId('observer');
    setRoutePlayback((prev) => ({
      ...prev,
      isPlaying: false,
      progressMeters: 0,
      loopDurationMs: ROUTE_LOOP_DURATION_MS,
    }));

    syncOverlay(nextShapeState, nextBottomRing, nextTopRing, nextImageShapes);
    rebuildShapeGeometry(
      nextBottomRing,
      nextTopRing,
      nextShapeState.heightMeters,
      outlineStyleRef.current,
      iconRenderModeRef.current,
    );

    mapRef.current?.easeTo({
      center: INITIAL_CENTER,
      zoom: DEFAULT_VIEW_ZOOM,
      pitch: DEFAULT_VIEW_PITCH,
      bearing: 0,
      duration: 600,
    });
  }, [initialImageShapes, rebuildShapeGeometry, syncOverlay]);

  useEffect(() => {
    if (presetVersionRef.current === EDITOR_PRESET_VERSION) {
      return;
    }

    presetVersionRef.current = EDITOR_PRESET_VERSION;
    resetEditor();
  }, [resetEditor]);

  useEffect(() => {
    if (!routePlayback.isPlaying || DEMO_ROUTE_METRICS.totalLengthMeters <= 0) {
      if (routeAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(routeAnimationFrameRef.current);
        routeAnimationFrameRef.current = null;
      }
      return undefined;
    }

    const startedAt = performance.now();
    const startProgressMeters = routePlayback.progressMeters;

    const animateRoute = (timestamp: number) => {
      const elapsed = timestamp - startedAt;
      const nextProgressMeters = (
        startProgressMeters
        + (elapsed / routePlayback.loopDurationMs) * DEMO_ROUTE_METRICS.totalLengthMeters
      ) % DEMO_ROUTE_METRICS.totalLengthMeters;

      setRouteProgress(nextProgressMeters);
      routeAnimationFrameRef.current = window.requestAnimationFrame(animateRoute);
    };

    routeAnimationFrameRef.current = window.requestAnimationFrame(animateRoute);

    return () => {
      if (routeAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(routeAnimationFrameRef.current);
        routeAnimationFrameRef.current = null;
      }
    };
  }, [routePlayback.isPlaying, routePlayback.loopDurationMs, setRouteProgress]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const dragState = dragStateRef.current;
      if (!dragState) return;

      if (dragState.type === 'move-shape') {
        const currentPointerMercator = getPointerMercator(event.clientX, event.clientY);
        if (!currentPointerMercator) return;

        const nextCenterMercator = {
          x: dragState.startCenterMercator.x + (currentPointerMercator.x - dragState.startPointerMercator.x),
          y: dragState.startCenterMercator.y + (currentPointerMercator.y - dragState.startPointerMercator.y),
        };

        const nextCenterLngLat = new maplibregl.MercatorCoordinate(
          nextCenterMercator.x,
          nextCenterMercator.y,
          0,
        ).toLngLat();

        updateShapeState({
          centerLng: nextCenterLngLat.lng,
          centerLat: nextCenterLngLat.lat,
        });
        return;
      }

      if (dragState.type === 'rotate') {
        const modelPointer = getPointerRotatedLocalAtAltitude(
          event.clientX,
          event.clientY,
          shapeStateRef.current.heightMeters,
        );
        if (!modelPointer) return;

        const rotationZ = normalizeDegrees(getRotationFromModelPoint(modelPointer) + dragState.rotationOffsetDeg);
        updateShapeState({ rotationZ });
        return;
      }

      if (dragState.type === 'image-move') {
        if (dragState.imageId === 'observer' && dragState.startPointerMercator && dragState.startCenterMercator) {
          const currentPointerMercator = getPointerMercator(event.clientX, event.clientY);
          if (!currentPointerMercator) return;

          const nextCenterMercator = {
            x: dragState.startCenterMercator.x + (currentPointerMercator.x - dragState.startPointerMercator.x),
            y: dragState.startCenterMercator.y + (currentPointerMercator.y - dragState.startPointerMercator.y),
          };

          const nextCenterLngLat = new maplibregl.MercatorCoordinate(
            nextCenterMercator.x,
            nextCenterMercator.y,
            0,
          ).toLngLat();

          const nextShapePatch: Partial<ShapeState> = {
            centerLng: nextCenterLngLat.lng,
            centerLat: nextCenterLngLat.lat,
          };

          if (dragState.previousPointerMercator) {
            const modelData = getTransformModelData(shapeStateRef.current);
            const deltaX = (currentPointerMercator.x - dragState.previousPointerMercator.x) / modelData.scale;
            const deltaY = -(currentPointerMercator.y - dragState.previousPointerMercator.y) / modelData.scale;

            if (Math.hypot(deltaX, deltaY) > 120) {
              nextShapePatch.rotationZ = getRotationFromModelPoint({ x: deltaX, y: deltaY });
            }
          }

          updateShapeState(nextShapePatch);
          dragStateRef.current = {
            ...dragState,
            previousPointerMercator: currentPointerMercator,
          };
          return;
        }

        const localPointer = getPointerLocalMetersAtAltitude(
          event.clientX,
          event.clientY,
          dragState.altitudeMode === 'top' ? shapeStateRef.current.heightMeters : 0,
        );
        if (!localPointer) return;

        updateImageShape(dragState.imageId, (imageShape) => ({
          ...imageShape,
          localPoint: {
            x: localPointer.x + dragState.pointerOffset.x,
            y: localPointer.y + dragState.pointerOffset.y,
          },
        }));
        return;
      }

      if (dragState.type === 'image-rotate') {
        const pointerScreenPoint = getPointerScreenPoint(event.clientX, event.clientY);
        if (!pointerScreenPoint) return;

        const pointerAngle = getAngleBetweenPointsDeg(dragState.center, pointerScreenPoint);
        updateImageShape(dragState.imageId, (imageShape) => ({
          ...imageShape,
          rotationDeg: normalizeDegrees(pointerAngle + dragState.rotationOffsetDeg - shapeStateRef.current.rotationZ),
        }));
        return;
      }

      if (dragState.type === 'image-scale') {
        const pointerScreenPoint = getPointerScreenPoint(event.clientX, event.clientY);
        if (!pointerScreenPoint) return;

        const nextDistance = getDistanceBetweenPoints(dragState.center, pointerScreenPoint);
        if (!Number.isFinite(nextDistance) || nextDistance <= 1e-6) return;

        updateImageShape(dragState.imageId, (imageShape) => ({
          ...imageShape,
          scale: clamp(
            dragState.startScale * (nextDistance / dragState.startDistance),
            IMAGE_MIN_SCALE,
            IMAGE_MAX_SCALE,
          ),
        }));
        return;
      }

      const localPointer = getPointerLocalMetersAtAltitude(
        event.clientX,
        event.clientY,
        dragState.ring === 'top' ? shapeStateRef.current.heightMeters : 0,
      );
      if (!localPointer) return;

      if (dragState.ring === 'bottom') {
        const nextRing = cloneRing(bottomRingRef.current);
        nextRing[dragState.key] = localPointer;
        updateBottomRing(sanitizeSectorRing(nextRing));
        return;
      }

      const nextRing = cloneRing(topRingRef.current);
      nextRing[dragState.key] = localPointer;
      updateTopRing(sanitizeSectorRing(nextRing));
    };

    const handlePointerUp = () => {
      if (!dragStateRef.current) return;

      dragStateRef.current = null;
      setActiveHandle(null);
      mapRef.current?.dragPan.enable();
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, [getPointerLocalMetersAtAltitude, getPointerMercator, getPointerRotatedLocalAtAltitude, getPointerScreenPoint, updateBottomRing, updateImageShape, updateShapeState, updateTopRing]);

  useEffect(() => {
    if (isMounted.current || !mapContainerRef.current) return;
    isMounted.current = true;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: STYLE_URL,
      center: INITIAL_CENTER,
      zoom: DEFAULT_VIEW_ZOOM,
      pitch: DEFAULT_VIEW_PITCH,
      bearing: 0,
      antialias: true,
    });

    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
    map.touchZoomRotate.disableRotation();

    const customLayer: CustomShapeLayer = {
      id: CUSTOM_LAYER_ID,
      type: 'custom',
      renderingMode: '3d',

      onAdd(mapInstance, gl) {
        this.scene = new THREE.Scene();
        this.camera = new THREE.Camera();
        this.group = new THREE.Group();
        this.iconTexture = createObserverIconTexture();
        this.comparisonCatTexture = undefined;

        const ambientLight = new THREE.AmbientLight(0xffffff, 0.86);
        const directionalLight = new THREE.DirectionalLight(0xffffff, 1.15);
        directionalLight.position.set(0.25, -0.35, 1);

        this.scene.add(ambientLight);
        this.scene.add(directionalLight);
        this.scene.add(this.group);

        this.renderer = new THREE.WebGLRenderer({
          canvas: mapInstance.getCanvas(),
          context: gl,
          antialias: true,
        });
        this.renderer.autoClear = false;

        layerRef.current = this;
        rebuildShapeGeometry();
      },

      render(_gl, matrix) {
        if (!this.camera || !this.scene || !this.renderer || !this.group) return;

        projectionMatrixRef.current = Array.from(matrix);

        const currentShape = shapeStateRef.current;
        const modelData = getTransformModelData(currentShape);

        this.group.rotation.z = THREE.MathUtils.degToRad(currentShape.rotationZ);

        const layerMatrix = new THREE.Matrix4()
          .makeTranslation(modelData.mercator.x, modelData.mercator.y, modelData.mercator.z)
          .scale(new THREE.Vector3(modelData.scale, -modelData.scale, modelData.scale));

        this.camera.projectionMatrix = new THREE.Matrix4()
          .fromArray(matrix)
          .multiply(layerMatrix);

        this.group.updateMatrixWorld(true);

        if (this.iconSprite) {
          syncIconSpriteScale(
            this.iconSprite,
            this.group,
            this.camera,
            map.getCanvas(),
          );
        }

        if (this.comparisonCatSprite) {
          syncIconSpriteScale(
            this.comparisonCatSprite,
            this.group,
            this.camera,
            map.getCanvas(),
          );
        }

        this.renderer.resetState();
        this.renderer.render(this.scene, this.camera);
        map.triggerRepaint();
      },

      onRemove() {
        if (this.mesh) {
          this.mesh.geometry.dispose();
          disposeMaterial(this.mesh.material);
          this.mesh = undefined;
        }

        if (this.edges) {
          this.edges.geometry.dispose();
          disposeMaterial(this.edges.material);
          this.edges = undefined;
        }

        if (this.iconSprite) {
          disposeMaterial(this.iconSprite.material);
          this.iconSprite = undefined;
        }

        if (this.comparisonCatSprite) {
          disposeMaterial(this.comparisonCatSprite.material);
          this.comparisonCatSprite = undefined;
        }

        if (this.observerGuide) {
          this.observerGuide.geometry.dispose();
          disposeMaterial(this.observerGuide.material);
          this.observerGuide = undefined;
        }

        this.iconTexture?.dispose();
        this.iconTexture = undefined;
  this.comparisonCatTexture?.dispose();
  this.comparisonCatTexture = undefined;

        this.group?.clear();
        this.renderer?.dispose();

        if (layerRef.current === this) {
          layerRef.current = null;
        }
      },
    };

    const scheduleOverlaySync = () => {
      window.requestAnimationFrame(() => {
        if (!isMounted.current) return;
        syncOverlay();
      });
    };

    const ensureComparisonCatLayer = async () => {
      if (!ENABLE_MAP_SYMBOL_ICONS) {
        return;
      }

      try {
        if (!map.hasImage(COMPARISON_CAT_IMAGE_ID)) {
          const image = await map.loadImage(COMPARISON_CAT_IMAGE_URL);
          if (!map.hasImage(COMPARISON_CAT_IMAGE_ID)) {
            map.addImage(COMPARISON_CAT_IMAGE_ID, image.data);
          }

          const comparisonCatTexture = createSpriteTextureFromImage(image.data);
          if (layerRef.current && comparisonCatTexture) {
            layerRef.current.comparisonCatTexture?.dispose();
            layerRef.current.comparisonCatTexture = comparisonCatTexture;
            rebuildShapeGeometry();
          }
        }

        if (!map.getSource(COMPARISON_CAT_SOURCE_ID)) {
          map.addSource(COMPARISON_CAT_SOURCE_ID, {
            type: 'geojson',
            data: {
              type: 'FeatureCollection',
              features: [],
            },
          });
        }

        if (!map.getLayer(COMPARISON_CAT_LAYER_ID)) {
          map.addLayer({
            id: COMPARISON_CAT_LAYER_ID,
            type: 'symbol',
            source: COMPARISON_CAT_SOURCE_ID,
            layout: {
              'icon-image': COMPARISON_CAT_IMAGE_ID,
              ...SHARED_ICON_SYMBOL_LAYOUT,
            },
          });
        }

        syncComparisonCatSymbol(shapeStateRef.current, bottomRingRef.current, iconRenderModeRef.current);
      } catch (error) {
        console.error('Failed to load comparison cat symbol', error);
      }
    };

    const ensureObserverSymbolLayer = () => {
      if (!ENABLE_MAP_SYMBOL_ICONS) {
        return;
      }

      try {
        if (!map.hasImage(OBSERVER_SYMBOL_IMAGE_ID)) {
          map.addImage(OBSERVER_SYMBOL_IMAGE_ID, createObserverIconImageData());
        }

        if (!map.getSource(OBSERVER_SYMBOL_SOURCE_ID)) {
          map.addSource(OBSERVER_SYMBOL_SOURCE_ID, {
            type: 'geojson',
            data: {
              type: 'FeatureCollection',
              features: [],
            },
          });
        }

        if (!map.getLayer(OBSERVER_SYMBOL_LAYER_ID)) {
          map.addLayer({
            id: OBSERVER_SYMBOL_LAYER_ID,
            type: 'symbol',
            source: OBSERVER_SYMBOL_SOURCE_ID,
            layout: {
              'icon-image': OBSERVER_SYMBOL_IMAGE_ID,
              ...SHARED_ICON_SYMBOL_LAYOUT,
            },
          });
        }

        syncObserverSymbol(shapeStateRef.current, bottomRingRef.current, iconRenderModeRef.current);
      } catch (error) {
        console.error('Failed to load observer symbol', error);
      }
    };

    map.on('load', () => {
      if (!map.getLayer(CUSTOM_LAYER_ID)) {
        map.addLayer(customLayer);
      }

      ensureObserverSymbolLayer();
      void ensureComparisonCatLayer();

      map.once('render', scheduleOverlaySync);
    });

    map.on('move', scheduleOverlaySync);
    map.on('resize', scheduleOverlaySync);

    return () => {
      map.off('move', scheduleOverlaySync);
      map.off('resize', scheduleOverlaySync);

      if (map.getLayer(CUSTOM_LAYER_ID)) {
        map.removeLayer(CUSTOM_LAYER_ID);
      }

      if (map.getLayer(COMPARISON_CAT_LAYER_ID)) {
        map.removeLayer(COMPARISON_CAT_LAYER_ID);
      }

      if (map.getLayer(OBSERVER_SYMBOL_LAYER_ID)) {
        map.removeLayer(OBSERVER_SYMBOL_LAYER_ID);
      }

      if (map.getSource(COMPARISON_CAT_SOURCE_ID)) {
        map.removeSource(COMPARISON_CAT_SOURCE_ID);
      }

      if (map.getSource(OBSERVER_SYMBOL_SOURCE_ID)) {
        map.removeSource(OBSERVER_SYMBOL_SOURCE_ID);
      }

      if (map.hasImage(COMPARISON_CAT_IMAGE_ID)) {
        map.removeImage(COMPARISON_CAT_IMAGE_ID);
      }

      if (map.hasImage(OBSERVER_SYMBOL_IMAGE_ID)) {
        map.removeImage(OBSERVER_SYMBOL_IMAGE_ID);
      }

      map.remove();
      mapRef.current = null;
      projectionMatrixRef.current = null;
      isMounted.current = false;
    };
  }, [rebuildShapeGeometry, syncComparisonCatSymbol, syncOverlay]);

  const overlayStroke = 'rgba(14, 165, 233, 0.96)';
  const overlayStrokeDasharray = getOutlineSvgDasharray(outlineStyle);
  const overlayFill = 'rgba(56, 189, 248, 0.12)';
  const topHandleFill = '#f97316';
  const selectedImage = selectedImageId ? imageShapes[selectedImageId] : null;
  const routeProgressPercent = DEMO_ROUTE_METRICS.totalLengthMeters <= 0
    ? 0
    : (routePlayback.progressMeters / DEMO_ROUTE_METRICS.totalLengthMeters) * 100;
  const bottomRangeMeters = Math.round(Math.hypot(
    bottomRing.center.x - bottomRing.apex.x,
    bottomRing.center.y - bottomRing.apex.y,
  ));
  const topRangeMeters = Math.round(Math.hypot(
    topRing.center.x - topRing.apex.x,
    topRing.center.y - topRing.apex.y,
  ));

  return (
    <div className="app-shell">
      <div ref={mapContainerRef} className="map-container" />

      {overlay ? (
        <svg
          width="100%"
          height="100%"
          style={{ position: 'absolute', inset: 0, zIndex: 9, overflow: 'visible', pointerEvents: 'none' }}
        >
          <path
            d={overlay.routePathData}
            fill="none"
            stroke="rgba(37, 99, 235, 0.52)"
            strokeWidth={3}
            strokeDasharray="12 8"
            vectorEffect="non-scaling-stroke"
          />

          {overlay.routeWaypointPoints.map((point, index) => (
            <circle
              key={`route-waypoint-${index}`}
              cx={point.x}
              cy={point.y}
              r={index === 0 ? 6 : 4.5}
              fill={index === 0 ? '#2563eb' : '#ffffff'}
              stroke="#1e3a8a"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
            />
          ))}

          <circle
            cx={overlay.routeCursor.x}
            cy={overlay.routeCursor.y}
            r={8}
            fill={routePlayback.isPlaying ? '#16a34a' : '#0f172a'}
            stroke="#ffffff"
            strokeWidth={2.5}
            vectorEffect="non-scaling-stroke"
          />

          <path
            d={overlay.bottomPathData}
            fill={overlayFill}
            stroke={overlayStroke}
            strokeDasharray={overlayStrokeDasharray}
            strokeWidth={2.5}
            vectorEffect="non-scaling-stroke"
            style={{
              pointerEvents: 'auto',
              cursor: activeHandle === 'move-shape' ? 'grabbing' : 'grab',
            }}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setSelectedImageId(null);

              const startPointerMercator = getPointerMercator(event.clientX, event.clientY);
              const modelData = getTransformModelData(shapeStateRef.current);
              if (!startPointerMercator) return;

              startDrag(
                {
                  type: 'move-shape',
                  startPointerMercator,
                  startCenterMercator: { x: modelData.mercator.x, y: modelData.mercator.y },
                },
                'move-shape',
              );
            }}
          />

          {overlay.verticalConnectors.map((connector, index) => (
            <line
              key={`connector-${ringHandleKeys[index]}`}
              x1={connector.from.x}
              y1={connector.from.y}
              x2={connector.to.x}
              y2={connector.to.y}
              stroke="rgba(15, 23, 42, 0.35)"
              strokeWidth={1.4}
              strokeDasharray="4 5"
              vectorEffect="non-scaling-stroke"
            />
          ))}

          <path
            d={overlay.topPathData}
            fill="rgba(249, 115, 22, 0.08)"
            stroke="rgba(249, 115, 22, 0.95)"
            strokeWidth={2.2}
            strokeDasharray="7 5"
            vectorEffect="non-scaling-stroke"
          />

          {overlay.imageShapes.map((imageShape) => {
            const imageModel = imageShapes[imageShape.id];
            const isSelected = selectedImageId === imageShape.id;

            return (
              <g key={imageShape.id}>
                {isSelected ? (
                  <>
                    <path
                      d={imageShape.framePathData}
                      fill="rgba(255,255,255,0.06)"
                      stroke="rgba(15, 23, 42, 0.92)"
                      strokeWidth={2}
                      strokeDasharray="6 5"
                      vectorEffect="non-scaling-stroke"
                    />
                    <line
                      x1={imageShape.topCenter.x}
                      y1={imageShape.topCenter.y}
                      x2={imageShape.rotateHandle.x}
                      y2={imageShape.rotateHandle.y}
                      stroke="rgba(15, 23, 42, 0.9)"
                      strokeWidth={1.8}
                      vectorEffect="non-scaling-stroke"
                    />
                  </>
                ) : null}

                <image
                  href={imageShape.imageHref}
                  x={imageShape.center.x - imageShape.widthPixels / 2}
                  y={imageShape.center.y - imageShape.heightPixels / 2}
                  width={imageShape.widthPixels}
                  height={imageShape.heightPixels}
                  opacity={imageShape.id === 'panel' ? 0.96 : 1}
                  preserveAspectRatio="none"
                  transform={`rotate(${imageShape.rotationDeg} ${imageShape.center.x} ${imageShape.center.y})`}
                  style={{
                    pointerEvents: 'auto',
                    cursor: activeHandle === `image-${imageShape.id}-move` ? 'grabbing' : 'grab',
                    filter: isSelected ? 'drop-shadow(0 12px 18px rgba(15,23,42,0.22))' : 'drop-shadow(0 8px 14px rgba(15,23,42,0.16))',
                  }}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();

                    const altitudeMeters = getImageShapeAltitude(imageModel, shapeStateRef.current);
                    const localPointer = getPointerLocalMetersAtAltitude(event.clientX, event.clientY, altitudeMeters);
                    if (!localPointer) return;

                    const currentShapeModel = getTransformModelData(shapeStateRef.current);
                    const startPointerMercator = imageShape.id === 'observer'
                      ? getPointerMercator(event.clientX, event.clientY)
                      : undefined;

                    setSelectedImageId(imageShape.id);
                    startDrag(
                      {
                        type: 'image-move',
                        imageId: imageShape.id,
                        altitudeMode: imageModel.altitudeMode,
                        pointerOffset: {
                          x: imageModel.localPoint.x - localPointer.x,
                          y: imageModel.localPoint.y - localPointer.y,
                        },
                        startPointerMercator,
                        startCenterMercator: imageShape.id === 'observer'
                          ? { x: currentShapeModel.mercator.x, y: currentShapeModel.mercator.y }
                          : undefined,
                        previousPointerMercator: startPointerMercator,
                      },
                      `image-${imageShape.id}-move`,
                    );
                  }}
                />

                {isSelected ? (
                  <>
                    <circle
                      cx={imageShape.rotateHandle.x}
                      cy={imageShape.rotateHandle.y}
                      r={HANDLE_RADIUS}
                      fill={activeHandle === `image-${imageShape.id}-rotate` ? '#0f172a' : '#ffffff'}
                      stroke="#0f172a"
                      strokeWidth={3}
                      vectorEffect="non-scaling-stroke"
                      style={{ pointerEvents: 'auto', cursor: 'grab' }}
                      onPointerDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        const pointerScreenPoint = getPointerScreenPoint(event.clientX, event.clientY);
                        if (!pointerScreenPoint) return;

                        setSelectedImageId(imageShape.id);
                        startDrag(
                          {
                            type: 'image-rotate',
                            imageId: imageShape.id,
                            center: imageShape.center,
                            rotationOffsetDeg: normalizeDegrees(
                              imageShape.rotationDeg - getAngleBetweenPointsDeg(imageShape.center, pointerScreenPoint),
                            ),
                          },
                          `image-${imageShape.id}-rotate`,
                        );
                      }}
                    />

                    <circle
                      cx={imageShape.resizeHandle.x}
                      cy={imageShape.resizeHandle.y}
                      r={IMAGE_RESIZE_HANDLE_RADIUS}
                      fill={activeHandle === `image-${imageShape.id}-scale` ? '#0f172a' : '#38bdf8'}
                      stroke="#ffffff"
                      strokeWidth={2.5}
                      vectorEffect="non-scaling-stroke"
                      style={{ pointerEvents: 'auto', cursor: 'nwse-resize' }}
                      onPointerDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        const pointerScreenPoint = getPointerScreenPoint(event.clientX, event.clientY);
                        if (!pointerScreenPoint) return;

                        setSelectedImageId(imageShape.id);
                        startDrag(
                          {
                            type: 'image-scale',
                            imageId: imageShape.id,
                            center: imageShape.center,
                            startDistance: Math.max(
                              getDistanceBetweenPoints(imageShape.center, pointerScreenPoint),
                              1,
                            ),
                            startScale: imageModel.scale,
                          },
                          `image-${imageShape.id}-scale`,
                        );
                      }}
                    />
                  </>
                ) : null}
              </g>
            );
          })}

          {overlay.bottomHandles.map((handle) => (
            <circle
              key={handle.label}
              cx={handle.x}
              cy={handle.y}
              r={HANDLE_RADIUS}
              fill={activeHandle === handle.label ? '#0f172a' : '#ffffff'}
              stroke={activeHandle === handle.label ? '#38bdf8' : '#0369a1'}
              strokeWidth={3}
              vectorEffect="non-scaling-stroke"
              style={{ pointerEvents: 'auto', cursor: 'move' }}
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                startDrag({ type: 'ring-handle', ring: 'bottom', key: handle.key }, handle.label);
              }}
            />
          ))}

          {overlay.topHandles.map((handle) => (
            <circle
              key={handle.label}
              cx={handle.x}
              cy={handle.y}
              r={TOP_HANDLE_RADIUS}
              fill={activeHandle === handle.label ? '#0f172a' : topHandleFill}
              stroke="#fff7ed"
              strokeWidth={2.5}
              vectorEffect="non-scaling-stroke"
              style={{ pointerEvents: 'auto', cursor: 'move' }}
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                startDrag({ type: 'ring-handle', ring: 'top', key: handle.key }, handle.label);
              }}
            />
          ))}

          <line
            x1={overlay.rotationAnchor.x}
            y1={overlay.rotationAnchor.y}
            x2={overlay.rotationHandle.x}
            y2={overlay.rotationHandle.y}
            stroke="rgba(15, 23, 42, 0.92)"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />

          <circle
            cx={overlay.rotationHandle.x}
            cy={overlay.rotationHandle.y}
            r={HANDLE_RADIUS + 1}
            fill={activeHandle === 'rotate' ? '#0f172a' : '#ffffff'}
            stroke="#0f172a"
            strokeWidth={3}
            vectorEffect="non-scaling-stroke"
            style={{ pointerEvents: 'auto', cursor: 'grab' }}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const modelPointer = getPointerRotatedLocalAtAltitude(
                event.clientX,
                event.clientY,
                shapeStateRef.current.heightMeters,
              );
              if (!modelPointer) return;

              startDrag(
                {
                  type: 'rotate',
                  rotationOffsetDeg: normalizeDegrees(
                    shapeStateRef.current.rotationZ - getRotationFromModelPoint(modelPointer),
                  ),
                },
                'rotate',
              );
            }}
          />
        </svg>
      ) : null}

      <aside
        className="guide-panel"
        style={{
          position: 'absolute',
          top: 20,
          right: 20,
          width: '360px',
          background: 'rgba(255,255,255,0.94)',
          padding: '20px',
          borderRadius: '14px',
          boxShadow: '0 10px 30px rgba(15, 23, 42, 0.22)',
          zIndex: 10,
          color: '#0f172a',
        }}
      >
        <h3 className="guide-title" style={{ marginTop: 0, color: '#0f172a' }}>
          3D 부채꼴 편집기
        </h3>

        <p className="guide-text" style={{ fontSize: '13px', lineHeight: '1.6', color: '#334155' }}>
          하단 <strong>흰색 점</strong>으로 부채꼴 바닥 범위를 편집하고,
          상단 <strong style={{ color: topHandleFill }}>주황색 점</strong>으로 윗면 캡 모양을 따로 조절합니다.
          이미지 도형은 PPT 오브젝트처럼 직접 선택해서 이동, 회전, 크기 조절할 수 있습니다.
          관찰 아이콘은 네비게이션 마커처럼 드래그하면 부채꼴 범위가 같이 이동하고 진행 방향으로 회전합니다.
          카드 이미지는 상단 높이 평면에 붙어서 함께 움직입니다.
          <strong>3D 깊이</strong>는 주황색 가이드가 도형 뒤로 가려지는지 확인할 때만 사용합니다.
          회전 핸들은 시작 각도 오프셋과 상단 평면 기준 포인터 보정을 함께 적용해서 덜덜 떨리던 현상을 줄였습니다.
        </p>

        <div style={{ marginBottom: '14px' }}>
          <label className="control-label" style={{ display: 'block', marginBottom: '6px', color: '#334155' }}>
            외곽선 스타일
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' }}>
            {outlineStyleOptions.map((option) => (
              <button
                key={option.value}
                onClick={() => updateOutlineStyle(option.value)}
                style={{
                  padding: '9px 10px',
                  border: 'none',
                  borderRadius: '8px',
                  background: outlineStyle === option.value ? '#0f172a' : '#e2e8f0',
                  color: outlineStyle === option.value ? '#ffffff' : '#0f172a',
                  cursor: 'pointer',
                  fontWeight: 700,
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div style={{ marginBottom: '14px' }}>
          <label className="control-label" style={{ display: 'block', marginBottom: '6px', color: '#334155' }}>
            가이드 깊이
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '8px' }}>
            {iconRenderModeOptions.map((option) => (
              <button
                key={option.value}
                onClick={() => updateIconRenderMode(option.value)}
                style={{
                  padding: '9px 10px',
                  border: 'none',
                  borderRadius: '8px',
                  background: iconRenderMode === option.value ? '#0f172a' : '#e2e8f0',
                  color: iconRenderMode === option.value ? '#ffffff' : '#0f172a',
                  cursor: 'pointer',
                  fontWeight: 700,
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div style={{ marginBottom: '14px' }}>
          <label className="control-label" style={{ display: 'block', marginBottom: '6px', color: '#334155' }}>
            높이: <strong>{Math.round(shapeState.heightMeters).toLocaleString()} m</strong>
          </label>
          <input
            type="range"
            min={MIN_HEIGHT_METERS}
            max={MAX_HEIGHT_METERS}
            step={10}
            value={shapeState.heightMeters}
            onChange={(event) => updateShapeState({ heightMeters: Number(event.target.value) })}
            style={{ width: '100%' }}
          />
        </div>

        <div style={{ marginBottom: '14px' }}>
          <label className="control-label" style={{ display: 'block', marginBottom: '6px', color: '#334155' }}>
            경로 데모: <strong>{routePlayback.isPlaying ? '재생 중' : '일시정지'}</strong>
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '8px' }}>
            <button
              onClick={toggleRoutePlayback}
              style={{
                padding: '10px 12px',
                border: 'none',
                borderRadius: '8px',
                background: routePlayback.isPlaying ? '#0f766e' : '#2563eb',
                color: '#ffffff',
                cursor: 'pointer',
                fontWeight: 700,
              }}
            >
              {routePlayback.isPlaying ? '경로 일시정지' : '경로 재생'}
            </button>
            <button
              onClick={resetRoutePlayback}
              style={{
                padding: '10px 12px',
                border: 'none',
                borderRadius: '8px',
                background: '#334155',
                color: '#ffffff',
                cursor: 'pointer',
                fontWeight: 700,
              }}
            >
              경로 리셋
            </button>
          </div>

          <div style={{ fontSize: '12px', color: '#475569', lineHeight: '1.55' }}>
            파란 점선 서울-부산 경로를 따라 부채꼴이 자동 이동합니다.<br />
            진행률: <strong>{routeProgressPercent.toFixed(0)}%</strong> · 루프: <strong>{(routePlayback.loopDurationMs / 1000).toFixed(0)}초</strong>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', marginBottom: '14px' }}>
          <button
            onClick={resetTopRing}
            style={{
              padding: '10px 12px',
              border: 'none',
              borderRadius: '8px',
              background: '#f97316',
              color: '#ffffff',
              cursor: 'pointer',
              fontWeight: 700,
            }}
          >
            상단 리셋
          </button>
          <button
            onClick={resetImageShapes}
            style={{
              padding: '10px 12px',
              border: 'none',
              borderRadius: '8px',
              background: '#0f172a',
              color: '#ffffff',
              cursor: 'pointer',
              fontWeight: 700,
            }}
          >
            이미지 리셋
          </button>
          <button
            onClick={resetEditor}
            style={{
              padding: '10px 12px',
              border: 'none',
              borderRadius: '8px',
              background: '#2563eb',
              color: '#ffffff',
              cursor: 'pointer',
              fontWeight: 700,
            }}
          >
            전체 초기화
          </button>
        </div>

        <p className="guide-text" style={{ fontSize: '12px', lineHeight: '1.55', color: '#475569', marginBottom: '10px' }}>
          회전은 상단 검은 핸들을 드래그합니다. 도형 내부 드래그는 전체 이동,
          흰색 점은 바닥 범위, 주황색 점은 상단 모양 편집입니다.
          관찰 아이콘 드래그는 네비게이션 이동, 경로 재생은 자동 주행 데모,
          다른 이미지 도형은 둥근 핸들로 회전하고 오른쪽 아래 핸들로 확대/축소합니다.
        </p>

        <p className="guide-text" style={{ fontSize: '12px', lineHeight: '1.6', color: '#0f172a', marginBottom: '10px' }}>
          shape mode: <strong>fan-sector</strong><br />
          outline style: <strong>{outlineStyle}</strong><br />
          guide depth: <strong>{iconRenderMode}</strong><br />
          route demo: <strong>{routePlayback.isPlaying ? 'playing' : 'paused'}</strong><br />
          bottom range: <strong>{bottomRangeMeters.toLocaleString()} m</strong><br />
          top range: <strong>{topRangeMeters.toLocaleString()} m</strong><br />
          rotation: <strong>{shapeState.rotationZ.toFixed(1)}deg</strong>
        </p>

        <p className="guide-text" style={{ fontSize: '12px', lineHeight: '1.6', color: '#0f172a', marginBottom: '10px' }}>
          top apex: <strong>{Math.round(topRing.apex.x).toLocaleString()}, {Math.round(topRing.apex.y).toLocaleString()} m</strong><br />
          top arc center: <strong>{Math.round(topRing.center.x).toLocaleString()}, {Math.round(topRing.center.y).toLocaleString()} m</strong><br />
          center: <strong>{shapeState.centerLng.toFixed(4)}, {shapeState.centerLat.toFixed(4)}</strong>
        </p>

        {selectedImage ? (
          <p className="guide-text" style={{ fontSize: '12px', lineHeight: '1.6', color: '#0f172a', marginBottom: '10px' }}>
            selected image: <strong>{selectedImage.label}</strong><br />
            altitude: <strong>{selectedImage.altitudeMode}</strong><br />
            local: <strong>{Math.round(selectedImage.localPoint.x).toLocaleString()}, {Math.round(selectedImage.localPoint.y).toLocaleString()} m</strong><br />
            rotation: <strong>{selectedImage.rotationDeg.toFixed(1)}deg</strong><br />
            scale: <strong>{selectedImage.scale.toFixed(2)}x</strong>
          </p>
        ) : null}

        {overlay ? (
          <p className="guide-text" style={{ fontSize: '12px', lineHeight: '1.6', color: '#475569', marginBottom: 0 }}>
            center pixel: <strong>{overlay.center.x.toFixed(1)}, {overlay.center.y.toFixed(1)}</strong><br />
            rotate handle: <strong>{overlay.rotationHandle.x.toFixed(1)}, {overlay.rotationHandle.y.toFixed(1)}</strong>
          </p>
        ) : null}
      </aside>
    </div>
  );
}

export default App;
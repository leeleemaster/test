import { useCallback, useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import * as THREE from 'three';
import 'maplibre-gl/dist/maplibre-gl.css';

const INITIAL_CENTER: [number, number] = [127.8, 36.2];
const CUSTOM_LAYER_ID = 'shape-editor-layer';
const STYLE_URL = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';
const HANDLE_RADIUS = 7;
const ROTATION_HANDLE_OFFSET_METERS = 50000;
const MIN_HEIGHT_METERS = 20000;
const MAX_HEIGHT_METERS = 180000;

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

type OverlayVertex = ScreenPoint & { index: number };
type OverlaySegment = ScreenPoint & { insertAfter: number };

type OverlayGeometry = {
  center: ScreenPoint;
  rotationAnchor: ScreenPoint;
  rotationHandle: ScreenPoint;
  vertices: OverlayVertex[];
  segmentMidpoints: OverlaySegment[];
  polygonPoints: string;
};

type DragState =
  | {
      type: 'move-shape';
      startPointerMercator: MercatorPoint;
      startCenterMercator: MercatorPoint;
    }
  | { type: 'rotate' }
  | {
      type: 'vertex';
      index: number;
    };

type CustomShapeLayer = maplibregl.CustomLayerInterface & {
  camera?: THREE.Camera;
  scene?: THREE.Scene;
  renderer?: THREE.WebGLRenderer;
  group?: THREE.Group;
  mesh?: THREE.Mesh;
  edges?: THREE.LineSegments;
};

const initialShapeState: ShapeState = {
  centerLng: INITIAL_CENTER[0],
  centerLat: INITIAL_CENTER[1],
  rotationZ: 16,
  heightMeters: 90000,
};

const initialFootprint: LocalPoint[] = [
  { x: -90000, y: 95000 },
  { x: 35000, y: 115000 },
  { x: 120000, y: 30000 },
  { x: 90000, y: -105000 },
  { x: -55000, y: -90000 },
];

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

function getTransformModelData(shape: ShapeState) {
  const mercator = maplibregl.MercatorCoordinate.fromLngLat([shape.centerLng, shape.centerLat], 0);

  return {
    mercator,
    scale: mercator.meterInMercatorCoordinateUnits(),
  };
}

function getShapeExtents(points: LocalPoint[]) {
  return points.reduce(
    (acc, point) => ({
      minX: Math.min(acc.minX, point.x),
      maxX: Math.max(acc.maxX, point.x),
      minY: Math.min(acc.minY, point.y),
      maxY: Math.max(acc.maxY, point.y),
    }),
    {
      minX: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    },
  );
}

function getWorldMercatorForLocalPoint(localPoint: LocalPoint, shape: ShapeState) {
  const modelData = getTransformModelData(shape);
  const rotatedPoint = rotatePoint(localPoint, THREE.MathUtils.degToRad(shape.rotationZ));

  return {
    x: modelData.mercator.x + rotatedPoint.x * modelData.scale,
    y: modelData.mercator.y - rotatedPoint.y * modelData.scale,
  };
}

function projectLocalPoint(map: maplibregl.Map, localPoint: LocalPoint, shape: ShapeState): ScreenPoint {
  const worldMercator = getWorldMercatorForLocalPoint(localPoint, shape);
  const point = map.project(new maplibregl.MercatorCoordinate(worldMercator.x, worldMercator.y, 0).toLngLat());

  return { x: point.x, y: point.y };
}

function buildOverlayGeometry(
  map: maplibregl.Map,
  points: LocalPoint[],
  shape: ShapeState,
): OverlayGeometry {
  const vertices = points.map((point, index) => ({
    index,
    ...projectLocalPoint(map, point, shape),
  }));
  const segmentMidpoints = points.map((point, index) => {
    const nextPoint = points[(index + 1) % points.length];

    return {
      insertAfter: index,
      ...projectLocalPoint(
        map,
        {
          x: (point.x + nextPoint.x) / 2,
          y: (point.y + nextPoint.y) / 2,
        },
        shape,
      ),
    };
  });

  const extents = getShapeExtents(points);
  const center = map.project([shape.centerLng, shape.centerLat]);
  const rotationAnchor = projectLocalPoint(map, { x: 0, y: extents.maxY }, shape);
  const rotationHandle = projectLocalPoint(
    map,
    { x: 0, y: extents.maxY + ROTATION_HANDLE_OFFSET_METERS },
    shape,
  );

  return {
    center: { x: center.x, y: center.y },
    rotationAnchor,
    rotationHandle,
    vertices,
    segmentMidpoints,
    polygonPoints: vertices.map((vertex) => `${vertex.x},${vertex.y}`).join(' '),
  };
}

function createExtrudedGeometry(points: LocalPoint[], heightMeters: number) {
  const shape = new THREE.Shape();
  const [firstPoint, ...restPoints] = points;

  shape.moveTo(firstPoint.x, firstPoint.y);
  restPoints.forEach((point) => shape.lineTo(point.x, point.y));
  shape.lineTo(firstPoint.x, firstPoint.y);

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: heightMeters,
    bevelEnabled: false,
    steps: 1,
    curveSegments: 2,
  });

  geometry.computeVertexNormals();
  return geometry;
}

function disposeMaterial(material: THREE.Material | THREE.Material[]) {
  if (Array.isArray(material)) {
    material.forEach((item) => item.dispose());
    return;
  }

  material.dispose();
}

export function App() {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const layerRef = useRef<CustomShapeLayer | null>(null);
  const isMounted = useRef(false);
  const dragStateRef = useRef<DragState | null>(null);

  const footprintRef = useRef<LocalPoint[]>(initialFootprint);
  const shapeStateRef = useRef<ShapeState>(initialShapeState);

  const [footprint, setFootprint] = useState<LocalPoint[]>(initialFootprint);
  const [shapeState, setShapeState] = useState<ShapeState>(initialShapeState);
  const [overlay, setOverlay] = useState<OverlayGeometry | null>(null);
  const [selectedVertexIndex, setSelectedVertexIndex] = useState<number | null>(null);
  const [activeHandle, setActiveHandle] = useState<string | null>(null);

  const syncOverlay = useCallback((nextShape = shapeStateRef.current, nextFootprint = footprintRef.current) => {
    const map = mapRef.current;
    if (!map) return;

    setOverlay(buildOverlayGeometry(map, nextFootprint, nextShape));
  }, []);

  const rebuildShapeGeometry = useCallback(
    (nextFootprint = footprintRef.current, nextHeightMeters = shapeStateRef.current.heightMeters) => {
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

      if (nextFootprint.length < 3) {
        mapRef.current?.triggerRepaint();
        return;
      }

      // Rebuild the extruded footprint whenever vertices or height change.
      const geometry = createExtrudedGeometry(nextFootprint, nextHeightMeters);
      const topMaterial = new THREE.MeshStandardMaterial({
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

      const mesh = new THREE.Mesh(geometry, [topMaterial, sideMaterial]);
      mesh.frustumCulled = false;

      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geometry),
        new THREE.LineBasicMaterial({ color: 0x082f49 }),
      );
      edges.frustumCulled = false;

      layer.mesh = mesh;
      layer.edges = edges;
      layer.group.add(mesh);
      layer.group.add(edges);

      mapRef.current?.triggerRepaint();
    },
    [],
  );

  const updateShapeState = useCallback(
    (patch: Partial<ShapeState>) => {
      const nextShape = { ...shapeStateRef.current, ...patch };
      shapeStateRef.current = nextShape;
      setShapeState(nextShape);
      syncOverlay(nextShape, footprintRef.current);

      if (patch.heightMeters !== undefined) {
        rebuildShapeGeometry(footprintRef.current, nextShape.heightMeters);
      }

      mapRef.current?.triggerRepaint();
    },
    [rebuildShapeGeometry, syncOverlay],
  );

  const updateFootprint = useCallback(
    (nextFootprint: LocalPoint[]) => {
      footprintRef.current = nextFootprint;
      setFootprint(nextFootprint);
      syncOverlay(shapeStateRef.current, nextFootprint);
      rebuildShapeGeometry(nextFootprint, shapeStateRef.current.heightMeters);
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

  const getPointerLocalMeters = useCallback(
    (clientX: number, clientY: number) => {
      const mercator = getPointerMercator(clientX, clientY);
      if (!mercator) return null;

      const modelData = getTransformModelData(shapeStateRef.current);
      const localPoint = {
        x: (mercator.x - modelData.mercator.x) / modelData.scale,
        y: -(mercator.y - modelData.mercator.y) / modelData.scale,
      };

      return rotatePoint(localPoint, -THREE.MathUtils.degToRad(shapeStateRef.current.rotationZ));
    },
    [getPointerMercator],
  );

  const startDrag = useCallback((dragState: DragState, handleId: string, nextSelectedVertexIndex?: number | null) => {
    dragStateRef.current = dragState;
    setActiveHandle(handleId);

    if (nextSelectedVertexIndex !== undefined) {
      setSelectedVertexIndex(nextSelectedVertexIndex);
    }

    mapRef.current?.dragPan.disable();
  }, []);

  const insertVertexAfter = useCallback(
    (insertAfter: number) => {
      const points = footprintRef.current;
      const nextIndex = insertAfter + 1;
      const currentPoint = points[insertAfter];
      const nextPoint = points[(insertAfter + 1) % points.length];
      const insertedPoint = {
        x: (currentPoint.x + nextPoint.x) / 2,
        y: (currentPoint.y + nextPoint.y) / 2,
      };
      const nextFootprint = [
        ...points.slice(0, nextIndex),
        insertedPoint,
        ...points.slice(nextIndex),
      ];

      updateFootprint(nextFootprint);
      setSelectedVertexIndex(nextIndex);
    },
    [updateFootprint],
  );

  const deleteSelectedVertex = useCallback(() => {
    if (selectedVertexIndex === null || footprintRef.current.length <= 3) return;

    const nextFootprint = footprintRef.current.filter((_, index) => index !== selectedVertexIndex);
    updateFootprint(nextFootprint);
    setSelectedVertexIndex((current) => {
      if (current === null) return null;
      return Math.min(current, nextFootprint.length - 1);
    });
  }, [selectedVertexIndex, updateFootprint]);

  const resetEditor = useCallback(() => {
    footprintRef.current = initialFootprint;
    shapeStateRef.current = initialShapeState;
    setFootprint(initialFootprint);
    setShapeState(initialShapeState);
    setSelectedVertexIndex(null);
    setActiveHandle(null);

    syncOverlay(initialShapeState, initialFootprint);
    rebuildShapeGeometry(initialFootprint, initialShapeState.heightMeters);

    mapRef.current?.easeTo({
      center: INITIAL_CENTER,
      zoom: 6,
      pitch: 68,
      bearing: 24,
      duration: 600,
    });
  }, [rebuildShapeGeometry, syncOverlay]);

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

      const localPointer = getPointerLocalMeters(event.clientX, event.clientY);
      if (!localPointer) return;

      if (dragState.type === 'rotate') {
        const angleRad = Math.atan2(localPointer.y, localPointer.x);
        const rotationZ = normalizeDegrees(THREE.MathUtils.radToDeg(angleRad) - 90);
        updateShapeState({ rotationZ });
        return;
      }

      const nextFootprint = footprintRef.current.map((point, index) => (
        index === dragState.index ? localPointer : point
      ));
      updateFootprint(nextFootprint);
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
  }, [getPointerLocalMeters, getPointerMercator, updateFootprint, updateShapeState]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;

      const activeElement = document.activeElement;
      if (
        activeElement instanceof HTMLInputElement
        || activeElement instanceof HTMLTextAreaElement
        || activeElement instanceof HTMLSelectElement
      ) {
        return;
      }

      if (selectedVertexIndex === null) return;

      event.preventDefault();
      deleteSelectedVertex();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [deleteSelectedVertex, selectedVertexIndex]);

  useEffect(() => {
    if (isMounted.current || !mapContainerRef.current) return;
    isMounted.current = true;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: STYLE_URL,
      center: INITIAL_CENTER,
      zoom: 6,
      pitch: 68,
      bearing: 24,
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

        const currentShape = shapeStateRef.current;
        const modelData = getTransformModelData(currentShape);

        this.group.rotation.z = THREE.MathUtils.degToRad(currentShape.rotationZ);

        const layerMatrix = new THREE.Matrix4()
          .makeTranslation(modelData.mercator.x, modelData.mercator.y, modelData.mercator.z)
          .scale(new THREE.Vector3(modelData.scale, -modelData.scale, modelData.scale));

        this.camera.projectionMatrix = new THREE.Matrix4()
          .fromArray(matrix)
          .multiply(layerMatrix);

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

        this.group?.clear();
        this.renderer?.dispose();

        if (layerRef.current === this) {
          layerRef.current = null;
        }
      },
    };

    const syncFromMap = () => syncOverlay();
    const clearSelection = () => {
      if (dragStateRef.current) return;
      setSelectedVertexIndex(null);
    };

    map.on('load', () => {
      if (!map.getLayer(CUSTOM_LAYER_ID)) {
        map.addLayer(customLayer);
      }
      syncOverlay();
    });
    map.on('move', syncFromMap);
    map.on('resize', syncFromMap);
    map.on('click', clearSelection);

    return () => {
      map.off('move', syncFromMap);
      map.off('resize', syncFromMap);
      map.off('click', clearSelection);

      if (map.getLayer(CUSTOM_LAYER_ID)) {
        map.removeLayer(CUSTOM_LAYER_ID);
      }

      map.remove();
      mapRef.current = null;
      isMounted.current = false;
    };
  }, [rebuildShapeGeometry, syncOverlay]);

  const selectedVertex = selectedVertexIndex === null ? null : footprint[selectedVertexIndex];
  const overlayStroke = 'rgba(14, 165, 233, 0.96)';
  const overlayFill = 'rgba(56, 189, 248, 0.12)';

  return (
    <div className="app-shell">
      <div ref={mapContainerRef} className="map-container" />

      {overlay ? (
        <svg
          width="100%"
          height="100%"
          style={{ position: 'absolute', inset: 0, zIndex: 9, overflow: 'visible', pointerEvents: 'none' }}
        >
          <polygon
            points={overlay.polygonPoints}
            fill={overlayFill}
            stroke={overlayStroke}
            strokeWidth={2.5}
            vectorEffect="non-scaling-stroke"
            style={{
              pointerEvents: 'auto',
              cursor: activeHandle === 'move-shape' ? 'grabbing' : 'grab',
            }}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();

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
                null,
              );
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setSelectedVertexIndex(null);
            }}
          />

          <line
            x1={overlay.rotationAnchor.x}
            y1={overlay.rotationAnchor.y}
            x2={overlay.rotationHandle.x}
            y2={overlay.rotationHandle.y}
            stroke="rgba(15, 23, 42, 0.92)"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />

          {overlay.segmentMidpoints.map((segment) => (
            <g key={`segment-${segment.insertAfter}`} style={{ pointerEvents: 'auto', cursor: 'copy' }}>
              <circle
                cx={segment.x}
                cy={segment.y}
                r={HANDLE_RADIUS - 1}
                fill="#f8fafc"
                stroke="#10b981"
                strokeWidth={2.5}
                vectorEffect="non-scaling-stroke"
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  insertVertexAfter(segment.insertAfter);
                }}
              />
              <text
                x={segment.x}
                y={segment.y + 3.5}
                textAnchor="middle"
                fontSize="11"
                fontWeight="700"
                fill="#047857"
                style={{ userSelect: 'none' }}
              >
                +
              </text>
            </g>
          ))}

          {overlay.vertices.map((vertex) => (
            <circle
              key={vertex.index}
              cx={vertex.x}
              cy={vertex.y}
              r={HANDLE_RADIUS}
              fill={selectedVertexIndex === vertex.index ? '#0f172a' : '#ffffff'}
              stroke={selectedVertexIndex === vertex.index ? '#38bdf8' : '#0369a1'}
              strokeWidth={3}
              vectorEffect="non-scaling-stroke"
              style={{ pointerEvents: 'auto', cursor: 'move' }}
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                startDrag({ type: 'vertex', index: vertex.index }, `vertex-${vertex.index}`, vertex.index);
              }}
            />
          ))}

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
              startDrag({ type: 'rotate' }, 'rotate');
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
          width: '340px',
          background: 'rgba(255,255,255,0.94)',
          padding: '20px',
          borderRadius: '14px',
          boxShadow: '0 10px 30px rgba(15, 23, 42, 0.22)',
          zIndex: 10,
          color: '#0f172a',
        }}
      >
        <h3 className="guide-title" style={{ marginTop: 0, color: '#0f172a' }}>
          3D 도형 설계
        </h3>
        <p className="guide-text" style={{ fontSize: '13px', lineHeight: '1.6', color: '#334155' }}>
          도형 내부를 드래그하면 전체 이동, 꼭짓점을 드래그하면 선 모양이 바뀝니다.
          선 중간의 <strong>+</strong> 핸들로 점을 추가하고, 선택된 점은 삭제할 수 있습니다.
          상단 회전 핸들로 회전하고, 아래 슬라이더로 3D 높이를 편집합니다.
        </p>

        <div style={{ marginBottom: '14px' }}>
          <label className="control-label" style={{ display: 'block', marginBottom: '6px', color: '#334155' }}>
            높이: <strong>{Math.round(shapeState.heightMeters).toLocaleString()} m</strong>
          </label>
          <input
            type="range"
            min={MIN_HEIGHT_METERS}
            max={MAX_HEIGHT_METERS}
            step={5000}
            value={shapeState.heightMeters}
            onChange={(event) => updateShapeState({ heightMeters: Number(event.target.value) })}
            style={{ width: '100%' }}
          />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '14px' }}>
          <button
            onClick={deleteSelectedVertex}
            disabled={selectedVertexIndex === null || footprint.length <= 3}
            style={{
              padding: '10px 12px',
              border: 'none',
              borderRadius: '8px',
              background: selectedVertexIndex === null || footprint.length <= 3 ? '#cbd5e1' : '#ef4444',
              color: selectedVertexIndex === null || footprint.length <= 3 ? '#64748b' : '#ffffff',
              cursor: selectedVertexIndex === null || footprint.length <= 3 ? 'not-allowed' : 'pointer',
              fontWeight: 700,
            }}
          >
            선택 점 삭제
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
            초기화
          </button>
        </div>

        <p className="guide-text" style={{ fontSize: '12px', lineHeight: '1.55', color: '#475569', marginBottom: '10px' }}>
          점 삭제는 <strong>Delete</strong> 또는 <strong>Backspace</strong> 키로도 가능합니다.
          단, 선이 서로 교차하는 복잡한 폴리곤은 메쉬가 예상과 다르게 보일 수 있습니다.
        </p>

        <p className="guide-text" style={{ fontSize: '12px', lineHeight: '1.6', color: '#0f172a', marginBottom: '10px' }}>
          point count: <strong>{footprint.length}</strong><br />
          selected point: <strong>{selectedVertexIndex === null ? '-' : selectedVertexIndex + 1}</strong><br />
          center: <strong>{shapeState.centerLng.toFixed(4)}, {shapeState.centerLat.toFixed(4)}</strong><br />
          rotation: <strong>{shapeState.rotationZ.toFixed(1)}deg</strong>
        </p>

        {selectedVertex ? (
          <p className="guide-text" style={{ fontSize: '12px', lineHeight: '1.6', color: '#0f172a', marginBottom: '10px' }}>
            selected local x: <strong>{Math.round(selectedVertex.x).toLocaleString()} m</strong><br />
            selected local y: <strong>{Math.round(selectedVertex.y).toLocaleString()} m</strong>
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

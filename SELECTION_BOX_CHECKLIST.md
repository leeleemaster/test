# 선택상자(Selection Box) 기반 도형 구현 체크리스트

> **이 문서의 목적**
> 이 저장소(`map-aabb`)는 "선택상자(SVG 오버레이 + 핸들)"를 기준으로 도형을 이동·회전·정점편집하고,
> 같은 데이터를 Three.js로 3D extrude 하는 **레퍼런스 구현**입니다.
>
> 다른 프로젝트(여러 도형을 묶은 **그룹 도형**을 선택상자로 변형하는 구현)에서 동작이 어긋날 때,
> 이 체크리스트를 그쪽 AI/코드에 그대로 넣어 **항목별로 대조**하면 어디서 규약이 깨졌는지 바로 찾을 수 있습니다.
>
> 모든 항목은 `[ ]` 체크박스로 되어 있습니다. 다른 프로젝트 코드가 같은 규약을 지키는지 한 줄씩 확인하세요.
> 핵심 구현은 전부 `map-aabb/src/app/app.tsx` 한 파일에 있습니다. (참조 줄번호 포함)

---

## 0. TL;DR — 그룹 도형에서 깨지기 쉬운 5가지

그룹 도형을 선택상자로 변형할 때 거의 항상 이 5곳에서 버그가 납니다. 먼저 여기부터 보세요.

- [ ] **Y축 부호 뒤집힘**: 로컬 좌표는 Y가 위(+), Mercator/화면은 Y가 아래(+). 정변환·역변환 양쪽에 `-` 부호가 한 번씩 들어가야 함. (한쪽만 들어가면 회전·이동이 거울처럼 뒤집힘)
- [ ] **회전 피벗**: 회전은 **그룹/도형 중심** 기준이어야 함. 개별 자식 도형의 자기 중심으로 회전하면 그룹이 흩어짐.
- [ ] **이동(move)은 Mercator delta로**: 로컬 좌표 delta로 이동하면 회전된 상태에서 드리프트가 생김. 포인터 시작 위치와 중심 시작 위치를 저장해 **Mercator 공간 차이**로 옮겨야 함.
- [ ] **오버레이와 메쉬가 같은 변환 규약 공유**: SVG 선택상자와 3D 메쉬가 회전·스케일·Y부호를 동일하게 적용하지 않으면 선택상자와 실제 도형이 어긋남.
- [ ] **stale closure**: `pointermove`/custom layer `render`에서 최신값을 `useRef`로 읽어야 함. `useState` 값만 클로저로 잡으면 드래그 중 옛 값이 적용됨.

---

## 1. 좌표계 정의 (가장 중요)

이 구현은 **3개의 좌표계**를 명확히 분리합니다.

- [ ] **로컬 미터 좌표 (Local meters)** — 도형/그룹 중심을 원점으로 하는 평면 좌표. **Y축이 위로 +**. footprint 정점이 여기 저장됨. (`LocalPoint`, `app.tsx:16`)
- [ ] **Mercator 좌표** — MapLibre `MercatorCoordinate`. **Y축이 아래로 +**. (`MercatorPoint`, `app.tsx:26`)
- [ ] **화면 픽셀 좌표 (Screen)** — SVG 오버레이가 그려지는 좌표. **Y축이 아래로 +**. (`ScreenPoint`, `app.tsx:21`)
- [ ] 회전(`rotationZ`)은 **로컬 좌표계에서만** 적용한다. Mercator나 화면 좌표에서 직접 회전시키지 않는다.
- [ ] 데이터의 단일 출처(single source of truth)는 로컬 미터 footprint + `ShapeState(center, rotation, height)` 다. 화면 좌표는 매 프레임 **파생**될 뿐 저장하지 않는다.

> 그룹 도형 대응: "그룹 로컬 좌표"의 원점 = 그룹 바운딩의 중심. 각 자식 도형 정점은 그룹 로컬 좌표로 표현하면 그룹 회전/이동이 한 번의 변환으로 끝남.

---

## 2. 상태 모델 (Data Model)

- [ ] `ShapeState`: `centerLng`, `centerLat`(중심 지도좌표), `rotationZ`(도), `heightMeters`. (`app.tsx:31`)
- [ ] footprint = `LocalPoint[]` (중심 기준 로컬 미터). (`app.tsx:95`)
- [ ] 회전/이동 같은 **변형 파라미터**(center, rotation)와 **형태 데이터**(footprint 정점)를 분리해서 저장한다.
- [ ] 그룹 도형이라면: `groupState = { centerLng, centerLat, rotationZ, scaleX?, scaleY? }` + `children: LocalPoint[][]` 형태로, **자식은 그룹 로컬 좌표로만** 들고 있어야 함. (자식마다 절대 지도좌표를 들고 있으면 그룹 변형 시 동기화가 깨짐)

---

## 3. 변환 파이프라인 (Forward: 로컬 → 화면)

순서가 고정되어 있고, 이 순서를 어기면 회전 중심이 어긋납니다.

- [ ] **(1) 회전**: `rotatePoint(point, degToRad(rotationZ))` — 표준 2D 회전 행렬. (`app.tsx:114`)
- [ ] **(2) 중심 → Mercator + scale**: `getTransformModelData()`가 center를 `MercatorCoordinate.fromLngLat`로, scale은 `meterInMercatorCoordinateUnits()`로 구함. (`app.tsx:132`)
- [ ] **(3) 로컬 → 월드 Mercator**: `getWorldMercatorForLocalPoint()` (`app.tsx:244`)
  ```
  worldX = center.x + rotated.x * scale
  worldY = center.y - rotated.y * scale     // ← Y 부호 반전 (필수)
  ```
- [ ] **(4) Mercator → lngLat → 화면 픽셀**: `projectLocalPoint()`가 `new MercatorCoordinate(x,y,0).toLngLat()` 후 `map.project()`. (`app.tsx:254`)
- [ ] 위 정변환의 **Y 부호 반전**(`center.y - rotated.y * scale`)이 있는지 확인. 이게 로컬(Y↑)과 Mercator(Y↓)를 잇는 부분.

---

## 4. 역변환 파이프라인 (Inverse: 화면/포인터 → 로컬)

드래그 처리에서 포인터를 로컬 미터로 되돌리는 과정. **정변환의 정확한 역순 + 역부호**여야 함.

- [ ] **(1) 화면 → Mercator**: `getPointerMercator()` — 컨테이너 rect 보정 후 `map.unproject()` → `MercatorCoordinate.fromLngLat()`. (`app.tsx:549`)
- [ ] **(2) Mercator → 로컬(회전 전)**: `getPointerLocalMeters()` (`app.tsx:563`)
  ```
  local.x =  (mercator.x - center.x) / scale
  local.y = -(mercator.y - center.y) / scale   // ← Y 부호 반전 (정변환과 짝)
  ```
- [ ] **(3) 회전 해제**: `rotatePoint(local, -degToRad(rotationZ))` — **음수 각도**로 역회전. (`app.tsx:574`)
- [ ] 정변환에서 `rotate → scale → Y반전` 했으면, 역변환은 `Y반전 → unscale → -rotate` 순. 순서/부호가 짝이 맞는지 확인.

> 그룹에서 흔한 버그: 역회전을 빼먹거나(`-rotation` 안 함) Y부호를 정변환과 다르게 줘서, 회전된 그룹에서 핸들을 잡으면 엉뚱한 자식이 잡히는 현상.

---

## 5. 선택상자 / 핸들 구성 (Overlay)

선택상자는 Three 메쉬가 아니라 **SVG 오버레이**다. `buildOverlayGeometry()`가 매 프레임 화면 좌표를 계산. (`app.tsx:261`)

- [ ] **이동 영역**: footprint path(`<path>`) 내부를 드래그하면 전체 이동. (`app.tsx:913`)
- [ ] **정점 핸들**: 각 꼭짓점 `<circle>`. 드래그로 해당 정점만 이동. (`app.tsx:989`)
- [ ] **선분 중간 `+` 핸들**: 점 추가용. (`segmentMidpoints`, `app.tsx:959`)
- [ ] **회전 핸들 + 앵커선**: 도형 상단(+Y 방향)에 `ROTATION_HANDLE_OFFSET_METERS`만큼 떨어진 핸들과 연결선. (`app.tsx:318`, `app.tsx:1008`)
- [ ] 오버레이 좌표는 **메쉬와 동일한 `projectLocalPoint`로 계산**한다 → 선택상자와 3D 도형이 항상 일치. (서로 다른 변환을 쓰면 어긋남)
- [ ] SVG는 `pointer-events:none` 컨테이너에 두고, **개별 핸들만** `pointerEvents:'auto'`로 살린다. (`app.tsx:911`, `921`)
- [ ] 외곽선 스타일(실선/점선/점점선)이 SVG `stroke-dasharray`와 Three edge material **양쪽에 동일하게** 반영된다. (`getOutlineSvgDasharray` `app.tsx:218` ↔ `createOutlineMaterial` `app.tsx:224`)

> 그룹 도형 대응: 그룹 선택상자는 보통 **AABB 8핸들(모서리4 + 변4) + 회전핸들**. 각 핸들의 로컬 좌표를 그룹 extents(`getShapeExtents` `app.tsx:141`)에서 계산하고, 위 정변환으로 화면에 투영하면 됨.

---

## 6. 드래그 상태 머신 (DragState)

- [ ] 드래그 종류를 **명시적 유니온 타입**으로 구분: `move-shape | rotate | curve | vertex`. (`DragState`, `app.tsx:63`)
- [ ] `onPointerDown`에서 어떤 핸들을 잡았는지 `dragStateRef`에 기록하고 `dragPan.disable()`로 지도 패닝을 끈다. (`startDrag`, `app.tsx:579`)
- [ ] 전역 `window`의 `pointermove`/`pointerup`으로 처리한다 (핸들 밖으로 나가도 드래그 유지). (`app.tsx:744`)
- [ ] `pointerup`에서 `dragStateRef=null`, `dragPan.enable()`로 복구. (`app.tsx:736`)
- [ ] 드래그 중에는 지도 클릭으로 선택 해제가 발생하지 않게 가드. (`clearSelection`이 `dragStateRef` 있으면 무시, `app.tsx:868`)

---

## 7. 이동(Move) 로직 — 드리프트 방지

- [ ] 이동은 **Mercator 공간의 차이**로 계산한다 (로컬 delta 아님). (`app.tsx:676`)
  ```
  nextCenter.x = startCenterMercator.x + (curPointerMercator.x - startPointerMercator.x)
  nextCenter.y = startCenterMercator.y + (curPointerMercator.y - startPointerMercator.y)
  ```
- [ ] 드래그 시작 시 `startPointerMercator`와 `startCenterMercator`를 **둘 다 저장**한다. (포인터-중심 오프셋 보존 → 도형이 커서로 점프하지 않음) (`app.tsx:928`)
- [ ] 새 중심을 `MercatorCoordinate.toLngLat()`로 되돌려 `centerLng/centerLat` 갱신. (`app.tsx:684`)
- [ ] 이동은 회전과 **독립**이다. Mercator 공간 평행이동이므로 `rotationZ`에 영향받지 않는다. (로컬 delta로 옮기면 회전된 상태에서 방향이 틀어짐 → 그룹에서 흔한 버그)

---

## 8. 회전(Rotate) 로직

- [ ] 포인터를 로컬 좌표로 변환 후 `atan2(local.y, local.x)`로 각도 계산. (`app.tsx:701`)
- [ ] 회전 핸들이 상단(+Y)에 있으므로 **`-90도` 보정**. (`app.tsx:702`)
- [ ] `normalizeDegrees()`로 `-180~180` 정규화. (`app.tsx:124`)
- [ ] 회전 중심은 항상 `ShapeState.center`(= 그룹 중심). 자식 개별 중심으로 회전하지 않는다.

> 그룹 도형 대응: 자식 정점이 그룹 로컬 좌표면, 그룹 `rotationZ` 한 값만 바꾸면 정변환이 자동으로 모든 자식을 그룹 중심 기준으로 회전시킴. 자식별로 회전 누적시키지 말 것(부동소수 누적 오차/드리프트).

---

## 9. 3D 메쉬 ↔ 선택상자 동기화 (Three.js custom layer)

선택상자(2D)와 실제 도형(3D)이 어긋나지 않으려면 Three 쪽도 같은 규약을 따라야 함.

- [ ] custom layer `render()`에서 그룹 회전: `group.rotation.z = degToRad(rotationZ)`. (`app.tsx:829`)
- [ ] 레이어 행렬에 **Y 스케일 반전**: `scale(new Vector3(scale, -scale, scale))`. (`app.tsx:833`) — 4장의 Y부호 반전과 동일한 이유.
- [ ] `camera.projectionMatrix = mapMatrix * layerMatrix` 순서. (`app.tsx:835`)
- [ ] **MapLibre 버전 시그니처 주의**: v4는 `render(gl, matrix)`로 매트릭스가 직접 옴. v5는 `defaultProjectionData.mainMatrix`를 써야 함. 이 프로젝트는 `maplibre-gl@4.7.1`. (README 227행 / `app.tsx:823`) — **그룹 프로젝트의 maplibre 버전이 다르면 여기서 도형이 안 보이거나 어긋남.**
- [ ] 편집 중 프레임 유지 위해 `render` 끝과 상태 갱신 시 `map.triggerRepaint()` 호출. (`app.tsx:842`)
- [ ] geometry 교체 시 기존 `mesh`/`edges`의 `geometry.dispose()` + material dispose. (`rebuildShapeGeometry` `app.tsx:409`)

---

## 10. React 상태 갱신 전략 (stale closure 방지)

- [ ] 표시용 값은 `useState`, **드래그/렌더에서 즉시 읽을 최신값은 `useRef`**로 이중 보관. (`app.tsx:385`~`393`)
- [ ] 상태 갱신 함수가 ref와 state를 **함께** 업데이트한다. (`updateShapeState` `app.tsx:479`, `updateFootprint` `app.tsx:500`)
- [ ] `pointermove`, custom layer `render`는 항상 `xxxRef.current`를 읽는다 (클로저로 잡은 state 값을 쓰지 않음). (`app.tsx:399`, `826`)
- [ ] 상태 변경 후 `syncOverlay()`(오버레이 재계산) + `rebuildShapeGeometry()`(메쉬 재생성)를 호출해 2D/3D 동시 갱신. (`app.tsx:506`~`512`)

> 그룹에서 흔한 버그: 그룹 변형 핸들러가 옛 자식 배열을 클로저로 잡아, 빠르게 드래그하면 일부 자식이 한 프레임 뒤처지는 현상 → ref로 최신 배열 읽기.

---

## 11. 정점 추가/삭제 (형태 편집)

- [ ] 선분 중간 `+`로 점 추가: 곡선 오프셋을 보존하며 분할. (`insertVertexAfter` `app.tsx:590`)
- [ ] 점 삭제는 최소 3점 유지(`length <= 3` 가드). (`deleteSelectedVertex` `app.tsx:624`)
- [ ] `Delete`/`Backspace` 키 처리 시 input/textarea/select 포커스면 무시. (`app.tsx:757`)
- [ ] 정점 편집과 회전/이동이 **같은 재생성 경로**(`updateFootprint → syncOverlay + rebuildShapeGeometry`)를 탄다. (분기마다 따로 갱신하면 불일치 발생)

---

## 12. 대조용 빠른 검사 시나리오

다른 프로젝트에 이 동작들을 그대로 시켜보고 어긋나는 항목을 찾으세요.

- [ ] **회전 0도**에서 도형 이동 → 커서와 도형이 같이 움직이고 점프 없음.
- [ ] **회전 90도**에서 도형 이동 → 여전히 커서 방향대로 움직임(드리프트/거울반전 없음). ← 7장 Mercator-delta 검증.
- [ ] **회전 45도**에서 특정 정점/자식 핸들 잡기 → 잡으려던 그 핸들이 잡힘. ← 4장 역회전 검증.
- [ ] 선택상자(2D 윤곽)와 3D 도형의 외곽선이 **모든 각도에서 일치**. ← 5/9장 공유 변환 검증.
- [ ] 빠르게 드래그해도 2D 오버레이와 3D 메쉬가 한 프레임도 어긋나지 않음. ← 10장 ref 검증.
- [ ] 지도 줌/이동(panning) 후에도 선택상자가 도형에 붙어 있음. ← `map.on('move', syncOverlay)` (`app.tsx:879`).

---

## 13. 핵심 함수 색인 (모두 `map-aabb/src/app/app.tsx`)

| 역할 | 함수 | 줄 |
|---|---|---|
| 중심→Mercator+scale | `getTransformModelData` | 132 |
| 2D 회전 | `rotatePoint` | 114 |
| 로컬→월드 Mercator (Y반전) | `getWorldMercatorForLocalPoint` | 244 |
| 로컬→화면 픽셀 | `projectLocalPoint` | 254 |
| 오버레이 전체 화면좌표 빌드 | `buildOverlayGeometry` | 261 |
| 화면→Mercator | `getPointerMercator` | 549 |
| 포인터→로컬(역회전) | `getPointerLocalMeters` | 563 |
| 드래그 시작 | `startDrag` | 579 |
| 이동/회전 상태 갱신 | `updateShapeState` | 479 |
| footprint 갱신 | `updateFootprint` | 500 |
| 3D 메쉬 재생성 | `rebuildShapeGeometry` | 409 |
| custom layer render(Y스케일 반전) | `customLayer.render` | 823 |

---

## 현재 구현의 한계 (그룹 프로젝트와 비교 시 참고)

- [ ] 이 레퍼런스는 **단일 도형**만 다룬다. 그룹/다중 선택은 미구현 → 그룹 프로젝트는 이 변환 규약을 N개로 확장한 것.
- [ ] 스케일(크기 조절) 핸들은 이 구현에 없음(높이 슬라이더만 있음). 그룹의 8핸들 리사이즈는 **6장 추가 + 1~4장 변환 규약**을 동일하게 따라야 함.
- [ ] 자기교차 폴리곤, hole, snapping, undo/redo 미지원.

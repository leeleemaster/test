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

## 전제: 두 프로젝트는 동일 환경

이 체크리스트는 **두 프로젝트(레퍼런스 = 이 저장소, 분석 대상 = 그룹 도형 프로젝트)가 아래와 동일한 스택**이라는 전제로 작성되었습니다. 좌표계/각도/Y부호 규약은 이 스택을 기준으로 합니다. 그룹 프로젝트의 버전이 다르면 그 항목부터 의심하세요.

| 패키지 | 버전 | 규약상 중요한 이유 |
|---|---|---|
| `maplibre-gl` | **4.7.1** | custom layer `render(gl, matrix)` 시그니처(v4 기준). `MercatorCoordinate` / `meterInMercatorCoordinateUnits()` / `project`·`unproject` 좌표 규약. **Mercator Y가 아래로(+)** → Y부호 반전·각도 처리의 근거. |
| `three` | **0.183.x** | `ExtrudeGeometry`, `Matrix4`, `MathUtils.degToRad/radToDeg`, `Group.rotation.z`, `LineDashedMaterial`. |
| `react` / `react-dom` | **19.x** | `useRef`/`useState` 이중화로 stale closure 회피(10장). |
| `vite` | **7.x** | 빌드/HMR. |
| `electron` | **35.x** | 데스크톱 패키징(좌표 규약과 무관). |
| `nx` | **22.5.4** | 모노레포 태스크 러너. |
| `typescript` | **5.9.x** | `DragState` 유니온 등 타입 규약. |

- [ ] 그룹 프로젝트의 `maplibre-gl`이 **4.x(특히 4.7.1)** 인지 확인. **v5면** custom layer가 `render(gl, args)` + `args.defaultProjectionData.mainMatrix`로 바뀌어 9장 매트릭스 처리가 통째로 달라짐 → 이 경우 도형이 안 보이거나 어긋나는 1순위 원인.
- [ ] 그룹 프로젝트도 **MapLibre의 Mercator Y-down** 좌표를 쓰는지 확인(같은 4.7.1이면 동일). 이게 1·3·4·8-A장 Y부호/각도 규약의 출발점.
- [ ] `three` 메이저가 같은 계열(0.18x)인지 확인. `Matrix4`/`MathUtils` API는 이 범위에서 동일.

---

## 0. TL;DR — 그룹 도형에서 깨지기 쉬운 5가지

그룹 도형을 선택상자로 변형할 때 거의 항상 이 5곳에서 버그가 납니다. 먼저 여기부터 보세요.

- [ ] **Y축 부호 뒤집힘**: 로컬 좌표는 Y가 위(+), Mercator/화면은 Y가 아래(+). 정변환·역변환 양쪽에 `-` 부호가 한 번씩 들어가야 함. (한쪽만 들어가면 회전·이동이 거울처럼 뒤집힘)
- [ ] **회전 피벗**: 회전은 **그룹/도형 중심** 기준이어야 함. 개별 자식 도형의 자기 중심으로 회전하면 그룹이 흩어짐.
- [ ] **이동(move)은 Mercator delta로**: 로컬 좌표 delta로 이동하면 회전된 상태에서 드리프트가 생김. 포인터 시작 위치와 중심 시작 위치를 저장해 **Mercator 공간 차이**로 옮겨야 함.
- [ ] **오버레이와 메쉬가 같은 변환 규약 공유**: SVG 선택상자와 3D 메쉬가 회전·스케일·Y부호를 동일하게 적용하지 않으면 선택상자와 실제 도형이 어긋남.
- [ ] **stale closure**: `pointermove`/custom layer `render`에서 최신값을 `useRef`로 읽어야 함. `useState` 값만 클로저로 잡으면 드래그 중 옛 값이 적용됨.
- [ ] **(실제 발견) 맵 모드에서 angle을 `-angle`로 뒤집어주는 코드** → Y축 뒤집힘을 좌표 변환이 아니라 각도에서 땜질한 흔적. **8-A장 참고.**
- [ ] **(실제 발견) 오른쪽으로 일정 이상 돌리면 왼쪽으로 튀는 현상** → `atan2` ±180° 분기점에서 각도 점프. 회전을 누적 delta로 계산하면 발생. **8-A장 참고.**

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

## 8-A. 맵 모드에서 실제로 발견된 회전 버그 2종 (반드시 확인)

> 다른 프로젝트(그룹 도형)에서 보고된 두 증상. 둘 다 **맵 모드의 Y축 뒤집힘 + 각도 처리**가 원인이며,
> 이 레퍼런스 구현은 아래 방식으로 **각도를 따로 보정하지 않고도** 자연스럽게 피한다.

### 증상 ① "사각형 map 모드에서 angle을 반대로 줘야 맞는다" (각도 부호 반전)

- [ ] **근본 원인**: 일반(스크린) 모드는 보통 수학 좌표(Y 위로 +)지만, **맵 모드는 Mercator Y가 아래로(+)** 향한다. 그래서 같은 회전이 화면에서 반대 방향(시계/반시계)으로 보인다.
- [ ] **잘못된 땜질(=그쪽 코드)**: `if (mapMode) angle = -angle` 처럼 **최종 각도를 조건부로 뒤집는** 코드. → 모드별로 부호가 갈려서, 한쪽을 고치면 다른 쪽이 깨지는 악순환.
- [ ] **이 레퍼런스의 올바른 처리**: Y축 뒤집힘을 **좌표 변환 단계에서 딱 한 번** 흡수한다. 포인터를 로컬로 되돌릴 때 `local.y = -(mercator.y - center.y) / scale` 로 Y를 뒤집으므로(`app.tsx:570`), 그 뒤 `atan2(local.y, local.x)`는 **이미 올바른 회전 방향**이 된다. 각도를 다시 `-angle` 할 필요가 없음. (`app.tsx:701`)
- [ ] **체크 포인트**: 그쪽 코드에서 `angle = -angle` / `-rotation` / `mapMode ? a : -a` 같은 **조건부 각도 반전**을 찾는다. 있으면 → Y 뒤집힘을 좌표가 아니라 각도에서 처리하고 있다는 신호. 보정을 떼고 **포인터→로컬 변환의 Y부호**(4장)를 한 번만 맞추면 모드 분기가 사라진다.
- [ ] **정변환·역변환 Y부호가 짝(둘 다 `-`)인지** 재확인: 한쪽만 뒤집혀 있으면 각도가 반대로 나오고, 그걸 가리려고 `-angle`을 넣게 됨. (3장 `app.tsx:251` ↔ 4장 `app.tsx:570`)

#### 왜 굳이 사각형 + map 모드에서 `-angle`을 넣게 됐나 — 수학적 분석

> **결론부터**: 그 `-angle`은 아무렇게나 넣은 게 아니라, **map 렌더 경로에 Y축 반사(Y-flip)가 한 번 더 들어가서 회전 부호가 실제로 뒤집히기 때문**에 그걸 상쇄하려고 넣은 것이다. 즉 *증상에 대해서는 맞는 보정*이지만 *고친 위치가 틀렸다*. (좌표 변환에서 처리할 일을 각도에서 처리함)

- [ ] **핵심 수학: 반사는 회전의 부호를 뒤집는다.** 2D 회전 `R(θ)=[[cosθ,−sinθ],[sinθ,cosθ]]`, Y축 반사 `F=[[1,0],[0,−1]]` 라 하면
  ```
  F · R(θ) · F⁻¹ = R(−θ)
  ```
  즉 좌표계를 Y로 한 번 뒤집은 프레임에서 보면 `+θ` 회전이 `−θ`로 보인다. **이게 `angle = -angle`의 정체다.**
- [ ] **map 모드에 반사가 "한 번 더" 들어오는 지점**: 로컬 미터(Y 위로 +)를 Mercator(Y 아래로 +)로 그릴 때 렌더 행렬이 `scale(s, −s, s)`로 **Y를 −로 반사**한다(9장 / `app.tsx:833`). 스크린 전용 모드엔 없던 이 반사가 map 모드에서 추가되므로, 같은 `rotationZ`를 줘도 도형이 **반대로** 돈다 → 그래서 `−angle`로 되돌린 것.
- [ ] **왜 하필 "사각형"에서 발견되나**: 회전 부호 오류는 **회전 핸들**에서만 방향으로 드러난다(이동·크기조절론 잘 안 보임). 게다가 대칭 도형인 사각형은 정점 모양 단서가 없어서 **회전 방향 자체가 유일한 시각 단서** → 부호 반전이 가장 깔끔하게 재현되는 케이스. (버그의 본질은 "사각형"이 아니라 "회전 부호"다.)
- [ ] **왜 "스크린 모드는 멀쩡하고 map 모드만" 그러나**: 스크린 모드에선 각도를 *재는 프레임*과 *적용/렌더하는 프레임*의 Y 반사 횟수가 같아 상쇄된다. map 모드에선 렌더 쪽에만 반사가 1번 더 생겨 **홀수 번 반사** → 부호가 남는다. 그래서 `if (mapMode)`로 갈린 것.
- [ ] **이 레퍼런스가 `-angle` 없이 되는 이유**: 각도를 **재는 프레임과 적용하는 프레임을 일치**시킨다.
  - 잴 때: 포인터→로컬 변환에서 Y를 한 번 뒤집어(`local.y = -(mercator.y-center.y)/scale`, `app.tsx:570`) **로컬(Y 위로 +) 프레임**의 각도를 얻고,
  - 적용/렌더: 같은 로컬 프레임을 `scale(s,−s,s)`로 한 번 뒤집어 그린다.
  - → 재는 쪽·그리는 쪽 반사 횟수가 같아 부호가 자동 상쇄. **모드 분기도, `−angle`도 불필요.**
- [ ] **올바른 교정 방향(그쪽 프로젝트가 할 일)**: `if (mapMode) angle = -angle`를 지우고, 대신 **포인터→로컬(각도 측정) 단계에서 Y를 한 번만 뒤집어** 측정 프레임을 렌더 프레임과 맞춘다. 그러면 스크린/맵 양쪽이 같은 코드로 동작한다.
- [ ] **남아 있으면 안 되는 신호 grep**: `mapMode ? -a : a`, `isMap && (angle *= -1)`, `-rotation`(렌더 직전 조건부), `flipY ? -θ : θ`. 이런 **모드 의존 부호 분기**가 보이면 반사 보정을 각도에 박아둔 흔적.
- [ ] **반사가 홀수인지 짝수인지 세는 법**: 측정→저장→적용→렌더 전체 파이프라인에서 Y 부호 반전(`-y`, `scale(...,-s,...)`, `flipY`, CSS `scaleY(-1)`)을 **모두 센다**. **짝수면** 부호 정상, **홀수면** 어딘가 `-angle`이 필요해지는 구조 → 홀수를 만든 그 한 곳을 좌표 단계에서 정리한다.

### 증상 ② "오른쪽으로 일정 이상 가면 왼쪽으로 돌아가버린다" (각도 wrap/점프)

- [ ] **근본 원인**: `atan2`는 `-180°~+180°`만 반환하고 **음의 X축(180°)에 분기점(branch cut)** 이 있다. 회전 핸들이 이 경계를 넘는 순간 각도가 `+180 → -180`으로 **불연속 점프**한다.
- [ ] **언제 "튀어 보이나"**: 회전을 **이전 프레임 대비 누적 delta**(`rotation += Δangle`)로 계산하면, 이 점프가 `Δ ≈ -360°`로 잡혀 도형이 반대편으로 홱 돌아간다. → "오른쪽으로 가다 왼쪽으로 돌아감"의 정체.
- [ ] **이 레퍼런스의 올바른 처리**:
  - 회전값을 **매 프레임 포인터의 절대 각도로 직접 설정**한다(누적 delta 아님): `rotationZ = normalizeDegrees(radToDeg(atan2(local.y, local.x)) - 90)`. (`app.tsx:701`) → 분기점을 넘어도 도형 방향은 포인터를 그대로 따라가므로 시각적으로 연속.
  - `normalizeDegrees`가 **이중 모듈로**로 음수까지 안전하게 정규화: `((v + 180) % 360 + 360) % 360 - 180`. (`app.tsx:124`) → 단순 `v % 360` 은 음수에서 깨지므로 금지.
- [ ] **체크 포인트(누적 delta 버그)**: 그쪽 코드가 `newAngle = prevAngle + (curAngle - startAngle)` 또는 직전 포인터 각도와의 차이를 더하는 구조면, 경계 통과 시 점프를 **delta에 `normalizeDegrees`로 감싸** 보정하거나, 가능하면 **절대 각도 방식으로 전환**한다.
- [ ] **체크 포인트(이동 시 wrap)**: 만약 "오른쪽으로 이동"(회전이 아니라 평행이동)에서 발생한다면, 이는 **경도 ±180°(antimeridian) 또는 Mercator X[0,1] wrap**. 이동은 7장처럼 Mercator delta로 처리하되, 결과 경도를 `((lng + 540) % 360) - 180`로 정규화하고 antimeridian 근처를 가드한다. (이 레퍼런스는 한국 영역 중심이라 미노출, 그룹 프로젝트의 이동 범위가 넓으면 노출될 수 있음.)

> 요약: 두 증상 모두 **"각도를 사후 보정하지 말고, Y뒤집힘은 좌표 변환에서 한 번, 회전은 절대 각도 + 이중모듈로 정규화로"** 처리하면 사라진다.

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
- [ ] **맵 모드에서 회전 핸들을 시계방향으로 돌리면 도형도 시계방향**(반대 아님), 각도 보정 코드 없이. ← 8-A 증상① 검증.
- [ ] **회전 핸들을 오른쪽으로 한 바퀴 끝까지(±180° 경계 통과) 끌어도 도형이 반대편으로 튀지 않고 포인터를 연속으로 따라옴**. ← 8-A 증상② 검증.
- [ ] (이동 범위가 넓다면) 도형을 동쪽으로 계속 이동해 경도 경계를 넘어도 갑자기 반대편으로 순간이동하지 않음. ← 8-A 증상② 이동 wrap 검증.

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

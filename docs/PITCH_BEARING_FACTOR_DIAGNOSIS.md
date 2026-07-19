# Pitch/Bearing 상태의 factor 폭증 진단 체크리스트

> 목적: 다른 프로젝트에서 크기 조절·이동 중 `factor가 너무 크게 적용된다`, `마우스를 조금 움직였는데 객체가 폭발한다`는 현상이 발생했을 때 원인을 고정 번호로 공유하고, 이 저장소의 **Pitch/Bearing 테스트** 화면에서 같은 조건을 재현하기 위한 기준 문서다.
>
> 보고 형식: `PB-F번호 + 재현 조건 + 진단 로그`. 예: `PB-F01, pitch=60, bearing=90, 화면 상단에서만 발생`.

## 1. factor가 커지는 수학적 이유

현재 구현의 크기 조절 factor는 개념적으로 다음과 같다.

```text
pointerScreen
  → unproject(pointerScreen)                    // 지면점
  → group local로 역회전한 pLocal

factorX = directionX · (pLocal.x - anchor.x) / (2 · halfStart.x)
factorY = directionY · (pLocal.y - anchor.y) / (2 · halfStart.y)
```

따라서 factor 민감도는 대략 다음 두 항의 곱이다.

```text
화면 1px가 지면 몇 m인가 ÷ 시작 half가 몇 m인가
```

MapLibre의 평면 `unproject`는 카메라에서 화면점을 통과하는 광선과 `z=0` 지면의 교점을 구한다. 내부적으로 교점 인자는 다음 형태다.

```text
t = (0 - z0) / (z1 - z0)
```

높은 pitch에서 화면 상단 방향의 광선이 지면과 거의 평행해지면 `(z1-z0)`가 작아지고 `t`가 커진다. 이때 마우스 1px가 수십~수백 m가 되어 factor도 커진다. 이는 **지면 실제 크기를 편집한다는 계약에서는 정상적인 원근 결과**일 수 있지만, 유효 범위 검사 없이 사용하면 UX상 폭발로 보인다.

### 강력한 1차 판정

- `pitch=0`, `bearing`만 변경: bearing은 축을 회전시킬 뿐이다. factor 크기가 bearing에 따라 크게 달라지면 **원근 현상이 아니라 좌표/축/단위 버그**다.
- pitch를 높일수록, 특히 객체가 화면 상단에 있을수록 점진적으로 커짐: **PB-F01** 가능성이 높다.
- 드래그 시간이 길수록 기하급수적으로 커짐: **PB-F04, PB-F05, PB-F12, PB-F15**를 먼저 본다.
- 줌 또는 타일 경계를 넘는 순간 배수로 점프: **PB-F08, PB-F16, PB-F17**을 먼저 본다.

## 2. 공통 진단 로그

다른 프로젝트는 pointermove마다 다음 값을 한 줄로 남긴다. `factor` 하나만 로그로 남기면 원인을 판별할 수 없다.

```ts
{
  caseId: 'PB-F??',
  pitch, bearing, zoom, devicePixelRatio,
  pointerEventCount,
  pointerClient: { x, y },
  pointerScreen: { x, y },
  groundStart, groundNow,
  localPointer,
  handleDirection,
  anchorLocal,
  halfStart,
  numerator: localPointer.x - anchorLocal.x,
  denominator: 2 * halfStart.x,
  rawFactor,
  appliedFactor,
  cameraRevision,
  objectId,
  sourceTileId,
}
```

추가로 화면점에서 로컬 핸들 축 방향 1px을 이동한 점을 역투영하여 `groundMetersPerPixel`을 기록한다.

```ts
groundMetersPerPixel = distance(
  unproject(pointerScreen + projectedLocalAxis),
  unproject(pointerScreen),
);
```

## 3. 번호별 체크리스트

### PB-F01 — 지평선 근처 ray/ground 교차 민감도 폭증

- [ ] pitch가 높을수록 심해지는가?
- [ ] 같은 도형도 화면 중앙보다 상단에서 심해지는가?
- [ ] `groundMetersPerPixel`이 화면 상단에서 급격히 증가하는가?
- [ ] `pitch=0`에서는 정상인가?

**원인:** 카메라 광선이 지면과 거의 평행해져 작은 픽셀 변화가 큰 지면 거리로 변환된다.

**이 프로젝트 재현:** Pitch/Bearing 테스트에서 `60/90`을 선택하고 맵을 이동해 선택 도형을 화면 상단에 둔 뒤 중앙과 상단의 동일 핸들을 같은 픽셀만큼 드래그한다.

**수정 선택지:**

1. 실제 지면 크기 편집이 목적이면 `groundMetersPerPixel` 상한을 두고 민감도가 지나친 화면 영역에서는 편집을 거부하거나 안내한다.
2. 시각적 크기 편집이 목적이면 지면 거리 factor가 아니라 투영된 로컬 축의 화면 픽셀 factor를 사용한다.
3. `rawFactor`를 시작 스냅샷 기준 절대 범위로 clamp한다. 프레임별 delta clamp는 누적 폭증을 막지 못한다.

### PB-F02 — 픽셀·Mercator·미터·타일 단위 혼합

- [ ] 분자는 픽셀인데 분모는 미터인가?
- [ ] Mercator normalized 값과 world pixel 값을 직접 빼는가?
- [ ] `meterInMercatorCoordinateUnits()` 변환이 한쪽에만 적용됐는가?
- [ ] factor가 zoom/worldSize와 비슷한 배수로 틀리는가?

**원인:** 같은 식의 분자와 분모가 서로 다른 단위다.

**이 프로젝트 재현:** `pLocal` 대신 `pointerScreen`을 factor 분자에 임시 주입하거나, 미터 변환을 한쪽에서 생략하면 동일 증상을 만들 수 있다.

**수정:** factor 식에 들어오는 포인터·앵커·half를 모두 동일한 group-local 미터 또는 동일한 screen px로 통일한다.

### PB-F03 — 객체 변환 중 카메라도 함께 움직임

- [ ] 드래그 중 dragPan, bearing, pitch, zoom이 변경되는가?
- [ ] `cameraRevision`이 pointerdown 이후 바뀌는가?
- [ ] 트랙패드나 멀티터치에서만 발생하는가?

**원인:** 시작 스냅샷과 현재 포인터가 서로 다른 카메라 행렬로 역투영된다.

**이 프로젝트 재현:** `lockCameraControls()`를 임시 우회하고 객체 드래그와 맵 조작을 동시에 수행한다.

**수정:** 객체 변환 트랜잭션 동안 카메라 입력만 임시 잠그고 완료·취소 시 이전 상태를 복구한다. 외부 코드가 카메라를 바꾸면 진행 중 변환을 취소한다.

### PB-F04 — 현재 결과를 다음 프레임의 입력으로 재사용

- [ ] `halfStart`가 pointermove마다 다시 계산되는가?
- [ ] anchor를 현재 selection box에서 계속 읽는가?
- [ ] 포인터를 왕복시켜도 원래 크기·위치로 복귀하지 않는가?

**원인:** 변형 결과가 다음 계산의 분모·앵커로 들어가는 출력→입력 피드백이다.

**이 프로젝트 재현:** `halfStart` 또는 `anchorLocal`을 현재 group box에서 매 프레임 다시 계산한다.

**수정:** pointerdown에서 `snaps`, `halfStart`, `anchorLocal`, `rotStart`, frame을 한 번만 저장하고 모든 pointermove를 이 값에서 절대 계산한다.

### PB-F05 — delta factor 누적 곱셈

- [ ] `scale *= factor` 또는 `matrix = deltaMatrix * matrix`를 pointermove마다 수행하는가?
- [ ] 동일 위치에서 이벤트 수가 많을수록 더 커지는가?
- [ ] 빠른 마우스보다 느린 마우스에서 더 많이 확대되는가?

**원인:** factor가 시작 상태에 적용되지 않고 직전 결과에 반복 곱해진다.

**이 프로젝트 재현:** `snapshot.linear` 대신 현재 `shape.linear`에 factor를 반복 적용한다.

**수정:** `next = transform(snapshot, absoluteFactor)` 형태로 계산한다. 이벤트 빈도가 결과에 영향을 주면 안 된다.

### PB-F06 — bearing 상태에서 화면 X/Y를 로컬 축으로 오인

- [ ] R 핸들인데 `pointer.clientX` 또는 화면 `dx`만 사용하는가?
- [ ] bearing 또는 객체 회전각에 따라 factor가 커지거나 작아지는가?
- [ ] 로컬 한 축 핸들이 양축 factor를 동시에 바꾸는가?

**원인:** 회전된 로컬 축에 투영해야 할 포인터를 화면 고정축으로 측정한다. 축이 거의 직교하면 잘못된 작은 분모 또는 큰 보정값이 생긴다.

**이 프로젝트 재현:** group-local `pLocal.x/y` 대신 화면 `dx/dy`를 사용한다.

**수정:** 포인터를 지면에 역투영한 뒤 `-groupRotation`으로 역회전한다. 핸들 역할은 pointerdown 때 정한 `dir`을 유지한다.

### PB-F07 — 0에 가까운 시작 half/분모

- [ ] `2 * halfStart`가 0 또는 매우 작은가?
- [ ] 선, 점, 매우 얇은 도형에서만 발생하는가?
- [ ] selection box가 잠깐 0 크기가 된 직후 발생하는가?

**원인:** factor 분모가 퇴화했다.

**이 프로젝트 재현:** 폭이나 높이가 거의 0인 도형으로 edge resize를 시작한다.

**수정:** pointerdown에서 최소 half를 검증하고 퇴화 축의 핸들을 비활성화한다. 계산 결과만 clamp하기보다 분모 자체를 검증한다.

### PB-F08 — 타일 zoom/extent/worldSize 배율 중복 적용

- [ ] `2^zoom`, tileSize, extent(예: 4096)가 두 번 곱해지는가?
- [ ] 줌이 1 증가할 때 오차가 정확히 2배가 되는가?
- [ ] 타일 로컬 좌표를 전역 월드 좌표로 바꾼 뒤 다시 zoom scale을 적용하는가?

**원인:** 타일 좌표와 월드 좌표 변환 단계에서 확대율을 중복 적용한다.

**이 프로젝트 재현:** MeterFrame 결과에 임의로 `2^zoom`을 다시 곱한다.

**수정:** 편집 계산은 zoom 독립적인 canonical world/lngLat/local-meter에서만 수행하고 타일 좌표 변환은 로딩·저장 경계에서 한 번만 한다.

### PB-F09 — CSS pixel·canvas backing pixel·DPR 혼합

- [ ] `clientX/Y`와 `canvas.width/height` 좌표를 직접 섞는가?
- [ ] 고해상도 모니터에서만 1.25배, 1.5배, 2배 차이가 나는가?
- [ ] 브라우저 zoom에 따라 factor가 바뀌는가?

**원인:** CSS 픽셀과 device pixel 사이에 `devicePixelRatio`가 중복 또는 누락됐다.

**이 프로젝트 재현:** `pointerScreen`에 DPR을 한 번 더 곱한 값을 unproject에 전달한다.

**수정:** MapLibre `project/unproject`에는 컨테이너 기준 CSS 픽셀을 사용한다. 캔버스 backing 좌표 변환은 렌더러 내부에서만 한다.

### PB-F10 — Mercator 위도 스케일 또는 world-wrap 오류

- [ ] 위도에 따라 동일 객체의 factor 감도가 크게 달라지는가?
- [ ] 날짜변경선 부근에서 중심 차이가 전 세계 폭만큼 튀는가?
- [ ] 서로 다른 중심의 `meterInMercatorCoordinateUnits()`를 혼용하는가?

**원인:** Mercator 단위를 실제 미터로 환산하지 않았거나 wrap이 다른 복사본 좌표를 뺀다.

**이 프로젝트 재현:** MeterFrame의 미터 환산을 제거하거나 longitude wrap이 다른 중심을 사용한다.

**수정:** 선택 중심의 단일 로컬 MeterFrame을 사용하고 longitude/world copy를 canonical wrap으로 정규화한다.

### PB-F11 — 객체 평면과 unproject 대상 평면 불일치

- [ ] 객체가 terrain, altitude 또는 3D 평면 위에 있는데 `z=0`으로 unproject하는가?
- [ ] 건물 상단이나 경사진 지형에서만 factor가 튀는가?
- [ ] 선택 위치와 포인터 지면점이 처음부터 어긋나는가?

**원인:** 포인터 광선이 객체가 있는 평면이 아닌 다른 평면과 교차한다.

**이 프로젝트 재현:** 도형은 높이가 있는 것처럼 렌더하고 포인터는 기존 `z=0` unproject를 유지한다.

**수정:** 실제 편집 평면과 ray intersection을 수행한다. terrain 사용 시 terrain-aware point coordinate를 사용하고 실패 시 편집을 중단한다.

### PB-F12 — 부모와 자식에 같은 scale을 이중 적용

- [ ] 그룹 컨테이너와 자식 geometry/행렬 모두에 factor를 곱하는가?
- [ ] 요청 factor가 2인데 결과가 약 4처럼 보이는가?
- [ ] 렌더 transform과 저장 transform 양쪽에서 같은 행렬을 적용하는가?

**원인:** 동일 affine이 계층의 두 단계에 적용된다.

**이 프로젝트 재현:** 자식 `linear`를 갱신하면서 그룹 `<g transform="scale(...)" />`도 동시에 적용한다.

**수정:** 변환의 단일 진실 원천을 정한다. 현재 프로젝트는 자식 center와 live `linear`에만 반영하고 selection box는 결과에서 도출한다.

### PB-F13 — anchor 교차 후 `abs()`로 방향이 뒤집힘

- [ ] 핸들이 반대 anchor를 넘는 순간 작아졌다가 다시 급확대되는가?
- [ ] factor 부호를 없애기 위해 `Math.abs(pointer-anchor)`를 사용하는가?
- [ ] 의도하지 않은 미러링이 발생하는가?

**원인:** anchor를 지난 포인터가 반대편 길이로 다시 해석된다.

**이 프로젝트 재현:** `anchoredAxisScale()` 대신 거리의 절댓값으로 factor를 계산한다.

**수정:** `direction * (pointer-anchor)`의 signed span을 사용하고 최소 half에서 clamp한다. 미러링이 제품 요구일 때만 별도 모드로 허용한다.

### PB-F14 — 포인터 좌표 원점/스크롤/레이아웃 불일치

- [ ] 첫 이동에서만 크게 점프하는가?
- [ ] `clientX`, `pageX`, `offsetX`를 혼용하는가?
- [ ] 사이드 패널 열기, 스크롤, 컨테이너 이동 후에만 발생하는가?

**원인:** pointerdown과 pointermove가 서로 다른 화면 원점을 사용한다.

**이 프로젝트 재현:** 시작은 컨테이너 상대좌표, 이동은 viewport 절대좌표로 전달한다.

**수정:** 모든 이벤트를 `client - container.getBoundingClientRect()`의 동일한 CSS pixel 좌표로 변환하고 pointer capture를 사용한다.

### PB-F15 — 이벤트 핸들러 중복 등록

- [ ] 같은 native pointermove에 변환 함수가 여러 번 호출되는가?
- [ ] 모드 진입 횟수 또는 타일 레이어 수만큼 감도가 증가하는가?
- [ ] React StrictMode, 재마운트, 구독 해제 누락 후에만 발생하는가?

**원인:** 같은 delta/factor가 여러 핸들러에서 중복 적용된다.

**이 프로젝트 재현:** window pointermove listener를 두 번 등록하거나 cleanup을 제거한다.

**수정:** 구독과 해제를 대칭으로 만들고 edit session ID와 `pointerEventCount`로 한 이벤트당 적용 횟수가 1인지 검증한다.

### PB-F16 — 여러 타일에 중복된 동일 feature를 여러 객체로 편집

- [ ] 타일 경계나 world wrap에서만 그룹 크기/중심이 비정상인가?
- [ ] 같은 원본 feature ID가 selection에 여러 번 들어가는가?
- [ ] 보이는 복사본 모두에 scale이 적용되는가?

**원인:** 타일별 렌더 복사본을 서로 다른 편집 객체로 취급한다.

**이 프로젝트 재현:** 같은 geometry를 다른 ID로 중복 선택해 그룹 bounds와 적용 횟수를 비교한다.

**수정:** `sourceId + canonical featureId`로 중복 제거하고 편집 오버레이에는 원본 객체 하나만 둔다.

### PB-F17 — 편집 중 타일 교체가 스냅샷을 덮어씀

- [ ] 줌, pan 또는 타일 로딩 완료 순간 factor가 점프하는가?
- [ ] pointerdown의 snapshot 객체가 타일 store 갱신으로 교체되는가?
- [ ] 편집 도중 서버 응답 geometry가 다시 적용되는가?

**원인:** 편집 트랜잭션의 불변 시작 상태가 타일 생명주기에 종속됐다.

**이 프로젝트 재현:** 드래그 중 `initialShapes()`나 외부 source update로 현재 shape를 교체한다.

**수정:** 선택 순간 geometry를 tile store와 분리된 edit-session snapshot으로 복사한다. 완료 시 한 번 커밋하고, 그 전까지 타일 refresh는 편집 객체를 덮어쓰지 못하게 한다.

## 4. 증상별 빠른 번호 선택

| 증상 | 우선 점검 번호 |
|---|---|
| pitch가 높고 화면 상단에서만 폭증 | PB-F01, PB-F11 |
| pitch=0인데 bearing에 따라 폭증 | PB-F02, PB-F06, PB-F10 |
| 천천히 드래그할수록 더 커짐 | PB-F04, PB-F05, PB-F15 |
| 정확히 2배·4배·4096배 등 일정 배수 | PB-F02, PB-F08, PB-F09, PB-F12 |
| anchor를 넘는 순간 반대로 급확대 | PB-F13 |
| 첫 pointermove에서만 점프 | PB-F14, PB-F03 |
| zoom/tile 경계에서 점프 | PB-F08, PB-F16, PB-F17 |
| terrain/3D 객체에서만 발생 | PB-F11 |
| 작은 도형·얇은 축에서만 발생 | PB-F07 |

## 5. 다른 프로젝트가 보내야 할 재현 보고서

다음 양식을 복사해서 작성한다.

```text
의심 번호: PB-F__
지도 엔진/버전:
객체 저장 좌표: lngLat / Mercator / tile pixel / screen pixel / 기타
pitch / bearing / zoom:
객체 화면 위치: 상단 / 중앙 / 하단
핸들: L / R / T / B / corner / move / rotate
시작 half와 anchor:
rawFactor → appliedFactor:
groundMetersPerPixel:
pointermove 1회당 적용 횟수:
타일 ID / 원본 feature ID:
왕복 시 원상복귀 여부:
재현 영상 또는 로그:
```

번호와 로그가 전달되면 이 저장소에서는 해당 항목의 **이 프로젝트 재현** 절차로 먼저 같은 고장을 의도적으로 만든 뒤, 수정 전/후를 `transform-math.test.ts` 또는 Pitch/Bearing 테스트 화면에서 비교한다. 이 방식으로 다른 프로젝트를 직접 수정하기 전에 원인과 수정의 부작용을 분리 검증한다.

## 6. 현재 프로젝트의 방어 범위

현재 구현은 다음을 이미 방어한다.

- PB-F03: 객체 변환 중 카메라 입력 임시 잠금, 외부 카메라 이동 시 취소
- PB-F04/PB-F05: 드래그 시작 스냅샷 기준 절대 계산
- PB-F06: 지면 역투영 후 로컬 축으로 역회전
- PB-F07/PB-F13: 최소 half, signed span, 최대 factor clamp
- PB-F12: 자식 center + live 2×2 `linear`만 진실 원천으로 사용
- PB-F14: 컨테이너 상대 CSS pixel과 pointer capture 사용
- PB-F15: 전역 이벤트 cleanup 대칭 구성

PB-F01은 수학적으로 가능한 정상 원근 증폭이므로 제품 정책이 필요하다. 현재는 유한값 검사와 최대 factor clamp가 있지만 `groundMetersPerPixel` 기반 편집 가능 영역 판정은 아직 없다. 다른 프로젝트에서 PB-F01로 확인되면 실제 지면 크기 편집과 화면 감도 고정 중 어떤 UX가 요구되는지 먼저 정해야 한다.

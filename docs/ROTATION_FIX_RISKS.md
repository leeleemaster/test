# 회전 버그 수정 — 리스크 분석 (Rollout Risks)

> **배경**: `ROTATION_FIX_DESIGN.md`의 수정(프레임 단일화 + 절대각 + per-shape `-angle` 제거)을 적용할 때,
> "사각형만 고쳐지고 나머지가 역으로 깨지는" 함정이 있다. 제기된 **5가지 리스크**를 상세 분석한다.
> (1: arc/sector 내부 각도, 2: 틸트 guide/bbox, 3: 회전 경로 다수, **4: 저장/복원 호환성(배포 리스크)**, **5: 단일 선택 fast path 내부 분기**)
>
> 핵심 메시지: **이 수정은 "한 줄 토글"이 아니라 "계약(contract) 정리"다.** 각도가 흐르는 모든 경로·모든 도형의
> 각도 계약을 같은 정준 공간으로 옮기지 않으면, 보정 하나를 제거하는 순간 그동안 "두 번 틀려서 맞던" 것들이 드러난다.

---

## 리스크 1 — ellipse / arc / sector 계열의 "visual ↔ model 반전 계약"

### 무엇이 문제인가
사각형의 각도 quantity는 **회전(orientation) 하나뿐**이라, 전역 프레임을 한 번 바로잡으면 끝난다.
그러나 **ellipse / arc / sector는 각도 quantity가 여러 개**다:

- 도형 전체 **orientation(회전)**
- arc/sector의 **start angle**
- **sweep(end angle) 방향** (CW vs CCW)
- arc가 **볼록한 방향 / 채워지는 방향**
- ellipse **장축 각도**

이 내부 각도들은 **버그난 전역 규약(반전된 상태)에 맞춰 각각 튜닝**돼 있다.

### 왜 "역으로 깨지나"
- [ ] 전역 프레임/사각형 `-angle`만 고치면 → **사각형은 정상**, 그러나 arc/sector의 start·sweep·볼록 방향은 **여전히 옛 반전 규약**을 가정 → **반대로 그려진다.**
- [ ] 즉 보정 1개를 떼면, 그 보정에 의존하던 도형들의 **다른 각도 계약이 노출**된다. (사각형 = 보정 1개, arc = 보정 + 내부 각도 여러 개)

### 근본 통찰: 두 개의 각도를 분리하라
하나의 "angle"에 **두 개념이 섞여** 있다:
- **(a) 배치 회전(placement rotation)** — 전역 transform이 담당
- **(b) 도형 고유 각도(intrinsic geometry)** — start/sweep/축 각도, **도형 geometry 생성**이 담당

버그 보정은 이 둘을 한 부호로 뭉개놨다. 수정은 **(a)와 (b)를 분리**하고, 전역 프레임 반전이 **(b)에 새지 않게** 해야 한다.

### ⚠️ arc 와 sector 는 같은 위험이 아니다 (우선순위 주의)
- [ ] **arc(호) = 가장 위험**: map setAngle 경로가 **불규칙**하고 내부 각도(start/sweep/볼록)가 많아 반전 시 가장 크게 깨진다. **수정·검증 1순위.**
- [ ] **sector(부채꼴) = 상대적으로 덜 위험**: map setAngle이 arc보다 **정규적인 delta 회전**을 쓴다. 그래도 **angle-box 계열**이라 같은 종류의 반전 위험은 있다.
- [ ] 결론: **고치는 우선순위는 arc > sector**, 하지만 **검증은 arc·sector 같이** 한다. arc와 sector를 "동일 위험"으로 뭉뚱그리면 **구현 우선순위를 잘못 잡는다.**

### 탐지법
- [ ] 도형 타입별로 **모든 각도 quantity를 인벤토리**한다(orientation / startAngle / endAngle / sweepDir / convexDir / ellipseAxis).
- [ ] 수정 전 arc·sector·ellipse의 **골든 스크린샷**을 떠둔다(start 위치, sweep 방향, 볼록 방향).
- [ ] 수정 후 같은 케이스를 비교 — 사각형만 보지 말 것.

### 완화/순서
- [ ] 정준 규약(예: model 프레임 CCW+)을 **한 번 정의**하고, **각 내부 각도를 그 규약으로 재유도**한다(부호/offset 변환은 결정적).
- [ ] arc/sector의 start·sweep는 **도형 geometry 단계에서만** 처리하고, 전역 회전 변환이 거기 끼어들지 않게 한다.
- [ ] **원자적 적용**: 사각형 `-angle` 제거 = arc/sector 내부 각도 재유도와 **같은 커밋**. "사각형만 먼저"는 금지.
- [ ] 도형 타입별 **스냅샷/골든 테스트** 추가.

---

## 리스크 2 — map tilt에서 guide/bbox 계약을 "억지로 단일 프로젝션 함수"로 몰면 앵커가 틀어짐

### 무엇이 문제인가
map **tilt(pitch>0)** 가 들어가면 투영이 **비(非)affine(원근)** 이 된다. 그래서 선택상자/guide는 보통 **screen 공간 계약**으로 그려진다:

- 핸들이 **줌/틸트와 무관하게 화면상 고정 픽셀 크기/거리**로 앵커됨
- bbox가 **screen 축 정렬(AABB)** 로 계산됨 (world 축이 아니라)
- 히트테스트가 이 screen-bbox에 의존

여기서 "단일 프로젝션 함수로 통일"을 **잘못 해석**해 손으로 만든 affine local→screen 행렬로 몰면 → **틸트에서 원근이 무시**되어 선택상자 위치·앵커가 다시 틀어진다.

### 왜 깨지나
- [ ] world-space로 계산한 bbox를 틸트 화면에 투영하면 **screen 축 정렬 사각형이 아니다**(사다리꼴). 기존 코드가 screen-AABB를 전제하면 앵커/히트박스가 어긋난다.
- [ ] 픽셀 고정 핸들 오프셋을 world 단위로 바꾸면 줌/틸트에서 핸들이 떠다닌다.

### 핵심 구분: "각도/좌표 계약" vs "guide 레이아웃"
- **(A) 각도·좌표 계약** — **반드시 단일화**(증상 ①②의 원인). 
- **(B) guide 레이아웃(픽셀 고정 핸들, screen-AABB)** — **정당한 별개 관심사. 유지하라.**

"통일"은 **(A)만** 해당된다. **(B)를 없애는 게 아니다.**

### 올바른 방향
- [ ] 각도/좌표 **계약만** 정준 model 상태로 단일화하고, guide 레이아웃은 그대로 두되 **매 repaint마다 그 model 상태에서 파생**시킨다.
- [ ] 틸트에서는 각 guide 정점을 **실제 원근 투영(`map.project`)** 으로 화면에 올린 뒤, **그 투영점들로 screen-AABB**를 만든다. affine 가정 금지.
- [ ] 픽셀 고정 핸들 오프셋(회전 핸들 N px 등)은 **투영 이후 screen 후처리**로 적용.

### 레퍼런스가 안전한 이유 (주의해서 인용)
- [ ] `map-aabb`의 `projectLocalPoint`는 local→world mercator→lngLat→**`map.project()`** 로 끝난다. `map.project`가 **틸트/원근을 정확히 처리**한다. → **`map.project`로 끝나는 함수로 통일하면 틸트 안전**.
- [ ] **위험한 통일**: 손으로 만든 affine local→screen 행렬(`map.project` 우회). 이건 틸트에서 깨진다. ← 그쪽이 우려하는 바로 그 케이스.

### 탐지법
- [ ] **pitch>0** 에서 회전/이동: 핸들 앵커 유지, bbox가 도형을 감싸는지, 회전 핸들의 화면 오프셋이 맞는지.
- [ ] 고줌 + 고틸트 동시 케이스 별도 점검.

---

## 리스크 3 — 회전 경로가 여러 개 공존 (group / single fallback / legacy)

### 무엇이 문제인가
회전 진입점이 하나가 아니다:

- **explicit group local rotation** (지금 고치는 "좋은" 경로)
- **local rotate fallback** (단일 선택 등)
- **legacy rotate strategy**

각 경로가 **독립적으로 각도를 측정/적용**한다. **그룹 경로만 고치면** 단일 선택·legacy 경로에 **다른 각도 계약이 남는다.**

### 왜 깨지나
- [ ] 그룹 회전은 정상이 됐는데 **단일 선택 회전은 여전히 반전/누적** → 사용자 입장에선 "어떤 땐 맞고 어떤 땐 틀림"으로 더 헷갈림.
- [ ] legacy 경로가 다른 normalize/부호를 쓰면 그 경로에서만 증상 ②가 재발.

### 완화/순서
- [ ] **모든 회전 경로를 grep으로 인벤토리**: `rotate`, `rotation`, `setAngle`, `applyRotation`, `angle`, `pivot` 등.
- [ ] **단일 진입 함수로 수렴**: `applyRotation(targetModelAngle, pivot)` 하나를 group/single/legacy가 **모두 호출**하게. legacy/fallback은 얇은 wrapper로.
- [ ] 모두 **같은 정준 각도 공간 + 같은 경계 변환 + 같은 갱신 전략(절대각/최단호)** 을 쓰게.
- [ ] 한 번에 통합 못 하면, 미수정 경로에 **계약 불일치 경고 로그/assert**를 박아 드러나게.
- [ ] 통합 후 **legacy 경로 제거**는 맨 마지막(파리티 테스트 통과 후).

---

## 리스크 4 — 저장/복원 호환성 (배포 리스크 ‼️ 문서에서 빠져 있던 항목)

### 무엇이 문제인가
- 현재 **serialize**는 **visual rotation 계열 값**을 저장한다.
- **deserialize**는 그 값을 다시 **`setAngle`로 복원**한다.
- → **정준 각도 공간을 바꾸면, 이미 저장된 기존 데이터가 "다른 방향"으로 열린다.**

### 왜 특히 위험한가 (코드가 아니라 데이터다)
- [ ] 새 도형 테스트는 다 통과해도, **사용자가 예전에 저장해 둔 파일/문서**는 업데이트 후 **조용히 반대로 열린다.** 신규 케이스 테스트로는 절대 못 잡는다.
- [ ] 배포되면 되돌리기 어렵다: 사람들이 **새 규약으로 다시 저장**하기 시작하면 옛/새 데이터가 섞여 마이그레이션이 더 복잡해진다.

### 완화/순서
- [ ] 직렬화 포맷에 **스키마 버전**을 넣는다(`version` 필드).
- [ ] deserialize에서 **버전 감지 → 구버전이면 1회성 마이그레이션**: 옛 visual-angle → 새 정준-angle (부호/offset은 결정적). 신규 저장은 새 버전으로 기록.
- [ ] 마이그레이션은 **도형 타입별**로(리스크 1과 연결: arc/sector 내부 각도도 함께 변환).
- [ ] 마이그레이션 로직은 **한 함수에 모은다**(분산 금지).

### 탐지법
- [ ] **수정 전에 저장한 골든 파일**(각 도형 타입 포함)을 수정 후 로드 → **수정 전과 동일하게 렌더되는지** 라운드트립 비교.
- [ ] 옛/새 도형이 섞인 파일(부분 저장)도 점검.

---

## 리스크 5 — 단일 선택 회전 "fast path" 내부 분기 (리스크 3의 심화)

### 무엇이 문제인가
문서는 회전 경로를 group / single / legacy로 나눴지만, **실제 "single(단일 선택)" 안에도** 별도 분기가 더 있다:

- [ ] **rectangle screen branch**
- [ ] **polygon bounds contract branch**
- [ ] **ellipse map-tilted 예외**

즉 "single"은 **단일 덩어리가 아니다.** 그룹을 고쳐도 **단일 선택은 여전히 반대로 도는 상황이 충분히 나온다.**

### 왜 추적이 더 어렵나
- [ ] 경로 수가 **문서 표현(group/single/legacy 3개)보다 실제로 더 많다** → 적용 범위(scope) 추적이 그만큼 어렵다.
- [ ] **fast path 최적화**가 정준 `applyRotation`을 **우회**할 수 있다("빠르게" = "변환 건너뛰기"가 되면 계약이 깨진다).

### 완화/순서
- [ ] 단일 회전의 **하위 분기까지 인벤토리**: rectangle-screen / polygon-bounds / ellipse-map-tilted.
- [ ] 이들 전부를 **같은 정준 변환(screenAngleToModel/modelAngleToRender) + 같은 갱신 전략**으로 라우팅. fast path도 **각도 계약은 보존**(최적화가 변환을 건너뛰면 안 됨).
- [ ] 리스크 3의 **런타임 체크포인트**(렌더 직전 "누가 각도를 세팅했나" 로그)로 **숨은 단일 분기를 스스로 드러나게**.
- [ ] 검증 매트릭스에 **single × {rectangle, polygon, ellipse} × {screen, map-flat, map-tilt}** 를 반드시 포함.

---

## 안전한 적용 순서 (다섯 리스크를 동시에 피하는 롤아웃)

1. [ ] **인벤토리(행동 변경 0)**: ① 도형별 모든 각도 quantity, ② 모든 회전 경로(**단일 내부 분기 포함**: rectangle-screen/polygon-bounds/ellipse-tilted), ③ 파이프라인의 모든 Y 반사 지점, ④ **직렬화 포맷이 저장하는 각도 값**.
2. [ ] **저장 골든 파일 확보**(수정 전 각 도형 타입 저장) + **파리티 하네스/골든 스냅샷**: `(도형타입 × 회전경로 × 모드{screen, map-flat, map-tilt})` 전 조합.
3. [ ] **직렬화 버전 + 마이그레이션 함수** 먼저 마련(리스크 4). 신규 저장은 새 버전, 로드는 구버전 1회 변환.
4. [ ] **정준 변환 도입 + 경로 1개만 라우팅**, 나머지는 그대로 두고 파리티 비교. 런타임 체크포인트로 숨은 경로 추적.
5. [ ] **나머지 경로(단일 내부 분기 포함)를 하나씩 이관**, 매번 하네스 + **저장 라운드트립** 재실행.
6. [ ] **arc → sector 순으로 내부 각도 재유도**를 해당 도형의 `-angle` 제거와 **같은 커밋**에서.
7. [ ] 전부 green일 때만 **legacy/보정 코드 삭제**.

> 한 줄 요약: **"사각형만 먼저"는 함정.** 각도가 흐르는 *모든 경로(단일 내부 분기 포함)* 와 *모든 도형의 모든 각도 quantity* 를 같은 정준 공간으로 옮기되, **guide 레이아웃(screen 픽셀 고정·screen-AABB·`map.project` 원근)** 은 그대로 두고, **기존 저장 데이터는 버전 마이그레이션으로 흡수**한다.

---

## 검증 매트릭스 (리스크 반영 확장판)

| 도형 | 모드 | 경로 | 확인 항목 |
|---|---|---|---|
| rectangle | screen / map-flat / map-tilt | group / **single(screen branch)** / legacy | 시계방향=시계방향, 경계서 안 튐 |
| polygon | map-flat / map-tilt | **single(bounds contract branch)** | 회전 방향·경계 정상 |
| ellipse | map-flat / **map-tilt(예외 분기)** | group / single | 장축 각도·회전 방향 정상 |
| **arc(1순위)** | map-flat / map-tilt | group / single | **start 위치·sweep 방향·볼록 방향** 정상 |
| **sector(arc와 같이 검증)** | map-flat / map-tilt | group / single | start·sweep 정상 (arc보단 덜 위험하나 angle-box) |
| 전 도형 | map-**tilt** | — | 선택상자 앵커 고정, bbox가 도형 감쌈, 핸들 픽셀 오프셋 유지 |
| 전 도형 | 전 모드 | 전 경로 | 같은 입력 → 같은 각도(경로 간 일치) |
| **저장 골든 파일** | — | 로드/복원 | **수정 전과 동일 방향으로 열림**(라운드트립) |

---

## 관련 문서
- `ROTATION_FIX_DESIGN.md` — 수정 설계(근본 원인·아키텍처·Step·검증)
- `SELECTION_BOX_CHECKLIST.md` — 질문지 + 규약 체크리스트 + 재현 데모
- 재현 토글: `map-aabb/src/app/app.tsx`의 `REPRODUCE_GROUP_PROJECT_BUGS`

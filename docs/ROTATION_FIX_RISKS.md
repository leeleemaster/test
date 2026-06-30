# 회전 버그 수정 — 리스크 분석 (Rollout Risks)

> **배경**: `ROTATION_FIX_DESIGN.md`의 수정(프레임 단일화 + 절대각 + per-shape `-angle` 제거)을 적용할 때,
> "사각형만 고쳐지고 나머지가 역으로 깨지는" 함정이 있다. 그쪽에서 제기한 3가지 리스크를 상세 분석한다.
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

## 안전한 적용 순서 (세 리스크를 동시에 피하는 롤아웃)

1. [ ] **인벤토리(행동 변경 0)**: ① 도형별 모든 각도 quantity, ② 모든 회전 경로, ③ 파이프라인의 모든 Y 반사 지점.
2. [ ] **파리티 하네스/골든 스냅샷** 구축: `(도형타입 × 회전경로 × 모드{screen, map-flat, map-tilt})` 전 조합.
3. [ ] **정준 변환 도입 + 경로 1개만 라우팅**, 나머지는 그대로 두고 파리티 비교.
4. [ ] **나머지 경로를 하나씩 이관**, 매번 하네스 재실행.
5. [ ] **arc/sector 내부 각도 재유도**를 해당 도형의 `-angle` 제거와 **같은 커밋**에서.
6. [ ] 전부 green일 때만 **legacy/보정 코드 삭제**.

> 한 줄 요약: **"사각형만 먼저"는 함정.** 각도가 흐르는 *모든 경로*와 *모든 도형의 모든 각도 quantity*를 같은 정준 공간으로 옮기되, **guide 레이아웃(screen 픽셀 고정·screen-AABB·`map.project` 원근)** 은 건드리지 말고 그대로 model 상태에서 파생시킨다.

---

## 검증 매트릭스 (리스크 반영 확장판)

| 도형 | 모드 | 경로 | 확인 항목 |
|---|---|---|---|
| rectangle | screen / map-flat / map-tilt | group / single / legacy | 시계방향=시계방향, 경계서 안 튐 |
| ellipse | map-flat / map-tilt | group / single | 장축 각도·회전 방향 정상 |
| arc / sector | map-flat / map-tilt | group / single | **start 위치·sweep 방향·볼록 방향** 정상 |
| 전 도형 | map-**tilt** | — | 선택상자 앵커 고정, bbox가 도형 감쌈, 핸들 픽셀 오프셋 유지 |
| 전 도형 | 전 모드 | 전 경로 | 같은 입력 → 같은 각도(경로 간 일치) |

---

## 관련 문서
- `ROTATION_FIX_DESIGN.md` — 수정 설계(근본 원인·아키텍처·Step·검증)
- `SELECTION_BOX_CHECKLIST.md` — 질문지 + 규약 체크리스트 + 재현 데모
- 재현 토글: `map-aabb/src/app/app.tsx`의 `REPRODUCE_GROUP_PROJECT_BUGS`

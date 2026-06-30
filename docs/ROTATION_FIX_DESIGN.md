# 회전 버그 수정 설계 (Fix Design)

> **대상**: 그룹 도형 프로젝트에서 보고된 두 증상
> - ① 사각형 map 모드에서 angle을 반대로 줘야 맞음 (회전 방향 반전)
> - ② 회전 핸들을 일정 이상 돌리면 반대로 튐 (경계서 wrap/flip)
>
> **이 문서**: 두 증상을 하나의 근본 원인으로 묶어 분석하고, 고치는 **순서·방법·검증**까지 정리한다.
> 레퍼런스 구현은 `map-aabb`(이 저장소), 핵심은 `map-aabb/src/app/app.tsx`. 재현 데모는 `REPRODUCE_GROUP_PROJECT_BUGS` 플래그.
> 관련 문서: `SELECTION_BOX_CHECKLIST.md`(질문지 + 규약 체크리스트).

---

## 1. 근본 원인 — 두 증상은 한 뿌리

그쪽 구조 요약: **screen-guide에서 각도 측정 → per-shape map 보정으로 적용**, 일부 경로는 delta 누적.

깨진 핵심 불변식:

> **각도는 "측정하는 프레임"과 "적용/렌더하는 프레임"이 같아야 한다 (= Y 반사 횟수가 같아야 한다).**

- [ ] **증상 ①(부호 반전)**: 측정은 **screen(Y↓)**, 적용/렌더는 **map/world**. 둘 사이 Y 반사가 **홀수 번** 남아 회전이 뒤집힌다. 수학적으로 `F · R(θ) · F⁻¹ = R(−θ)` (반사가 회전 부호를 뒤집음). 그래서 rectangle·ellipse/arc마다 `-angle`을 박아 **개별 보정**하게 됐고, 보정이 도형마다 갈리니 또 다른 버그의 씨앗이 된다.
- [ ] **증상 ②(경계서 반대로)**: `atan2`의 ±180° seam + **delta 누적 + 단순 `%360`**. 경계 통과 시 delta가 ∓360°로 튀는데 단순 모듈로가 못 흡수 → 반대로 꺾인다.

→ **"프레임 단일화"** 하나가 ①을 없애고, **"각도 갱신 방식 정리"** 하나가 ②를 없앤다. per-shape 보정은 ①의 증상일 뿐이라 자동 소멸한다.

---

## 2. 목표 아키텍처 — 하나의 정준(canonical) 각도 공간

```
[screen pointer] --(boundary A: 1회 변환)--> [model angle θ] --(boundary B: 1회 변환)--> [render]
                     screenAngleToModel()                          modelAngleToRender()
```

규칙 3개:

- [ ] **정준 model angle을 하나로 고정** (예: 로컬 Y-up 기준 CCW+). 모든 도형이 **이 값 하나**만 본다.
- [ ] **경계 변환은 각 1번, 도형 무관(shape-independent)**. `screenAngleToModel`/`modelAngleToRender` 안에서 Y 반사를 **딱 한 번씩** 처리. → 어디에도 `-angle` per-shape 분기 없음.
- [ ] **회전 갱신은 절대각 set**(또는 최단호 delta). 단순 `%360` 금지.

> 레퍼런스(`map-aabb`)가 이미 이 형태다: 측정·guide·렌더 모두 **로컬 미터 단일 프레임** → 보정 0개. (재현 플래그 `false` 분기가 바로 이 모습)

---

## 3. 구체 수정 — 우선순위 순서

### Step 0. 계측부터 (반사 홀짝 세기)

- [ ] 한 번의 회전 드래그에서 rectangle·ellipse 각각 `(screenAngle, modelAngle, renderedAngle)`을 로그로 찍는다.
- [ ] 측정→저장→적용→렌더 파이프라인의 Y 부호 반전(`-y`, `scale(...,-s,...)`, `scaleY(-1)`, CSS `transform: scaleY(-1)`)을 **전부 센다**.
- [ ] **짝수 = 정상 / 홀수 = 반전.** 도형별로 홀짝이 다르면 그게 per-shape `-angle`이 생긴 자리다.

### Step 1. 경계 변환 함수 2개 정의 (도형 무관)

- [ ] `screenAngleToModel(aScreen)`: 화면 Y↓ → model 반사를 **여기서 1번만**.
- [ ] `modelAngleToRender(aModel)`: model → 렌더(map/world) 반사를 **여기서 1번만**.
- [ ] 지금 도형마다 흩어진 반사 처리를 **이 두 함수로 흡수**한다.

### Step 2. 모든 도형을 위 함수로 통일 + per-shape `-angle` 전부 제거 (⚠️ Step 1과 원자적으로)

- [ ] rectangle의 "screen 아니면 부호 반전", ellipse/arc의 visual↔model 반전 경로를 **삭제**.
- [ ] **주의**: 보정 코드만 먼저 지우면 그동안 "두 번 틀려서 맞던" 도형이 반대로 보인다. 반드시 **경계 변환 도입과 같은 커밋**에서 빼고, 도형 타입별로 즉시 육안 검증.

### Step 3. 회전 갱신 방식 정리 (증상 ②)

- [ ] **그룹 회전(절대각 set)** 과 **로컬 회전(delta 누적)** 의 두 경로를 **하나로 통일** → 절대각 set 권장.
- [ ] delta가 꼭 필요하면(키보드 nudge 등) **최단호 delta**로: `θ += normalizeDeg(cur − prev); prev = cur;` (`normalizeDeg` = 이중 모듈로 `((v+180)%360+360)%360−180`).
- [ ] 저장값은 정규화하되 **단순 `%360` 제거**. 렌더는 `degToRad(θ)`라 ±180 밖 값이어도 무방 → 정규화는 저장/표시용으로만.

### Step 4. 피벗을 정준 프레임에서 (이미 거의 맞음)

- [ ] 그룹 중심(selectionframe center) 피벗 **유지**.
- [ ] 피벗 좌표를 **정준 프레임(world/mercator)** 으로 표현하고, 자식 회전을 **단일 forward 변환**으로 그룹 중심 기준 회전. 자식별 누적 금지.

### Step 5. guide ↔ shape 변환 단일화

- [ ] 선택상자(guide/bbox)와 실제 도형이 **같은 projection 함수** 하나를 공유. (레퍼런스의 `projectLocalPoint` 격)
- [ ] 성능상 screen-space guide가 필요하면 **매 repaint마다 model 상태에서 파생**해서 그린다. guide를 독립적으로 screen에서 따로 계산 금지 → "부분 동기화"가 어긋나는 지점.

### Step 6. snapshot 이동과 회전 프레임 정합

- [ ] 드래그 중엔 snapshot로 빠르게 그리되, **pointer-up에서 정준 파이프라인으로 reproject 해 commit**(center를 world 좌표로 재확정).
- [ ] 이동 기준점과 회전 피벗이 **같은 좌표를 공유**하도록. (snapshot=screen, 회전=model이면 이동 후 회전에서 desync)

---

## 4. 검증 매트릭스 (반드시 통과)

| 케이스 | 기대 |
|---|---|
| rectangle, **map 모드**, 시계방향 드래그 | 도형도 **시계방향**(반대 아님), `-angle` 없이 |
| rectangle, **screen 모드**, 시계방향 | 동일하게 시계방향 (두 모드 결과 일치) |
| ellipse/arc, map 모드 회전 | visual·model 어긋남 없음 |
| 회전 핸들 **±180° 경계 통과** | 반대로 안 튐, 포인터 연속 추종 |
| 이동 후 회전 | 그룹 중심 기준 정상, 점프 없음 |
| guide bbox vs 실제 도형 | **모든 각도**에서 겹침 |

---

## 5. 가장 중요한 한 가지

> **`-angle`을 추가하지 말고 제거하라.** 그건 반사 1번을 각도에서 땜질한 흔적이다.
> Y 반사는 **경계 변환 2곳에서 각 1번씩, 도형 무관**으로 처리하고, 회전은 **절대각 set + 이중 모듈로 정규화**로 통일하면, 두 증상이 동시에 사라진다.

---

## 6. 레퍼런스 코드와의 매핑

| 수정 항목 | 레퍼런스(`map-aabb/src/app/app.tsx`) | 비고 |
|---|---|---|
| 정준 프레임에서 각도 측정 | `getPointerLocalMeters` (Y 반전 1회) | 측정 프레임 고정 |
| 절대각 set | 회전 핸들러 `updateShapeState({ rotationZ: normalizeDegrees(rawAngleDeg) })` | delta 누적 아님 |
| 이중 모듈로 정규화 | `normalizeDegrees` (`((v+180)%360+360)%360-180`) | 단순 `%360` 금지 |
| 렌더 반사 1회 | `customLayer.render`의 `scale(s, -s, s)` | Y 반사 1곳 |
| guide·shape 동일 변환 | `projectLocalPoint` 공유 | 오버레이=메쉬 |
| 버그 재현/정상 토글 | `REPRODUCE_GROUP_PROJECT_BUGS` | `false` 분기 = 최종 수정 형태 |

> 그쪽 프로젝트의 최종 수정 = 레퍼런스에서 **재현 플래그를 끈 회전 핸들러**(절대각 + `normalizeDegrees`, 반전·누적 없음)를 그대로 옮긴 것과 같다.

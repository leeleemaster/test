# 회전 버그 수정 — 구현 실행 지침 (Implementation Worksheet)

> `ROTATION_FIX_PROPOSAL.md`(설계안)의 실행 편. 설계를 **실제 코드 작업으로 옮길 때 쓰는 기준표·전수목록·어댑터 설계·분리 확인·마이그레이션 공식** 5종.
> 그쪽 프로젝트 코드는 여기서 직접 볼 수 없으므로, **빈칸(→ 조사 후 기입)이 있는 워크시트** 형태다. 빈칸은 그쪽 코드 audit(런타임 체크포인트 로그 + grep)으로 채운다.

---

## 1. 도형별 `-angle` 분류 기준표 — (a) 프레임 보정 vs (b) 도형 고유 의미

> §8-1 원칙: **(a)만 제거**(경계 변환으로 흡수), **(b)는 보존**(geometry 레이어로 명시 이동). 일괄 제거 금지.

### 판정 테스트 4가지 (순서대로 적용)

| 테스트 | 방법 | (a) 프레임 보정 신호 | (b) 고유 의미 신호 |
|---|---|---|---|
| **T1 위치** | 그 `-`가 어디에 있나 | **모드 분기 안** (`mapMode ? … : …`, `isScreen`) | **geometry 생성 코드 안** (path/arc 명령, sweep 계산, 축 계산) |
| **T2 제거 실험** | 임시 제거 후 회전 핸들만 드래그 | **회전 방향만** 반대가 됨 (모양 불변) | **모양 자체**가 바뀜 (벌어지는 방향·볼록/오목·축 방향) |
| **T3 반사 홀짝** | 그 지점 앞뒤 파이프라인의 Y 반사 수 세기 | 홀수를 짝수로 만드는 역할 (보정) | 반사 수와 무관하게 존재 |
| **T4 직렬화** | 그 부호가 저장값에 반영되나 | — | — (분류와 무관하게, **반영되면 5장 마이그레이션 대상에 등록**) |

**판정 규칙**: T1·T2·T3 중 2개 이상이 (a)를 가리키면 (a)로 처리. 애매하면 **(b)로 두고 보존**(제거는 되돌리기 어렵다) 후 재심사.

### 처리 방법 — (a)는 두 하위 케이스로 나뉜다 (⚠️ 정적분석 반영)

> **(a) 판정 = 무조건 삭제가 아니다.** 그 `-`가 파이프라인에서 **유일한 프레임 변환**인지, **중복 보정**인지에 따라 처방이 정반대다.
> 구분 방법: **그 `-` 없이** 측정→렌더 파이프라인의 Y 반사를 센다. **홀수면 (a-2)** (그 `-`가 필요한 변환), **짝수면 (a-1)** (중복).

- **(a-1) 중복 보정** (파이프라인에 변환이 이미 있는데 또 뒤집음) → 삭제. 경계 변환이 부호를 담당하는지 확인. **같은 커밋**에서.
- **(a-2) 필요한 변환이 익명 인라인으로 존재** (두 프레임을 잇는 **유일한** 다리) → **삭제 금지. 승격(promotion)**: 부호는 그대로 두고, 이름 있는 경계 변환 함수로 **위치만 옮기는 동작 보존 리팩터**. 저장값·렌더 결과 불변이어야 함(골든으로 검증).
- **(b) 판정** → 삭제 금지. geometry 레이어로 옮기고 **이름을 의미로** 바꾼다 (예: `-angle` → `sweepSign * angle`, `axisFlip`).

### 알려진 의심 지점 사전 분류 (그쪽 답변 기반 — audit으로 확정할 것)

| 위치 | 예상 분류 | 근거 | 확정(기입) |
|---|---|---|---|
| rectangle.ts map-mode 부호 반전 (`screen이 아니면 부호 뒤집음`) | **(a-2)** 유력 — **삭제 금지, 승격 대상** | **정적분석 결과**: mercator **Y-up delta 누적 프레임** ↔ **screen Y-down geometry bake 프레임**을 잇는 **필요한 변환**일 가능성 높음. 지금 지우면 새 버그. 홀짝 카운트로 확정 후 승격 | ◐ 정적분석 완료, 홀짝 확인 대기 |
| ellipse visual↔model 반전 경로 | **(a)+(b) 혼재** 가능 | placement 반전은 (a), 장축 각도는 (b) | ☐ |
| arc start/sweep 부호 | **(b)** 우선 의심 | geometry 의미 (벌어지는 방향) | ☐ |
| sector delta 부호 (정규 delta 계약) | **(b)** 확인 필요 | delta 계약 자체가 방향 의미 포함 | ☐ |
| ellipse map-tilted 예외 분기 내 부호 | 미상 | T1~T3 적용 | ☐ |

---

## 2. 커밋/읽기 함수 전수 목록 (인벤토리 템플릿)

> §8-5·§9-1 원칙: **모든 commit(쓰기) 경로 + 읽기/계산 경로**가 같은 계약을 써야 한다. 아래 표를 grep + 런타임 체크포인트 로그로 완성한다.

### grep 시작 패턴
```
setAngle | applyScreenRotation | applyRotation | rotate\( | setPosition(s)? | commitTransform | bake | restoreTransform | deserialize
```

### 쓰기(commit) 경로 표 — 알려진 4개 선기입

| 함수 | 트리거 경로 | 입력 각도 프레임 (screen/visual/model) | 정준 계약 통과? | 마이그레이션 관련? | 상태 |
|---|---|---|---|---|---|
| `setAngle` | interactive + programmatic + **deserialize 복원** | (기입) | ☐ | **예 — visual 값 저장/복원 (5장)** | 미조사 |
| `setPosition` | 이동 commit | (각도 아님 — 피벗 좌표 정합만 확인) | ☐ | ☐ | 미조사 |
| `setPositions` | 다중/그룹 이동 commit | (각도 아님 — 자식 baking 여부 확인, §8-3) | ☐ | ☐ | 미조사 |
| `applyScreenRotationDegrees` | screen guide 회전 드래그 | **screen** (이름상 확실) → model 변환 필요 | ☐ | ☐ | 미조사 |
| (기입) undo/redo 복원 | history restore | (기입) | ☐ | ☐ | 미조사 |
| (기입) snapping/align commit | 스냅 확정 | (기입) | ☐ | ☐ | 미조사 |
| (기입) group/ungroup 시 bake | 그룹 해제 | (기입) | ☐ | ☐ | 미조사 |
| (기입) copy/paste·mirror | 복제/반전 | (기입) | ☐ | ☐ | 미조사 |

### 읽기(compute) 경로 표 — §9-1: 쓰기만 고치면 안 됨

| 계산 | 함수(기입) | 읽는 각도 프레임 | 같은 계약? | 상태 |
|---|---|---|---|---|
| guide 위치/각도 계산 | (기입) | (기입) | ☐ | 미조사 |
| bbox(selection frame) 계산 | (기입) | (기입) | ☐ | 미조사 |
| group angle 계산 | (기입) | (기입) | ☐ | 미조사 |
| 히트테스트(핸들 잡기) | (기입) | (기입) | ☐ | 미조사 |
| 직렬화 시 각도 읽기 | (기입) | (기입) | ☐ | 미조사 |

**완료 기준**: 두 표의 모든 행이 "같은 계약 ✅" 상태. 런타임 체크포인트에 **표에 없는 호출자**가 찍히면 행 추가.

---

## 3. arc/sector 역델타 계약 ↔ 정준 절대각 어댑터 설계

> 배경: arc는 **불규칙한 map setAngle**, sector는 **정규적인 delta 회전** 계약. 정준 공간은 **절대각**. 기존 호출부를 다 뜯지 않고 **경계에서 어댑터로** 잇는다. (§9-2: 함수 통합이 아니라 규칙 통합 — 어댑터가 그 "규칙"을 구현)

### 인터페이스 (도형 무관, 인스턴스 상수만 다름)

```
// 정준 저장값: placementAngle (model frame, 절대각, 이중 모듈로 정규화)
// delta 계약 경로가 주는 값: deltaContract (그쪽 부호/프레임 관례 그대로)

adapter = { s_d: ±1, phi: offsetDeg }   // 도형·경로별 상수 (1장 분류표 + 골든 비교로 확정)

// [쓰기] delta 계약 → 정준 절대각
applyDeltaContract(shape, deltaContract):
  deltaModel = normalizeDeg(adapter.s_d * deltaContract)     // 역델타면 s_d = -1이 흡수. 정준값에 -를 박지 말 것
  shape.draftTotal += deltaModel                              // 드래그 중 임시 누적
  shape.placementAngle = normalizeDeg(shape.baseAngle + shape.draftTotal)

// [commit] pointer-up / 확정 시
commitRotation(shape):
  shape.baseAngle = shape.placementAngle                      // base + total로 재계산 (증분 baking 금지, §8-3 orbit drift 방지)
  shape.draftTotal = 0

// [읽기] 정준 절대각 → delta 계약 (기존 소비자가 delta를 기대할 때)
toDeltaContract(prevAngle, nextAngle):
  return adapter.s_d * normalizeDeg(nextAngle - prevAngle)    // 최단호
```

### 불변식 (어댑터 테스트로 강제)
- [ ] **placement만** 다룬다 — arc `start/sweep`, sector 내부 각도는 **통과(불변)**. (§9-3)
- [ ] 라운드트립: `toDeltaContract(a, applyDeltaContract(a, d)) ≈ d` (ε 이내).
- [ ] 누적은 draft 동안만, commit은 `base + total` 재계산 — 프레임마다 자식/도형에 증분 mutate 금지.
- [ ] `normalizeDeg`는 이중 모듈로. ±180° 경계 통과 시 연속(점프 없음).
- [ ] **역델타를 정준값의 부호 반전으로 "고치지" 않는다** — 반전은 어댑터 상수 `s_d`가 흡수. 정준 공간은 항상 한 방향(CCW+).
- [ ] arc 어댑터와 sector 어댑터는 **상수(s_d, phi)만 다르고 코드는 동일** — 다르게 구현되기 시작하면 계약이 갈라진 것.

---

## 4. guide 렌더 순서·가시성 로직과 각도 계약의 분리 확인

> §8-4 취지의 검증 절차화: 계약(각도/좌표)과 guide 레이아웃/표시는 **서로 다른 관심사**다. 계약 수정이 guide 표시 코드에 번지면 분리 실패.

### 분리 확인 체크리스트
- [ ] **가시성 조건**(핸들 show/hide, hover, 선택 상태)이 **각도 값을 직접 읽지 않는가?** 읽고 있다면(예: `angle > 90 ? hide : show`) 그 지점은 계약 의존 → 분리하거나 정준값 기준으로 명시 전환.
- [ ] **렌더 순서(z-order)** 가 각도·프레임·모드와 무관하게 결정되는가? (선택상자 > 핸들 > 도형 같은 고정 레이어링)
- [ ] **히트테스트 레이어 순서**가 계약 변경 전후 동일한가?
- [ ] 계약 수정 커밋에서 guide 렌더 순서/가시성 코드의 diff가 **0줄**인가? (0줄이면 분리 성공의 실증. 0줄이 아니면 그 줄이 바로 숨은 결합점)
- [ ] 반대 방향도: guide 레이아웃 리팩터가 각도 계약 코드(경계 변환·어댑터)를 건드리지 않는가?
- [ ] tilted guide의 screen 기반 레이아웃 패스(픽셀 고정 핸들·screen-AABB)가 **그대로 남아 있는가?** (§8-4 — 계약 수정이 이를 지우면 안 됨)

### 실증 테스트 (재현 토글 방식 활용)
- [ ] 계약 스위치를 켠/끈 두 상태에서 guide의 **표시 여부·개수·순서가 동일**한지 비교. **달라도 되는 것은 위치·방향뿐**이다. 표시/순서가 달라지면 가시성 로직이 계약에 결합돼 있다는 증거.

---

## 5. 도형별 마이그레이션 매핑 공식 (직렬화 v1 → v2)

> 리스크 0순위(저장/복원). 구버전(v1)은 **visual rotation 계열 값**을 저장. 신버전(v2)은 **정준 model 절대각 + 도형 고유값 보존**.
> 공통 골격: `model = normalizeDeg(s · stored + φ)` — **s(±1)·φ(offset)는 코드 추론이 아니라 "수정 전 골든 파일과 렌더 비교"로 확정**한다. 공식은 틀, 상수는 검증으로.

### 공통 규칙
- [ ] 파일에 `version` 없음 → v1로 간주. 로드 시 1회 변환, 저장은 항상 v2로만.
- [ ] 마이그레이션 함수는 **한 곳에** 모은다: `migrateShapeV1toV2(shape)` 내부에서 도형 타입 분기.
- [ ] 각 도형 타입마다 **골든 파일 라운드트립**: v1 파일 로드 → 화면이 수정 전과 동일 → 저장(v2) → 재로드 동일.

### 도형별 공식

| 도형 | placement 변환 | 고유(intrinsic) 값 변환 | 주의 |
|---|---|---|---|
| **rectangle** | `model = normalizeDeg(s_rect · stored + φ_rect)` | 없음 (크기·정점 불변) | ⚠️ rectangle `-angle`이 **(a-2) 승격**으로 확정되면 동작 보존 리팩터라 저장값 불변 → `s_rect = +1` 유력. (1장 분류 결과가 이 상수를 결정 — 골든 비교로 최종 확정) |
| **polygon** | placement 공식 동일 | 정점은 좌표라 불변 | **bounds contract 분기가 파생 각도를 저장했다면** 그 필드도 대상 (2장 표에서 확인) |
| **ellipse** | placement 공식 동일 (`s_ell`) | `axis_new = normalizeDeg(s_axis · axis_old + φ_axis)` | placement와 axis의 **s가 다를 수 있음** — 따로 확정 |
| **arc** | placement 공식 동일 (`s_arc_p`) | `start_new = normalizeDeg(s_arc · start_old + φ_arc)`, `sweep_new = s_sweep · sweep_old`, 볼록 플래그 그대로 | **s_sweep은 방향 계약** — 골든에서 벌어지는 방향으로 확정. placement·start·sweep의 s가 각각 다를 수 있음 |
| **sector** | placement 공식 동일 | arc와 같은 골격 (`start/sweep`) | v1이 **delta 계약 값(base+delta)** 을 저장했다면 로드 시 절대각으로 접어서(`base + Σdelta`) 변환 후 공식 적용 |

### 상수 확정 절차 (도형 1개당)
1. [ ] 수정 **전** 버전에서 대표 파일 저장 (placement ≠ 0, arc는 start/sweep 비대칭인 케이스).
2. [ ] 수정 **후** 코드에서 후보 상수(s=+1/−1, φ=0/−90/+90)로 로드해 렌더 비교.
3. [ ] 수정 전 렌더와 **픽셀 일치**하는 조합을 채택, 아래 표에 기입.

| 상수 | rectangle | polygon | ellipse(placement/axis) | arc(placement/start/sweep) | sector |
|---|---|---|---|---|---|
| s | ☐ | ☐ | ☐ / ☐ | ☐ / ☐ / ☐ | ☐ |
| φ | ☐ | ☐ | ☐ / ☐ | ☐ / ☐ / — | ☐ |

---

## 관련 문서
- `ROTATION_FIX_PROPOSAL.md` — 설계안 통합본 (§8 설계 보정, §9 오독 방지 포함)
- `docs/old/` — 원본 문서 보존
- 재현 데모: `map-aabb` 실행 → 우측 패널 "회전 버그 재현" 토글

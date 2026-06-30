# 회전 버그 수정 — 리스크 분석 보충 (Addendum)

> `ROTATION_FIX_RISKS.md`(리스크 1~3)에 **빠져 있던/정정할** 항목을 추가한다. 기존 문서는 그대로 두고 이 문서로 보완.
> 추가: **리스크 4(저장/복원 호환성)**, **리스크 5(단일 선택 fast path 내부 분기)**, **리스크 1 정정(arc ≠ sector 우선순위)**.

---

## 리스크 4 — 저장/복원 호환성 (배포 리스크 ‼️ 가장 먼저 챙길 것)

### 무엇이 문제인가
- 현재 **serialize**는 **visual rotation 계열 값**을 저장한다.
- **deserialize**는 그 값을 다시 **`setAngle`로 복원**한다.
- → **정준 각도 공간을 바꾸면, 이미 저장된 기존 데이터가 "다른 방향"으로 열린다.**

### 왜 특히 위험한가 (코드가 아니라 데이터다)
- [ ] 새 도형 테스트는 다 통과해도, **사용자가 예전에 저장한 파일/문서**는 업데이트 후 **조용히 반대로 열린다.** 신규 케이스 테스트로는 절대 못 잡는다.
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
기존 문서는 회전 경로를 group / single / legacy로 나눴지만, **실제 "single(단일 선택)" 안에도** 별도 분기가 더 있다:

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
- [ ] 검증에 **single × {rectangle, polygon, ellipse} × {screen, map-flat, map-tilt}** 를 반드시 포함.

---

## 리스크 1 정정 — arc 와 sector 는 같은 위험이 아니다 (우선순위 주의)

> 기존 문서는 arc·sector를 묶어 "리스크 1"로 다뤘다. 실무 우선순위에선 **둘을 분리**해야 한다.

- [ ] **arc(호) = 가장 위험**: map setAngle 경로가 **불규칙**하고 내부 각도(start/sweep/볼록)가 많아 반전 시 가장 크게 깨진다. **수정·검증 1순위.**
- [ ] **sector(부채꼴) = 상대적으로 덜 위험**: map setAngle이 arc보다 **정규적인 delta 회전**을 쓴다. 그래도 **angle-box 계열**이라 같은 종류의 반전 위험은 있다.
- [ ] 결론: **고치는 우선순위는 arc > sector**, 하지만 **검증은 arc·sector 같이** 한다. 둘을 "동일 위험"으로 뭉뚱그리면 **구현 우선순위를 잘못 잡는다.**

---

## 보충 반영 — 롤아웃 순서 (기존 6단계에 덧붙임)

- [ ] **0단계(최우선)**: 직렬화 **버전 + 마이그레이션 함수** 먼저 마련(리스크 4). 신규 저장은 새 버전, 로드는 구버전 1회 변환.
- [ ] **인벤토리에 추가**: ④ 직렬화가 저장하는 각도 값, ⑤ **단일 내부 분기**(rectangle-screen/polygon-bounds/ellipse-tilted).
- [ ] **각 이관 단계마다 "저장 라운드트립"** 도 함께 재실행.
- [ ] 내부 각도 재유도는 **arc → sector 순**.

## 보충 반영 — 검증 매트릭스 (기존 표에 추가할 행)

| 도형/대상 | 모드 | 경로 | 확인 항목 |
|---|---|---|---|
| polygon | map-flat / map-tilt | **single(bounds contract branch)** | 회전 방향·경계 정상 |
| ellipse | **map-tilt(예외 분기)** | single | 장축 각도·회전 방향 정상 |
| **arc(1순위)** | map-flat / map-tilt | group / single | start·sweep·볼록 방향 정상 |
| **sector(arc와 같이 검증)** | map-flat / map-tilt | group / single | start·sweep 정상(arc보단 덜 위험) |
| **저장 골든 파일** | — | 로드/복원 | **수정 전과 동일 방향으로 열림**(라운드트립) |

---

## 관련 문서
- `ROTATION_FIX_RISKS.md` — 리스크 1~3 (원본)
- `ROTATION_FIX_DESIGN.md` — 수정 설계
- `ROTATION_FIX_PRACTICAL_SUMMARY.md` — 실무 요약
- `SELECTION_BOX_CHECKLIST.md` — 질문지 + 규약 체크리스트

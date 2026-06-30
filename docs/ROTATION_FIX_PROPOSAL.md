# 회전 버그 수정 설계안 (통합본)

> **이 문서 하나면 끝.** 그룹 도형 프로젝트의 회전 버그를 진단·수정·검증하는 전체 설계.
> 세부 원본은 `docs/old/`에 보존(질문지·리스크 상세 등). 이 통합본이 최신 기준이다.
>
> **두 증상**
> - ① 사각형 map 모드에서 회전이 **반대로** (각도에 `-` 땜질)
> - ② 일정 이상 돌리면 **반대로 튐** (각도 점프에서 wrap)
>
> **재현 데모**: `map-aabb/src/app/app.tsx`의 `REPRODUCE_GROUP_PROJECT_BUGS` 플래그.
> `true`=버그 재현, `false`=정상(=이 설계안의 최종 형태).

---

## 0. 30초 요약

- **원인**: 화면(map)은 "거울"이라 좌표 Y가 뒤집힌다. 그걸 **좌표에서 한 번** 처리하지 않고 **각도에 `-`를 붙여 도형마다 땜질**했다. + 회전을 "얼마나 움직였나 더하기(delta 누적)"로 계산해 각도 점프(359°→0°)에서 튄다.
- **고치는 법**: ① 거울(Y 뒤집힘)은 **경계 한 곳에서만** 처리(각도 `-` 땜질 제거), ② 회전은 **지금 가리키는 절대 각도**를 그대로 set + 이중 모듈로 정규화.
- **함정**: 사각형만 고치면 arc·단일선택·저장데이터가 거꾸로 깨진다. **다 같이** 옮겨야 한다.

---

## 1. 근본 원인 — 두 증상은 한 뿌리

깨진 불변식:

> **각도는 "측정하는 프레임"과 "적용/렌더하는 프레임"이 같아야 한다 (= Y 반사 횟수가 같아야 한다).**

- **증상 ①(부호 반전)**: 측정은 **screen(Y↓)**, 적용/렌더는 **map/world**. 둘 사이 Y 반사가 **홀수 번** 남아 회전이 뒤집힌다. 수학적으로 `F · R(θ) · F⁻¹ = R(−θ)` (반사가 회전 부호를 뒤집음). 그래서 rectangle·ellipse/arc마다 `-angle`을 박아 **개별 보정**하게 됐다.
- **증상 ②(경계서 반대로)**: `atan2`의 ±180° seam + **delta 누적 + 단순 `%360`**. 경계 통과 시 delta가 ∓360°로 튀는데 단순 모듈로가 못 흡수 → 반대로 꺾인다.

→ **"프레임 단일화"** 가 ①을, **"각도 갱신 방식 정리"** 가 ②를 없앤다. per-shape `-angle` 보정은 ①의 증상이라 자동 소멸한다.

### 쉬운 비유
- **①**: 거울 앞에서 오른손 들면 거울 속은 왼손. 지도 화면이 그 거울이라 "시계방향"이 화면에선 반시계 → 각도에 `-` 땜질.
- **②**: 시계 초침이 59초→0초로 확 뛰듯 각도도 359°→0°로 점프. "더하기" 방식이라 그 점프에서 홱 돌아감.

---

## 2. 목표 아키텍처 — 하나의 정준(canonical) 각도 공간

```
[screen pointer] --(boundary A: 1회 변환)--> [model angle θ] --(boundary B: 1회 변환)--> [render]
                     screenAngleToModel()                          modelAngleToRender()
```

- [ ] **정준 model angle을 하나로 고정**(예: 로컬 Y-up 기준 CCW+). 모든 도형이 이 값 하나만 본다.
- [ ] **경계 변환은 각 1번, 도형 무관**. Y 반사를 `screenAngleToModel`/`modelAngleToRender` 안에서 딱 한 번씩. → 어디에도 per-shape `-angle` 없음.
- [ ] **회전 갱신은 절대각 set**(또는 최단호 delta). 단순 `%360` 금지.

> 레퍼런스(`map-aabb`)가 이미 이 형태다: 측정·guide·렌더 모두 **로컬 미터 단일 프레임** → 보정 0개.

---

## 3. 구체 수정 — Step 0~6

- [ ] **Step 0. 계측(반사 홀짝 세기)**: rectangle·ellipse에서 `(screenAngle, modelAngle, renderedAngle)` 로그. 파이프라인의 Y 부호 반전(`-y`, `scale(...,-s,...)`, `scaleY(-1)`)을 **전부 센다**. 짝수=정상 / 홀수=반전.
- [ ] **Step 1. 경계 변환 함수 2개 정의(도형 무관)**: `screenAngleToModel` / `modelAngleToRender`. 흩어진 반사 처리를 여기로 흡수.
- [ ] **Step 2. 모든 도형을 위 함수로 통일 + per-shape `-angle` 전부 제거** (⚠️ Step 1과 **원자적으로**). 보정만 먼저 지우면 "두 번 틀려 맞던" 도형이 반대로 보임.
- [ ] **Step 3. 회전 갱신 통일(증상 ②)**: 그룹(절대각)·로컬(delta) 두 경로를 하나로 → 절대각 set 권장. delta가 필요하면 **최단호**: `θ += normalizeDeg(cur − prev)`. 저장값은 **이중 모듈로** `((v+180)%360+360)%360−180`, 단순 `%360` 제거.
- [ ] **Step 4. 피벗을 정준 프레임에서**: 그룹 중심(selectionframe center) 유지, 자식 회전은 단일 forward 변환으로 그룹 중심 기준. 자식별 누적 금지.
- [ ] **Step 5. guide ↔ shape 변환 단일화**: 같은 projection 함수 공유. 단 **`map.project`로 끝나는 함수**로(틸트 안전). 성능상 screen guide가 필요하면 매 repaint마다 **model 상태에서 파생**.
- [ ] **Step 6. snapshot 이동 정합**: 드래그 중 snapshot로 빠르게 그리되, **pointer-up에서 정준 파이프라인으로 reproject 해 commit**. 이동 기준점과 회전 피벗이 같은 좌표 공유.

---

## 4. 리스크 (위험도 순) — "사각형만 고치면 나머지가 거꾸로 깨진다"

### 0순위 💾 저장/복원 호환성 — 배포 리스크 (제일 먼저)
- **왜**: serialize는 **visual rotation 값** 저장, deserialize는 `setAngle`로 복원. 정준 각도를 바꾸면 **기존 저장 파일이 반대로 열린다.** 코드가 아니라 **데이터** 문제라 신규 테스트로 못 잡고, 배포 후 되돌리기 어렵다.
- **대응**: 직렬화에 **버전 필드** + 로드 시 **구버전 1회 마이그레이션**(옛 visual→새 정준, 도형 타입별). **수정 전 저장 파일 라운드트립**으로 동일 방향 확인.

### 1순위 ⚠️ arc(호) — 시각 정확성에서 가장 위험
- **왜**: 깨져도 **에러 없이 그럴듯하게** 그려져 리뷰에서 놓침. map setAngle이 불규칙, 내부 각도(start/sweep/볼록) 많음.
- **대응**: 검증 1순위를 **사각형이 아니라 arc로**. start 위치+벌어지는 방향을 골든 스크린샷으로 박고 **통과 전 배포 금지**.
- **arc ≠ sector**: **sector(부채꼴)는 더 정규적인 delta라 상대적으로 덜 위험.** 단 angle-box 계열이라 **검증은 arc와 같이**. 수정 우선순위 **arc > sector**. (둘을 동일 위험으로 뭉치면 우선순위 오판)

### 2순위 🖱️ 맵 틸트 가이드/bbox — 가장 깨지기 쉬운 UI
- **왜**: 빌드는 멀쩡, **지도 기울이고 줌하는 순간에만** 터짐 → 자동 테스트로 잡기 어려움.
- **대응**: "단일화"는 **각도·좌표 계약(A)만**. **guide 레이아웃(B: 픽셀 고정 핸들·screen-AABB)은 유지**, model 상태에서 파생. `map.project` 기반 유지, **손으로 만든 평면 행렬 금지**(틸트에서 깨짐).

### 3순위 🧭 회전 경로가 문서보다 많음 — 범위 추적이 골치
- **왜**: group/single/legacy로 나눠도 **"single" 안에 rectangle-screen / polygon-bounds / ellipse-map-tilted 하위 분기**가 더 있음. 그룹만 고치면 단일은 여전히 반대로.
- **대응**: 각도가 **최종 적용되는 한 곳**(렌더 직전)에 체크포인트 + "누가 세팅했나" 로그 → 숨은 경로를 **런타임이 스스로 드러냄**. fast path도 이 한 곳(`applyRotation`)을 **반드시 거치게**(빠르게=변환 건너뛰기 금지).

---

## 5. 안전한 적용 순서 (롤아웃)

1. [ ] **0단계(최우선)**: 직렬화 **버전 + 마이그레이션 함수** 먼저(리스크 0순위).
2. [ ] **인벤토리(무변경)**: ① 도형별 모든 각도 quantity, ② 모든 회전 경로(**단일 내부 분기 포함**), ③ 모든 Y 반사 지점, ④ 직렬화가 저장하는 각도 값.
3. [ ] **골든 확보**: 수정 전 저장 파일 + `(도형 × 경로 × 모드{screen, map-flat, map-tilt})` 파리티 스냅샷.
4. [ ] **정준 변환 도입 + 경로 1개만 라우팅**, 런타임 체크포인트로 숨은 경로 추적.
5. [ ] **나머지 경로(단일 내부 분기 포함) 하나씩 이관**, 매번 하네스 + **저장 라운드트립** 재실행.
6. [ ] **arc → sector 순 내부 각도 재유도**를 해당 `-angle` 제거와 **같은 커밋**.
7. [ ] 전부 green일 때만 **legacy/보정 코드 삭제**.

> 한 줄: **"사각형만 먼저"는 함정.** 모든 경로·모든 각도 quantity를 같은 정준 공간으로 옮기되, **guide 레이아웃은 그대로 두고**, **기존 저장 데이터는 버전 마이그레이션으로 흡수**한다.

---

## 6. 검증 매트릭스

| 도형/대상 | 모드 | 경로 | 확인 항목 |
|---|---|---|---|
| rectangle | screen / map-flat / map-tilt | group / single(screen branch) / legacy | 시계=시계, 경계서 안 튐 |
| polygon | map-flat / map-tilt | single(bounds contract branch) | 회전 방향·경계 정상 |
| ellipse | map-flat / map-tilt(예외 분기) | group / single | 장축 각도·회전 방향 정상 |
| **arc (1순위)** | map-flat / map-tilt | group / single | **start·sweep·볼록 방향** 정상 |
| sector (arc와 같이) | map-flat / map-tilt | group / single | start·sweep 정상(arc보단 덜 위험) |
| 전 도형 | map-**tilt** | — | 선택상자 앵커 고정, bbox가 도형 감쌈, 핸들 픽셀 오프셋 유지 |
| 전 도형 | 전 모드 | 전 경로 | 같은 입력 → 같은 각도(경로 간 일치) |
| **저장 골든 파일** | — | 로드/복원 | **수정 전과 동일 방향으로 열림**(라운드트립) |

---

## 7. 레퍼런스 코드 매핑 (`map-aabb/src/app/app.tsx`)

| 수정 항목 | 레퍼런스 위치 | 비고 |
|---|---|---|
| 정준 프레임에서 각도 측정 | `getPointerLocalMeters` (Y 반전 1회) | 측정 프레임 고정 |
| 절대각 set | 회전 핸들러 `updateShapeState({ rotationZ: normalizeDegrees(rawAngleDeg) })` | delta 누적 아님 |
| 이중 모듈로 정규화 | `normalizeDegrees` | 단순 `%360` 금지 |
| 렌더 반사 1회 | `customLayer.render`의 `scale(s, -s, s)` | Y 반사 1곳 |
| guide·shape 동일 변환 | `projectLocalPoint` (→ `map.project`) | 틸트 안전 |
| 버그 재현/정상 토글 | `REPRODUCE_GROUP_PROJECT_BUGS` | `false` 분기 = 최종 수정 형태 |

> **그쪽 최종 수정 = 레퍼런스에서 재현 플래그를 끈 회전 핸들러**(절대각 + `normalizeDegrees`, 반전·누적 없음)를 옮긴 것과 같다.

---

## 부록 — 원본 문서 (`docs/old/`)
- `SELECTION_BOX_CHECKLIST.md` — 그쪽 AI용 질문지 + 규약 체크리스트 + 재현 데모
- `ROTATION_FIX_DESIGN.md` — 수정 설계 원본
- `ROTATION_FIX_RISKS.md` — 리스크 1~3 원본
- `ROTATION_FIX_RISKS_ADDENDUM.md` — 리스크 4·5 + arc/sector 정정
- `ROTATION_FIX_PRACTICAL_SUMMARY.md` — 실무 요약 원본

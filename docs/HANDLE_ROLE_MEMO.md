# 메모 — 회전 시 핸들 역할(R vs RB) 오판 문제: 레퍼런스(map-aabb)는 왜 구조적으로 발생 불가능한가

> **배경**: 그쪽(그룹 도형) 프로젝트에서 도형이 회전하면 **R(edge) 핸들이 RB(corner) 방향으로 판정**되는 현상. R이 corner로 처리되면 양축 스케일 + 대각 앵커가 되어 "한 변만 줄였는데 여러 변이 줄어드는" 증상의 **두 번째 기제**가 될 수 있다.
> **이 메모**: 우리 레퍼런스(`map-aabb`)에서는 이 문제가 **해결됐다기보다 애초에 발생할 수 없는 구조**임을 코드 근거로 분석해 남긴다. 그쪽에 이식할 계약도 정리한다.

---

## 1. 핵심 계약 (한 문장)

> **핸들의 정체성(role)은 데이터에서 태어나 element에 바인딩되고, 화면 좌표는 "출력"일 뿐 역할 판정의 "입력"이 아니다.**

레퍼런스에는 "이 핸들이 무엇인가?"를 **화면 좌표에서 추론하는 코드 경로 자체가 없다.** 그래서 회전으로 핸들이 화면 어디에 보이든 역할이 바뀔 수 없다.

---

## 2. 코드 근거 (`map-aabb/src/app/app.tsx`)

### (1) 역할은 로컬/데이터에서 정의되고, 화면 좌표는 투영 결과일 뿐
- `buildOverlayGeometry` (`app.tsx:274`)가 **로컬 프레임의 역할별 배열**을 만들고 각 항목을 `projectLocalPoint`로 화면에 투영:
  - 정점 핸들: `vertices = points.map((point, index) => ({ index, ...projectLocalPoint(...) }))` (`app.tsx:280`) — **역할 = index, 데이터에서 부여**
  - 회전 핸들: 로컬 `{x: 0, y: maxY + OFFSET}`를 투영 (`app.tsx:332`) — 회전하면 화면 위치는 돌지만 **역할은 항상 "회전 핸들"**
- 즉 화면 좌표는 `역할 → 위치`의 단방향 산출물. `위치 → 역할` 역추론이 없다.

### (2) 정체성은 pointerdown 순간 element가 직접 알려준다
- 각 SVG 핸들 element의 `onPointerDown`이 **자기 역할을 상수로 캡처**해 넘긴다:
  - 정점: `startDrag({ type: 'vertex', index: vertex.index }, ...)` (`app.tsx:1045`)
  - 회전: `startDrag({ type: 'rotate' }, 'rotate')` (`app.tsx:1062`)
  - 점 추가: `insertVertexAfter(segment.insertAfter)` (`app.tsx:1014`)
- **히트테스트도 브라우저가 투영된 element에 대해 수행** (SVG pointer events) — 수동 screen-좌표 분류 코드가 없다.

### (3) 드래그 중 역할 재판정 없음 — DragState가 역할을 끝까지 보존
- 역할은 명시적 유니온 `DragState`에 기록된다 (`app.tsx:76`: `move-shape | rotate | curve | vertex`).
- `pointermove`는 `dragState.type`/`dragState.index`만 읽는다 (`app.tsx:691, 718, 772`) — 포인터가 화면 어디에 있든 **위치로 역할을 다시 판단하는 코드가 없다.**
- screen→local 역변환(`getPointerLocalMeters`)은 **포인터의 "값"** 을 구하는 데만 쓰인다. 정체성 판정에는 관여하지 않는다.

---

## 3. 왜 이 구조에서 R→RB 오판이 불가능한가

| 단계 | 레퍼런스 방식 | 오판 가능성 |
|---|---|---|
| 핸들 생성 | 로컬 역할(index/종류) → 화면 투영 | 역할이 먼저, 위치는 결과 → 없음 |
| 핸들 선택(hit) | 브라우저가 element 단위로 | 위치→역할 추론 없음 → 없음 |
| 드래그 중 | DragState의 역할 고정 | 재판정 없음 → 없음 |

오판이 나려면 "화면상 어느 방향에 있느냐"로 핸들 종류를 **분류**하는 단계가 있어야 하는데, 그 단계 자체가 존재하지 않는다.

---

## 4. 그쪽 프로젝트에 이식할 계약

그쪽처럼 **8핸들 selection frame**(모서리 4 + 변 4)이어도 원리는 동일하게 적용된다:

- [ ] 8핸들을 **프레임 로컬(비회전 공간)** 의 고정 역할(N/E/S/W/NE/NW/SE/SW)로 정의 → 투영해서 그림 → **element/객체에 role 바인딩**.
- [ ] pointerdown에서 role은 **element가 알려주는 값**을 쓴다. 화면 위치로부터 분류하지 않는다.
- [ ] 드래그 세션 동안 role·anchor는 **시작 시 1회 확정 후 불변** (RESIZE_FIX_SPEC의 스냅샷 계약과 결합).
- [ ] **화면 방향 판정은 커서 표시에만** 쓴다:

| 용도 | 기준 프레임 | R 핸들, 45° 회전 시 |
|---|---|---|
| 커서 모양·방향 (UX 표시) | screen | "RB 방향" 판정이 **맞음** ✅ |
| 변형 역할 (스케일 축·앵커 짝) | **local (불변)** | 여전히 **R(edge, 한 축)** |

> 그쪽의 "R 핸들이 RB 방향이 맞다"는 판단은 **커서 표시용이면 정상, 변형 로직까지 RB(corner)로 처리하면 버그**다.

---

## 5. 실측 연결 (RESIZE_FIX_SPEC_ADDENDUM A장에 추가 권고)

- [ ] 실측 로그에 한 줄 추가: **드래그 시작 시 "핸들 판정 결과(role)"와 "적용된 factor 축(fx, fy 중 무엇이 변하는지)"**.
- [ ] 회전 45° 상태에서 R 핸들 드래그 시:
  - role=R + fy만 1 → 역할 판정 정상 (증상 원인은 applied-state 재사용 쪽)
  - role=RB 또는 fx·fy 둘 다 변화 → **핸들 역할 오판이 실재** — 이 메모 4장의 계약으로 수정
- [ ] 두 기제(역할 오판 / applied-state 재사용)는 **공존 가능** — 하나가 확인돼도 다른 하나를 배제하지 말 것.

---

## 관련 문서
- `RESIZE_ANCHOR_ANALYSIS.md` — 리사이즈 증상 1차 분석 (용의자 5는 포인터 변환에 대한 것 — 핸들 role 판정은 별개 지점)
- `RESIZE_FIX_SPEC.md` + `RESIZE_FIX_SPEC_ADDENDUM.md` — 패치 스펙 (스펙의 anchor 계약은 role 판정이 옳다는 전제 위에 있음)
- `ROTATION_FIX_FINDINGS.md` — 발견 로그

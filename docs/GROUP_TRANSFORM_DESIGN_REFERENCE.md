# 그룹/단일 도형 변형 설계 레퍼런스 (map-aabb shape-tester)

> **용도**: 이 저장소의 그룹 선택상자(OBB) 변형 구현을 **설계 레퍼런스**로 참고할 수 있게 정리한 문서.
> 구현: `map-aabb/src/app/shape-tester.tsx` (MapLibre 지도 위 그룹/단일 도형 변환 테스터).
> 실행: `npm run dev:web` → 도형 shift-클릭으로 다중 선택 → 그룹 박스 핸들로 회전/리사이즈.

---

## 1. 좌표 프레임 (4단)

```
lngLat (지도 좌표)
  ⇄ meter frame        — 그룹 centroid 원점의 로컬 미터 (MeterFrame(center))
  ⇄ group local        — meter에서 −groupRotation 회전 제거한 축 (박스·리사이즈 계산 프레임)
  → screen px          — 렌더/히트테스트 (map.project)
```

- 모든 **변형 계산은 group local**에서, 모든 **표시는 screen**에서. 포인터는 역변환(`rotate(pm, −rotStart)`)으로 group local로 들어온다.
- Y 부호·회전 방향 규약은 단일 도형과 그룹이 동일 (프레임마다 다른 보정 없음).

## 2. 상태 모델

| 대상 | 저장 상태 | 원칙 |
|---|---|---|
| 자식 도형 | `{center(lngLat), rotationDeg, scale:{x,y}}` — **유사변환 스칼라** | 정점에 행렬을 굽지(bake) 않음 → 왕복 복귀·직렬화 안전 (affine bake를 피하는 이유: `GROUP_RESIZE_SCREENSPACE_FIX.md` §7) |
| 그룹 | **`groupRotation` 숫자 하나만 지속** (선택 SET 변경 시 0 리셋) | 박스 크기·중심은 상태로 저장하지 않음 |
| 그룹 박스 | **매 렌더 자식에서 도출** — "회전된 그룹 로컬 프레임의 AABB" = 화면상 OBB | 도출값은 표시·히트테스트 전용, 변형 계산의 입력이 아님 |

### 박스 도출 (`computeGroupBox(sel, rotationDeg)`)
```
center = 자식 중심들의 centroid
각 자식 정점 v:  gl = rotate(meterFrame.toMeters(v), −groupRotation)
box = gl들의 AABB  → {boxCenterLocal, half}
```
- **회전 시**: 자식과 프레임이 같은 각도로 돌아 group local에서 자식이 안 움직임 → AABB 불변 → **박스가 강체로 회전 (핸들·점 요동 없음)**
- **스케일 시**: 매 렌더 tight하게 감쌈 → **자식이 박스 밖으로 삐져나오지 않음**

## 3. 핸들 계약

- 핸들 역할(role: N/E/S/W/코너)은 **group local에서 정의**되어 element에 바인딩된다. pointerdown 시 element가 자기 역할을 상수로 넘긴다 — **화면 위치로부터 역할을 분류하는 코드가 없다.** (상세: `HANDLE_ROLE_MEMO.md`)
- 화면상 방향(커서 표시 등)은 표시 전용. 변형 축은 항상 로컬 역할을 따른다. → 회전한 도형에서 R 핸들은 화면상 **회전각만큼 기울어진 방향**으로 동작한다 (당기는 방향 = 회전된 로컬 X축, `HANDLE_AXIS_CLARIFICATION.md`).

## 4. 그룹 리사이즈 (`group-scale`, `shape-tester.tsx:492~523`)

### 드래그 시작 스냅샷 (pointerdown 1회 확정, 드래그 내내 불변)
```
frame        (meter frame)         rotStart   (시작 회전각)
anchorLocal  (반대변/반대코너, group local)
halfStart    (박스 half)           snaps      (각 자식의 시작 center·scale)
```

### 매 pointermove (매 프레임 독립·idempotent)
```ts
const pLocal = rotate(pm, -d.rotStart);            // 포인터 → group local
const cx = d.dir.x !== 0, cy = d.dir.y !== 0;      // 핸들 방향이 축 참여를 게이트
const sX = cx ? newHalfX / d.halfStart.x : 1;      // 잡은 축만 인자 계산
const sY = cy ? newHalfY / d.halfStart.y : 1;
// 각 자식 (스냅샷 기준 절대 계산):
newOffLocal = {
  x: cx ? A.x + (off.x - A.x) * sX : off.x,        // 안 잡은 축은
  y: cy ? A.y + (off.y - A.y) * sY : off.y,        //  원본 값 그대로 통과
};
scale = { x: snap.scale.x * (cx ? sX : 1), y: snap.scale.y * (cy ? sY : 1) };
// 박스는 적용 후 다음 렌더에 자식에서 tight 도출 (계산 입력 아님)
```

### 설계 포인트
1. **축 게이트**: edge 핸들은 안 잡은 축이 계산에 **참여 자체를 안 함**. "×1"이 아니라 **분기로 원본 통과** → 부동소수 오차조차 0.
2. **앵커 = 스냅샷**: `anchorLocal`은 시작 시 1회 확정. 반대변 위의 점은 `(off − A)·s = 0`으로 **정확히 고정**.
3. **절대 계산**: 항상 `P' = A + S·(P₀ − A)` — 시작 좌표 `P₀` 기준. 증분 누적·applied state 재입력 없음 → 왕복(jiggle) 시 원위치 복귀.
4. **출력→입력 차단**: 도출된 박스·적용된 자식 상태는 같은 드래그의 다음 계산에 입력되지 않는다.

## 5. 그룹 회전 (`group-rotate`)

- 피벗 = centroid. 자식은 centroid 기준 회전 + 자기 회전각 갱신, `groupRotation`도 갱신.
- 각도는 **로컬 좌표의 atan2 절대각으로 set** (delta 누적 아님) + 이중 모듈로 정규화 `((v+180)%360+360)%360−180` — ±180° 경계에서 튐 없음.
- 커밋/렌더 경로에 각도 부호 보정(`-angle`)이 없다 — 측정·적용·렌더가 같은 프레임 규약 공유. (배경: `ROTATION_FIX_FINDINGS.md` Finding #2)

## 6. 이 설계가 보장하는 동작 (검증된 불변식)

- [ ] θ° 회전 상태에서 R 드래그 → 늘어나는 방향 **정확히 θ°** (작은 각이면 작은 기울기)
- [ ] R 드래그 중 **모든 점의 로컬 Y(top/bottom 성분) 변화 = 0** — 수직 오염 없음
- [ ] 반대변(L)은 **화면 픽셀 단위 고정**
- [ ] 왕복(jiggle) 드래그 → 크기·위치 **완전 복귀**
- [ ] 그룹 회전 중 핸들·점 **요동 없음** (박스 강체 회전)
- [ ] 스케일 시 자식이 박스를 **벗어나지 않음** (tight 도출)
- [ ] 도형 무왜곡 — 회전된 직사각형 유지 (전단 없음, 유사변환 모델)

## 7. 코드 맵

| 설계 요소 | 위치 |
|---|---|
| 그룹 박스 도출 (OBB) | `shape-tester.tsx` `computeGroupBox` (:127~) |
| 그룹 리사이즈 | `shape-tester.tsx` `group-scale` (:492~523) |
| 그룹 회전 | `shape-tester.tsx` `group-rotate` |
| 단일 도형 리사이즈 (자기 로컬 OBB) | `shape-tester.tsx` (:470~489) |
| 각도 정규화·회전 규약 | `app.tsx` `normalizeDegrees`, 회전 핸들러 |
| 화면 앵커·측정 원칙 | `GROUP_RESIZE_SCREENSPACE_FIX.md` §2·§5·§6 |

## 8. 알려진 한계 (의도된 트레이드오프)

- **전단(shear) 미표현**: 자식이 유사변환(`{rotation, scale.x, scale.y}`)이라, 그룹과 다른 자기 회전을 가진 자식의 비균일 스케일은 PPT처럼 평행사변형이 되지 않는다 (대신 tight 박스로 삐져나옴은 없음). 완전한 전단이 필요하면 정점 affine bake가 필요하지만, 누적 왜곡·직렬화 문제로 **의도적으로 채택하지 않음** (`GROUP_RESIZE_SCREENSPACE_FIX.md` §7).
- **카메라 평면 고정**: `maxPitch: 0` + `dragRotate.disable()` — 화면축과 지도 평면을 일치시켜 픽셀↔미터 선형성을 보장. 틸트 지원이 필요하면 앵커를 지면 평면 투영 기준으로 확장해야 한다.

---

## 관련 문서
- `GROUP_RESIZE_SCREENSPACE_FIX.md` — 화면 앵커 수정·측정 함정·박스 모델·affine bake 비채택 근거
- `HANDLE_ROLE_MEMO.md` / `HANDLE_AXIS_CLARIFICATION.md` — 핸들 역할·축 계약
- `ROTATION_FIX_FINDINGS.md` — 회전 규약 확정 경위

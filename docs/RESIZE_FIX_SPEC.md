# 그룹 리사이즈 수정 — 패치 스펙 (구현용, 자기완결)

> **이 문서 하나로 구현 가능하게** 정리한 최종 스펙. 배경 분석은 `RESIZE_ANCHOR_ANALYSIS.md`, 판정 경위는 `RESIZE_ANCHOR_FOLLOWUP.md`(2차 합의판)를 참조하되, 구현자는 이 문서만 봐도 된다.
>
> **버그 요약**: 그룹 선택상자 bottom 핸들을 줄이면 4변이 전부 줄고 위치가 이동.
> **확정 방향의 원인**: 드래그 중 **applied state(이미 적용된 결과)가 다음 계산의 입력으로 재사용**됨 — 타깃 가이드 프레임이 불변 스냅샷이 아니라 변하는 현재 박스 + old bounds anchor로 계산되어 오차가 프레임마다 복리로 누적.

---

## 1. 패치 범위 — 3지점 모두 (부분 패치 금지)

| # | 지점 | 해야 할 일 |
|---|---|---|
| ① | **target guide frame 생성 로직** | 프레임 생성 함수의 입력을 `(startGuideFrame, 현재 포인터, 핸들 종류)`로 고정. 현재 박스·old bounds anchor를 입력에서 제거 |
| ② | **freeform 매핑 경로** | 시작 상대점 → ①이 생성한 타깃 프레임으로 매핑. 입력은 figure start state(이미 고정)만 |
| ③ | **direct geometry 경로** | guide 매핑을 거치지 않고 geometry를 직접 쓰는 경로도 ①②와 **같은 입력 계약** 적용 |

> ⚠️ freeform에만 패치하면 ①·③ 경로로 증상이 계속 샌다. (회전 Finding #2에서 guide/bake/commit 세 경로가 각각 달라 어긋났던 것과 동형)

---

## 2. 핵심 불변식

> **드래그 중 applied state를 입력으로 재사용 금지.**

- 허용: 드래그 중 bounds/표시용 재계산 자체는 해도 됨 (guide 렌더에 필요할 수 있음)
- 금지: 이번 드래그에서 **적용된 결과**(applied state, 재계산된 bounds)가 같은 드래그의 **다음 계산 입력**으로 들어가는 것 (출력→입력 간선 차단)
- 모든 계산의 입력은 오직 3가지: **`startGuideFrame`(불변) · `figure start state`(불변) · 현재 포인터**

파생 규칙:
- [ ] **스냅샷 계약**: 드래그 시작 시 `startGuideFrame`(박스 + anchor) 1회 확정, 드래그 내내 불변
- [ ] **anchor 명시화**: 타깃 프레임 구성 시 **시작 프레임의 반대변 좌표를 그대로 복사** (암묵 앵커 금지, old bounds에서 읽기 금지)
- [ ] **commit에서만 승격**: pointer-up에서만 applied 결과를 새 base로. 다음 드래그의 스냅샷은 그 base에서 뜬다

---

## 3. 구현 스펙 (의사코드)

```
// ── 드래그 시작 ──────────────────────────────────────
onResizeStart(handle):
  S.frame0    = 현재 guide frame 복사        // 이후 절대 갱신하지 않음
  S.anchor    = frame0에서 handle의 반대변/반대코너 좌표   // 1회 확정
  S.figures0  = 각 figure start state        // (기존에 이미 고정 — 유지)
  S.handle0   = handle 시작 위치 (frame0 기준)

// ── 드래그 중 (매 프레임 독립·idempotent) ─────────────
onResizeMove(pointer):
  p           = pointer를 frame0 기준 로컬로 역변환   // 회전 그룹이면 -angle 포함
  (fx, fy)    = 축별 인자: (p − S.anchor) / (S.handle0 − S.anchor)
                edge 핸들 → 한 축은 1로 강제 (기존 동작 유지)
  targetFrame = S.frame0의 반대변을 S.anchor에 고정한 채 fx·fy로 확장/축소   // ① 생성 로직
  ② freeform: figure' = targetFrame.map(relative(S.figures0, S.frame0))
  ③ direct  : geometry' = bake(S.figures0, targetFrame)     // 입력은 항상 스냅샷
  // 표시용 bounds 재계산은 자유 — 단 그 결과를 S.* 에 다시 쓰지 않는다

// ── 드래그 종료 ──────────────────────────────────────
onResizeEnd:
  commit(applied 결과 → 새 base)
  S 폐기
```

### 금지 목록 (이 패턴이 보이면 리뷰 반려)
- [ ] `S.frame0` / `S.anchor`를 드래그 중 재대입
- [ ] 타깃 프레임 계산에 **현재(변하는) guide 박스** 사용
- [ ] anchor를 **old bounds**에서 다시 읽기
- [ ] `figure'`(applied)를 다음 프레임 매핑의 입력으로 사용
- [ ] 드래그 중 base/저장값 갱신 (commit 전 승격)

---

## 4. 검증 매트릭스 (전부 통과해야 완료)

| 검증 | ① frame 생성 | ② freeform | ③ direct |
|---|---|---|---|
| 실험 1 — 0° bottom 드래그: top·left·right **불변**, bottom만 변화 | ☐ | ☐ | ☐ |
| 실험 2 — 왕복(jiggle): 포인터 원위치 → 크기·위치 **완전 복귀** | ☐ | ☐ | ☐ |
| 실험 3 — 45° 회전 그룹에서 실험 1·2 동일 통과 | ☐ | ☐ | ☐ |

추가 게이트:
- [ ] corner 핸들: 대각 corner 고정 확인 (edge와 동일 계약)
- [ ] **rotate 회귀 없음**: 공유하는 multi figure guide session 경유로 회전 동작이 변하지 않았는지 (Finding #2로 정상화된 상태 유지)
- [ ] **저장 라운드트립**: 수정 전 저장 파일이 동일하게 열리고, commit 값의 의미가 바뀌지 않았는지
- [ ] 단일 선택(local, 반대변 피벗) 경로 회귀 없음

## 5. 완료 기준 (Definition of Done)
- [ ] 4장 매트릭스 전 칸 ✅
- [ ] 금지 목록 grep/리뷰 통과
- [ ] 확정 원인·수정·검증 결과를 `ROTATION_FIX_FINDINGS.md`에 **Finding #3**으로 기록

---

## 관련 문서
- `RESIZE_ANCHOR_ANALYSIS.md` — 증상 분석·판별 실험 (원본)
- `RESIZE_ANCHOR_FOLLOWUP.md` — 답변 판정·2차 합의 경위
- `ROTATION_FIX_FINDINGS.md` — 발견 로그 (Finding #1·#2, #3 예정)
- `ROTATION_FIX_PROPOSAL.md` — 프레임/스냅샷 계약 원칙

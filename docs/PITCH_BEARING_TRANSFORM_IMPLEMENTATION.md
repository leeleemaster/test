# Pitch/Bearing 도형 변환 구현 및 테스트

이 문서가 현재 `ShapeTester` 변환 동작의 기준 문서다. 기존 문서의 `pitch/bearing을 0으로 잠근다`는 제한은 제거되었다.

## 결론

- 카메라의 pitch/bearing은 평상시에 자유롭게 조작한다.
- 도형을 이동·회전·크기 조절하는 짧은 구간에만 MapLibre 카메라 입력을 임시 잠근다. pointer up/cancel, Escape, 창 focus 이탈 때 원래 활성 상태를 그대로 복구한다.
- 포인터는 `map.unproject()`로 지면(z=0)에 내리고, 변환은 지도 지면의 로컬 미터 OBB에서 계산한다.
- 그룹 비균일 크기 조절은 각 자식에 일반 2×2 live affine 행렬을 적용한다. 서로 다른 회전각의 자식도 앵커가 밀리거나 크기가 틀어지지 않는다.
- 매 pointer move는 드래그 시작 스냅샷으로부터 절대 계산한다. 프레임별 delta 누적은 하지 않는다.
- 핸들이 고정 앵커를 넘어가면 최소 크기에서 clamp하여 의도하지 않은 좌우/상하 반전을 막는다.

## 구현 위치

- UI 및 MapLibre 연동: `map-aabb/src/app/shape-tester.tsx`
- 전용 수동 테스트 화면: `map-aabb/src/app/pitch-bearing-tester.tsx`
- 순수 변환 수학: `map-aabb/src/app/transform-math.ts`
- 자동 회귀 테스트: `map-aabb/src/app/transform-math.test.ts`

## 수동 테스트 방법

프로젝트의 `package.json`은 `D:\MapTest_Project\maplibre-three-aabb`에 있다. 상위 폴더인 `D:\MapTest_Project`에서 바로 `npm run dev:web`을 실행하면 `package.json`을 찾을 수 없어 `ENOENT`가 발생한다.

저장소 폴더로 이동해서 실행:

```powershell
cd D:\MapTest_Project\maplibre-three-aabb
npm run dev:web
```

상위 폴더에 머문 상태로 실행:

```powershell
npm --prefix .\maplibre-three-aabb run dev:web
```

1. 위 명령 중 하나로 개발 서버를 실행한다.
2. 우측 상단의 **Pitch/Bearing 테스트** 탭을 연다.
3. 카메라 프리셋 `0/0`, `45/45`, `60/90`을 각각 선택한다.
4. 단일 도형에서 이동, 회전, 8개 크기 조절 핸들을 확인한다.
5. **혼합 회전 그룹 준비 (45° / -25°)**를 누른 뒤 그룹의 edge/corner 핸들을 비균일하게 조절한다.
6. 핸들을 바깥으로 늘렸다가 시작 지점으로 되돌려 위치와 형태가 복귀하는지 확인한다.
7. 변환 중에는 패널에 `카메라 임시 잠금`이 보이고, 놓는 즉시 `카메라 조작 가능`으로 복구되는지 확인한다.
8. 드래그 중 Escape를 누르면 시작 상태로 취소되고 카메라 조작이 복구되는지 확인한다.

### 합격 기준

- 반대편 앵커가 지면의 동일 위치에 유지된다.
- 고 pitch/bearing에서도 포인터와 핸들의 이동 방향이 일치한다.
- 그룹 내 회전각이 다른 도형이 비균일 확대될 때 정확한 affine 결과(필요한 전단 포함)가 나온다.
- 왕복 드래그 후 시작 위치·행렬로 돌아온다.
- 변환이 끝나거나 취소된 뒤 카메라 입력이 이전 활성 상태로 돌아온다.
- NaN, 무한대, 미러링, 크기 폭발이 발생하지 않는다.

## 자동 테스트

저장소 폴더에서 실행한다.

```powershell
cd D:\MapTest_Project\maplibre-three-aabb
npm run test:transforms
```

검증 항목은 앵커 불변, 왕복 복귀, 앵커 교차 clamp, 회전 자식의 parent-frame affine 일치, shear 상태 왕복이다.

## 설계상 의도한 동작

pitch가 있는 원근 투영에서는 같은 지면 길이라도 화면 위쪽과 아래쪽의 픽셀 길이가 다르다. 따라서 이 구현은 화면 픽셀 크기를 억지로 일정하게 만드는 방식이 아니라, 사용자가 가리킨 화면점을 지면에 역투영한 뒤 실제 지면 도형을 편집한다. 이 방식이 지도 객체의 위치·크기·회전을 일관되게 보존한다.

카메라와 객체를 동시에 움직이면 pointer ray와 기준 프레임이 매 순간 함께 바뀌어 변환 계약이 모호해진다. 그래서 카메라 자체를 영구 잠그지 않고, 객체 변환 트랜잭션 동안에만 입력을 막는다.

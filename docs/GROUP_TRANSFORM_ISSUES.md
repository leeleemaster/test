# 그룹 도형 회전/스케일 구현 방식별 문제 가이드

**환경:** MapLibre GL JS v4 + Three.js custom layer  
**구조:** 선택 사각형 → rotation/scale 전달 → 자식 도형들

각 항목은 **"이렇게 구현했을 때"** 어떤 문제가 생기는지를 기술합니다.

---

## A. dragStart 초기화

### A-1. `pointermove`에서 핸들 절대 각도를 `group.rotation`에 직접 대입한 경우

```javascript
// 이렇게 구현
onPointerMove(e) {
  const angle = Math.atan2(e.y - center.y, e.x - center.x);
  group.rotation.z = angle; // 절대 각도를 그대로 사용
}
```

**결과:** 드래그 시작 순간 그룹이 핸들 방향으로 순간이동(snap)  
**원인:** dragStart 시점의 핸들 각도와 그룹 초기 회전값을 기준으로 delta를 더해야 함

```javascript
// 올바른 구현
onPointerDown(e) {
  dragStart.handleAngle   = Math.atan2(e.y - center.y, e.x - center.x);
  dragStart.groupRotation = group.rotation.z;
}
onPointerMove(e) {
  const current = Math.atan2(e.y - center.y, e.x - center.x);
  group.rotation.z = dragStart.groupRotation + (current - dragStart.handleAngle);
}
```

---

### A-2. `pointermove`마다 현재 자식 위치에 변환을 누적 적용한 경우

```javascript
// 이렇게 구현 (수동 전달 방식)
onPointerMove(e) {
  const delta = computeDeltaAngle(e);
  children.forEach(c => {
    c.localPos = rotatePoint(c.localPos, delta); // 이전 결과에 또 회전
  });
}
```

**결과:** 드래그할수록 자식 도형들이 점점 잘못된 위치로 벗어남  
**원인:** 부동소수점 오차가 프레임마다 누산됨

```javascript
// 올바른 구현
onPointerDown(e) {
  dragStart.snapshots  = children.map(c => ({ ...c.localPos }));
  dragStart.baseAngle  = computeHandleAngle(e);
}
onPointerMove(e) {
  const total = computeHandleAngle(e) - dragStart.baseAngle;
  children.forEach((c, i) => {
    c.localPos = rotatePoint(dragStart.snapshots[i], total);
  });
}
```

---

### A-3. 스케일 비율을 매 프레임 현재 크기 기준으로 계산한 경우

```javascript
// 이렇게 구현
onPointerMove(e) {
  const currentH = group.scale.y * origHeight; // 이미 변형된 값
  const ratio    = newH / currentH;
  group.scale.y *= ratio; // 지수적으로 누산
}
```

**결과:** 드래그할수록 스케일이 지수적으로 커지거나 작아짐

```javascript
// 올바른 구현
onPointerDown(e) {
  dragStart.origScaleY = group.scale.y;
  dragStart.origHeight = selectionRect.height;
}
onPointerMove(e) {
  const newH = Math.abs(pointerWorldY - anchorEdgeWorldY);
  group.scale.y = dragStart.origScaleY * (newH / dragStart.origHeight);
}
```

---

## B. 핸들 위치 계산

### B-1. 핸들 위치를 `center ± halfSize`로 계산한 경우 (선택 사각형 회전 무시)

```javascript
// 이렇게 구현
const bottomHandle = {
  x: rect.centerX,
  y: rect.centerY + rect.halfHeight, // 선택 사각형 회전 무시
};
```

**결과:** 선택 사각형이 기울어진 상태에서 핸들 클릭 영역이 시각적 위치와 어긋남

```javascript
// 올바른 구현: 로컬 공간에서 계산 후 world 변환
const localBottom = { x: 0, y: rect.halfHeight };
const rotated     = rotatePoint(localBottom, rect.rotation);
const worldBottom = { x: rect.centerX + rotated.x, y: rect.centerY + rotated.y };
```

---

## C. 각도 및 Y축 보정

### C-1. Y축 보정을 `angle` 변수 자체에 부호 반전으로 적용한 경우

```javascript
// 이렇게 구현 (MAP 모드 Y 반전 처리 목적)
const angle = isMapMode ? -rawAngle : rawAngle;
const center = {
  x: handle.x - Math.cos(angle) * radius,
  y: handle.y - Math.sin(angle) * radius,
};
```

**결과:** 오른쪽으로 회전 시 90° 근방에서 그룹 전체가 왼쪽으로 점프  
**원인:** `sin(-angle) = -sin(angle)`이지만 `cos(-angle) = cos(angle)` — angle 부호를 바꿔도 cos 부호는 동일하나, 90° 초과 시 cos이 자연 반전되어 X 방향이 뒤집힘

```
0°~90°:  cos > 0 → center.x = handle.x - 양수 → 정상
90° 초과: cos < 0 → center.x = handle.x + 양수 → 반대 방향으로 점프
```

```javascript
// 올바른 구현: angle은 원본, Y 성분에만 ySign 적용
const angle = rawAngle;
const ySign = isMapMode ? -1 : 1;
const center = {
  x: handle.x - Math.cos(angle) * radius,
  y: handle.y - ySign * Math.sin(angle) * radius,
};
```

---

### C-2. `layerMatrix.scale(s, s, s)`로 Y 반전 없이 스케일한 경우

```javascript
// 이렇게 구현
layerMatrix.scale(new THREE.Vector3(scale, scale, scale));
```

**결과:** 도형 상하 반전, 회전 방향이 반대로 보임  
**원인:** Mercator Y는 위로 증가, 화면 Y는 아래로 증가 — Y 반전 필수

```javascript
// 올바른 구현
layerMatrix.scale(new THREE.Vector3(scale, -scale, scale));
```

---

### C-3. `group.rotation.z = angleDeg`로 도(degree) 단위를 직접 대입한 경우

```javascript
// 이렇게 구현
group.rotation.z = angleDeg; // 45° → 45 라디안 = 약 2578°
```

**결과:** 핸들을 조금 움직여도 도형이 여러 바퀴 회전

```javascript
// 올바른 구현
group.rotation.z = THREE.MathUtils.degToRad(angleDeg);
```

---

### C-4. 선택 사각형과 자식 간 각도 정규화 범위가 다른 경우

```javascript
// 이렇게 구현
// 선택 사각형: [0, 360) 정규화
// 자식:        (-180, 180] 정규화
// → 359°→1° 이동 시 delta = 1-359 = -358 → 반대 방향으로 360° 점프
```

**결과:** 회전이 0°/360° 경계를 넘는 순간 반대 방향으로 크게 점프

```javascript
// 올바른 구현: 전체에서 동일 정규화
const normalize = deg => ((deg % 360) + 360) % 360;
```

---

### C-5. `Math.atan2(dx, dy)` 인수 순서를 반전한 경우

```javascript
// 이렇게 구현
const angle = Math.atan2(
  pointer.x - center.x,  // dx 먼저 (반전)
  pointer.y - center.y   // dy 나중 (반전)
);
```

**결과:** 회전 핸들 드래그 시작부터 항상 90° 틀어진 상태  
**원인:** `Math.atan2(y, x)` — 첫 번째 인수가 dy, 두 번째가 dx

```javascript
// 올바른 구현
const angle = Math.atan2(
  pointer.y - center.y,  // dy 먼저
  pointer.x - center.x   // dx 나중
);
```

---

## D. 스케일 계산

### D-1. 리사이즈를 `group.scale.setScalar(distOrig / distNew)`로 구현한 경우

```javascript
// 이렇게 구현
const scale = distOrig / distNew; // ①비율 방향 반전, ②모든 축 적용
group.scale.setScalar(scale);
```

**결과:** 아래 핸들을 아래로 당기면 좌우도 함께 좁아짐  
**원인 ①:** `distOrig / distNew` — 멀어질수록 < 1 (방향 반전)  
**원인 ②:** `setScalar` — X, Y, Z 동시 적용

```javascript
// 올바른 구현
const scaleY = distNew / distOrig; // 멀어질수록 > 1
group.scale.set(1, scaleY, 1);     // Y축만
// 앵커(위쪽 엣지) 고정
group.position.y = anchorEdgeY + (scaleY - 1) * origHalfHeight;
```

---

### D-2. 회전된 그룹에 `group.scale.x = ratio`로 world 축 기준 스케일을 적용한 경우

```javascript
// 이렇게 구현
group.scale.x = newWidth / origWidth; // world X축 기준
```

**결과:** 선택 사각형이 기울어진 상태에서 좌우 핸들을 당기면 도형이 찌그러짐  
**원인:** group이 45° 기울어진 상태에서 world X 스케일은 로컬 X축(비스듬한 방향)과 불일치

```javascript
// 올바른 구현: 그룹 로컬 공간에서 자식 좌표 직접 재계산
children.forEach((c, i) => {
  const snap = dragStart.snapshots[i];
  c.localPos = { x: snap.x * scaleX, y: snap.y }; // 로컬 X만 스케일
});
```

---

### D-3. 음수 스케일 제한 없이 `newDist / origDist`를 그대로 적용한 경우

```javascript
// 이렇게 구현
const scaleY = newDist / origDist; // 반대편으로 넘어가면 음수
group.scale.set(1, scaleY, 1);
```

**결과:** 핸들을 반대편 너머로 드래그하면 도형이 뒤집히고 이후 핸들이 역방향으로 동작

```javascript
// 올바른 구현 (flip 허용 안 할 경우)
const scaleY = Math.max(0.01, newDist / origDist);

// flip 허용 시: 앵커 엣지도 함께 전환
if (newDist < 0) anchorEdge = oppositeEdge;
```

---

### D-4. meterScale을 `layerMatrix`와 `group.scale` 양쪽에 모두 적용한 경우

```javascript
// 이렇게 구현
const s = mercator.meterInMercatorCoordinateUnits();
layerMatrix.scale(new THREE.Vector3(s, -s, s)); // ①
group.scale.setScalar(s);                        // ② → 실제 scale = s²
```

**결과:** 도형이 극도로 작게 렌더링되거나 보이지 않음 (`s ≈ 1e-6` → `s² ≈ 1e-12`)

```javascript
// 올바른 구현: layerMatrix에만 적용, group.scale 건드리지 않음
```

---

## E. 자식 전달 방식

### E-1. 자식을 `group.add()` 대신 `scene.add()`로 추가한 경우

```javascript
// 이렇게 구현
scene.add(childMesh); // group의 자식이 아님
group.rotation.z = angle; // childMesh에 전달 안 됨
```

**결과:** group을 회전해도 특정 자식이 따라가지 않음

```javascript
// 올바른 구현
group.add(childMesh);
```

---

### E-2. 자식 각각에 그룹 rotation을 직접 대입한 경우

```javascript
// 이렇게 구현
children.forEach(c => c.rotation = groupRotation);
// 각 자식이 자신의 로컬 원점 기준으로 회전
```

**결과:** 각 도형이 제자리에서만 회전하고, 그룹 전체 위치는 변하지 않음

```javascript
// 올바른 구현: 그룹 중심 기준으로 자식 위치 재계산
children.forEach((c, i) => {
  c.localPos = rotatePoint(dragStart.snapshots[i], totalAngle);
});
```

---

### E-3. 선택 사각형은 절대값 전달, 자식은 delta로 누산한 경우

```javascript
// 이렇게 구현
// 선택 사각형: totalAngle (절대값)을 자식에 전달
children.forEach(c => c.rotation += totalAngle); // delta처럼 누산
```

**결과:** 조금 돌려도 도형이 여러 바퀴 회전

```javascript
// 올바른 구현: 방식 통일
children.forEach(c => c.rotation = totalAngle); // 절대값으로 설정
```

---

### E-4. 피벗을 선택 사각형 바운딩 박스 모서리로 설정한 경우

```javascript
// 이렇게 구현
const pivotX = selectionRect.x;       // top-left 모서리
const pivotY = selectionRect.y;
```

**결과:** 회전 시 그룹 전체가 한쪽으로 크게 이동

```javascript
// 올바른 구현
const pivotX = selectionRect.x + selectionRect.width  / 2;
const pivotY = selectionRect.y + selectionRect.height / 2;
```

---

### E-5. 회전 후 선택 사각형 바운딩 박스를 AABB로 재계산한 경우

```javascript
// 이렇게 구현
group.rotation.z = newAngle;
const aabb = computeAABB(children);    // 회전 후 더 큰 AABB
selectionRect.center = aabb.center;    // 중심이 이동
```

**결과:** 회전을 반복할수록 선택 사각형 중심이 조금씩 이동(드리프트)  
**원인:** 회전된 도형의 AABB 중심은 OBB 중심과 다름

```javascript
// 올바른 구현: 드래그 내내 초기 피벗 고정
onPointerDown(e) {
  dragStart.pivot = { ...selectionRect.center }; // 고정
}
// pointermove에서 dragStart.pivot을 피벗으로 사용
```

---

### E-6. 자식 오브젝트를 world(Mercator) 좌표로 배치하고 `group.add()`한 경우

```javascript
// 이렇게 구현
const merc = MercatorCoordinate.fromLngLat([lng, lat]);
child.position.set(merc.x, merc.y, 0); // world 좌표
group.add(child); // group도 Mercator 좌표로 이동 중 → 이중 변환
```

**결과:** group을 이동하면 자식이 두 배로 이동, group.rotation 시 엉뚱한 지점을 중심으로 회전  
**원인:** `group.add(child)` 후 `child.position`은 group의 로컬 공간 기준으로 해석됨

```javascript
// 올바른 구현: group.position을 피벗(중심)으로, 자식은 로컬 오프셋
group.position.set(centerMerc.x, centerMerc.y, 0);
child.position.set(localOffsetX, localOffsetY, 0); // 중심 기준 미터 오프셋
```

---

## F. Three.js 렌더링

### F-1. `group.updateMatrixWorld(true)`를 호출하지 않은 경우

```javascript
// 이렇게 구현
group.rotation.z = angleRad;
renderer.render(scene, camera); // matrixWorld 갱신 안 됨
```

**결과:** 자식 오브젝트 위치나 스프라이트 위치가 회전 후에도 갱신 안 됨

```javascript
// 올바른 구현
group.rotation.z = angleRad;
group.updateMatrixWorld(true);
renderer.render(scene, camera);
```

---

### F-2. `mesh.frustumCulled`를 기본값(true)으로 둔 경우

```javascript
// 이렇게 구현 (기본값 그대로)
const mesh = new THREE.Mesh(geometry, material);
// frustumCulled = true
```

**결과:** 특정 회전 각도에서 도형이 갑자기 사라짐  
**원인:** 회전 후 bounding sphere가 절두체 밖으로 판정

```javascript
// 올바른 구현
mesh.frustumCulled = false;
edges.frustumCulled = false;
```

---

### F-3. `camera.projectionMatrix = layerMatrix.multiply(mapMatrix)` 순서로 곱한 경우

```javascript
// 이렇게 구현 (순서 반전)
camera.projectionMatrix = layerMatrix.multiply(new THREE.Matrix4().fromArray(matrix));
```

**결과:** 도형이 완전히 엉뚱한 위치에 렌더링되거나 보이지 않음

```javascript
// 올바른 구현
camera.projectionMatrix = new THREE.Matrix4().fromArray(matrix).multiply(layerMatrix);
```

---

### F-4. `layerMatrix`에 회전까지 포함하고 `group.rotation`도 동시에 설정한 경우

```javascript
// 이렇게 구현
layerMatrix.multiply(new THREE.Matrix4().makeRotationZ(angle));
group.rotation.z = angle; // 이중 적용
```

**결과:** 설정한 각도의 2배로 회전

```javascript
// 올바른 구현: 회전은 group.rotation만, layerMatrix는 이동+스케일만
```

---

### F-5. `camera.matrixAutoUpdate`를 기본값(true)으로 둔 경우

```javascript
// 이렇게 구현
const camera = new THREE.Camera(); // matrixAutoUpdate = true 기본값
// render()마다 Three.js가 camera.position/quaternion 기준으로 projectionMatrix 재계산
// → MapLibre가 넘겨준 matrix 덮어씀
```

**결과:** 도형이 항상 화면 원점(0,0)에 렌더링되거나 보이지 않음

```javascript
// 올바른 구현
const camera = new THREE.Camera();
camera.matrixAutoUpdate = false;
// render()에서 직접 설정
camera.projectionMatrix = new THREE.Matrix4().fromArray(matrix).multiply(layerMatrix);
```

---

## G. MapLibre 연동

### G-1. `renderer.autoClear`를 기본값(true)으로 둔 경우

```javascript
// 이렇게 구현 (기본값 그대로)
const renderer = new THREE.WebGLRenderer({ canvas, context: gl });
```

**결과:** 지도 타일이 사라지고 배경이 검은색

```javascript
// 올바른 구현
renderer.autoClear = false;
```

---

### G-2. `renderer.resetState()`를 호출하지 않은 경우

**결과:** 도형이 지도 타일에 가려지거나 depth/blend 상태가 이상함

```javascript
// 올바른 구현: render() 시작 시 항상
renderer.resetState();
renderer.render(scene, camera);
```

---

### G-3. `map.triggerRepaint()`를 호출하지 않은 경우

**결과:** 드래그를 멈추면 화면이 갱신되지 않음. 지도를 직접 움직여야 반영됨

```javascript
// 올바른 구현: 상태 변경 시마다
rotationRef.current = newAngle;
map.triggerRepaint();
```

---

### G-4. `meterInMercatorCoordinateUnits()`를 `onAdd()`에서 한 번만 계산한 경우

```javascript
// 이렇게 구현
onAdd(map, gl) {
  this.meterScale = mercator.meterInMercatorCoordinateUnits(); // 고정값
}
```

**결과:** 지도를 멀리 이동하거나 줌 변경 시 도형 스케일이 어긋남

```javascript
// 올바른 구현: render()마다 현재 위치 기준으로 재계산
render(_gl, matrix) {
  const modelData = getTransformModelData(currentShape); // 매 프레임
}
```

---

### G-5. MapLibre v4 `render(gl, matrix)` 코드를 v5 환경에서 사용한 경우

```javascript
// 이렇게 구현 (v4 코드)
render(gl, matrix) {
  camera.projectionMatrix.fromArray(matrix); // v5에서 matrix = options 객체 → NaN
}
```

**결과:** v5 업그레이드 후 도형이 사라지거나 NaN 오류

```javascript
// v4: render(gl, matrix)           — matrix: Float64Array
// v5: render(gl, options)          — options.defaultProjectionData.mainMatrix
```

---

## H. 상태 관리

### H-1. React `useCallback(handler, [])`로 초기값을 캡처한 경우

```javascript
// 이렇게 구현
const handleRotate = useCallback((e) => {
  // rotation 초기값을 캡처한 채로 실행
  setRotation(computeAngle(e));
}, []); // 의존성 누락
```

**결과:** 드래그 중간에 회전이 이전 상태로 리셋됨

```javascript
// 올바른 구현
const handleRotate = useCallback((e) => {
  const delta = computeDelta(e, rotationRef.current);
  setRotation(r => r + delta);
}, []); // ref 사용으로 stale closure 회피
```

---

### H-2. `pointerup`에서 rotation을 초기값으로 리셋한 경우

```javascript
// 이렇게 구현
window.addEventListener('pointerup', () => {
  setDragState(null);
  setRotation(initialRotation); // 드래그 결과 버림
});
```

**결과:** 드래그 중에는 회전이 잘 되다가 손을 떼면 원래 각도로 돌아감

```javascript
// 올바른 구현: dragState만 null로, rotation은 유지
window.addEventListener('pointerup', () => setDragState(null));
```

---

### H-3. NaN 체크 없이 meterScale을 사용한 경우

```javascript
// 이렇게 구현
const scale = mercator.meterInMercatorCoordinateUnits();
layerMatrix.scale(new THREE.Vector3(scale, -scale, scale)); // NaN이면 전체 행렬 오염
```

**결과:** 특정 조건에서 모든 도형이 갑자기 사라짐

```javascript
// 올바른 구현
const scale = mercator.meterInMercatorCoordinateUnits();
if (!isFinite(scale) || scale <= 0) return;
```

---

### H-4. `pointermove`/`pointerup`을 핸들 element에만 등록한 경우

```javascript
// 이렇게 구현
handleEl.addEventListener('pointermove', onMove);
handleEl.addEventListener('pointerup',   onUp);
// 빠르게 드래그하면 포인터가 element 바깥으로 나가 이벤트 끊김
```

**결과:** 빠른 드래그 시 도형이 멈추고, 포인터를 놓아도 drag state가 계속 활성화  
**원인:** 포인터가 element 영역을 벗어나면 `pointermove`/`pointerup` 미전달

```javascript
// 올바른 구현
handleEl.addEventListener('pointerdown', (e) => {
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp, { once: true });
  // 또는: e.currentTarget.setPointerCapture(e.pointerId)
});
```

---

## 모드 개념 정리

```
MAP 모드 (지도 고정):
  - 화면 Y ↓ 증가 vs Mercator Y ↑ 증가 → Y축 반전
  - 위치 벡터의 Y 성분에만 ySign = -1 적용
  - angle 변수 부호 자체를 반전하면 cos(angle)까지 영향 → 금지

화면 고정 모드 (viewport-aligned):
  - layerMatrix의 scale(s, -s, s)가 Y 반전 처리
  - 코드에서 별도 Y 보정 불필요

모드 전환 시:
  - 기존 rotation 값을 새 좌표계 기준으로 보정해야 함
  - 보정 없이 전환하면 도형이 반전된 것처럼 보임
```

---

## 구현 체크리스트

**dragStart (pointerdown)**
- [ ] `dragStart.handleAngle` 저장
- [ ] `dragStart.groupRotation` 저장
- [ ] `dragStart.childSnapshots` 저장 (수동 전달 방식일 때)
- [ ] `dragStart.origSize` 저장 (스케일 핸들용)
- [ ] `dragStart.pivot` 저장 (드래그 내내 고정)

**transform 계산 (pointermove)**
- [ ] `group.rotation = dragStart.groupRotation + delta` (절대값)
- [ ] 핸들 위치: `rotatePoint(localOffset, rect.rotation) + center`
- [ ] `Math.atan2(dy, dx)` 순서 확인 (dx, dy 반전 시 90° 오프셋)
- [ ] Y 보정: `ySign = isMapMode ? -1 : 1`, angle 부호 반전 금지
- [ ] 단축 리사이즈: `scale.set(1, newDist/origDist, 1)` (setScalar 금지)
- [ ] 비균일 스케일: 그룹 로컬 공간 기준
- [ ] 음수 스케일 방지: `Math.max(MIN_SCALE, ratio)`
- [ ] AABB 재계산으로 pivot 갱신 금지

**자식 전달**
- [ ] `group.add(child)` (scene.add 금지)
- [ ] 자식 `position`은 group 로컬 공간 기준 (world 좌표 직접 대입 금지)
- [ ] `dragStart.snapshots[i]` 기준 절대 변환 (누산 금지)
- [ ] delta/absolute 방식 전체 통일

**Three.js 렌더**
- [ ] `camera.matrixAutoUpdate = false`
- [ ] `layerMatrix`: `scale(s, -s, s)` Y 반전 포함
- [ ] `camera.projectionMatrix = fromArray(matrix).multiply(layerMatrix)`
- [ ] `group.updateMatrixWorld(true)` 매 render()
- [ ] `mesh.frustumCulled = false`
- [ ] `renderer.autoClear = false`
- [ ] `renderer.resetState()` render() 시작 시
- [ ] `map.triggerRepaint()` 상태 변경 시
- [ ] `meterInMercatorCoordinateUnits()` 매 프레임 재계산
- [ ] `isFinite(scale) && scale > 0` NaN 방어
- [ ] MapLibre v4/v5 render 시그니처 확인

**이벤트 등록**
- [ ] `pointermove`/`pointerup`은 `window`에 등록 (element에만 등록 금지)
- [ ] `pointerup`에서 window 핸들러 제거

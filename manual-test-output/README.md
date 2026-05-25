# Manual Test Output

이 폴더는 Word 문서 Markdown 변환기를 실제 문서로 검증한 결과물을 모아둔 곳입니다.

## 폴더 구성

### `public-docx-samples/`

- 원본 테스트 입력 파일을 보관합니다.
- 현재 포함 파일:
  - `대원제약 입사지원서 2017.12.6.docx`

### `daewon-application/`

- 위 Word 문서를 변환한 결과를 보관합니다.
- 포함 파일:
  - `대원제약 입사지원서 2017.12.6.md`
    - 변환기에서 직접 생성한 원본 Markdown 결과물입니다.
    - Word의 복잡한 표 구조를 최대한 보존하기 위해 일부 표는 HTML 형태로 남아 있을 수 있습니다.
  - `대원제약 입사지원서 2017.12.6.readable.md`
    - Markdown 미리보기에서 읽기 쉽도록 별도로 정리한 문서입니다.
    - 이미지와 주요 섹션을 README처럼 보기 좋게 배치했습니다.
  - `대원제약 입사지원서 2017.12.6-assets/`
    - 변환 과정에서 추출되거나 별도 보정한 이미지 파일을 저장합니다.

## 어떤 파일을 보면 되는가

- 문서 원형에 가깝게 확인하려면 `daewon-application/대원제약 입사지원서 2017.12.6.md`
- 사람이 읽기 좋은 형태로 확인하려면 `daewon-application/대원제약 입사지원서 2017.12.6.readable.md`

## 확인 방법

VS Code에서 아래 파일을 연 뒤 Markdown Preview로 보면 됩니다.

- `manual-test-output/daewon-application/대원제약 입사지원서 2017.12.6.readable.md`

권장 방식:

1. 파일 열기
2. `Ctrl+Shift+V`로 Markdown Preview 열기
3. 이미지 렌더링과 표 배치를 확인하기

## 재생성 방법

저장소 루트에서 아래 명령으로 원본 변환 결과를 다시 생성할 수 있습니다.

```powershell
npm run word:md -- "manual-test-output/public-docx-samples/대원제약 입사지원서 2017.12.6.docx" "manual-test-output/daewon-application/대원제약 입사지원서 2017.12.6.md" --images-dir "manual-test-output/daewon-application/대원제약 입사지원서 2017.12.6-assets"
```

## 사용 시 주의사항

- 자동 변환기는 원본 Word 구조를 최대한 보존하는 쪽에 가깝습니다.
- 병합 셀, 중첩 표 같은 GitHub Flavored Markdown으로 표현하기 어려운 구조는 HTML로 남길 수 있습니다.
- `readable.md`는 자동 변환 산출물을 기반으로 사람이 읽기 좋게 별도로 정리한 문서이므로, 원본 `.md`를 다시 생성한 뒤에는 필요하면 함께 업데이트해야 합니다.
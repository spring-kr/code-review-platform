# Code Review Platform

> 서버 없이 브라우저만으로 동작하는 정적 코드 분석 + 크로스파일 의존성 분석 도구

![License](https://img.shields.io/badge/license-MIT-green)
![Languages](https://img.shields.io/badge/languages-17%2B-blue)
![No Build](https://img.shields.io/badge/build-none-lightgrey)
![Browser](https://img.shields.io/badge/runs%20in-browser-green)

---

## 개요

코드 파일(또는 프로젝트 폴더)을 업로드하면 **Web Worker** 위에서 비동기 분석이 실행됩니다.  
파일별 품질 메트릭을 계산하는 동시에, 파일 간 의존성 그래프를 구성해 순환 참조·깨진 import·함수 중복 등 프로젝트 수준의 이슈를 탐지합니다.

---

## 주요 기능

### 파일 분석

- **복잡도** — 함수당 분기 밀도 기반으로 측정. f-string·문자열 내부 키워드를 자동 제거해 Python 오탐 방지
- **중첩 깊이** — Python은 블록 키워드 들여쓰기 기준, JS/TS는 `{}` 카운트 기준으로 언어별 분리 측정
- **버그 신호** — SQL 인젝션·XSS·셸 인젝션·하드코딩 비밀값·프로토타입 오염 등 20+ 패턴
- **언어별 전용 탐지** — Python: `datetime.utcnow()` deprecated, `except:` bare except, 함수 내부 임포트, 가변 전역 dict / JS/TS: `any` 타입, `==` 느슨한 비교, 빈 catch
- **중복 파일 탐지** — djb2 콘텐츠 해시로 동일 파일 감지 (CRLF·trailing whitespace 정규화)
- **성능·유지보수성·문서화·테스트 품질** — 각 지표 0-100점

### 크로스파일 분석 (프로젝트 폴더 업로드 시)

| 탐지 항목 | 설명 |
|---|---|
| **순환 의존성** | DFS 기반 cycle detection — `A → B → C → A` 패턴 |
| **깨진 import** | `import {foo} from './bar'` 했지만 `bar`에 `foo` export 없음 |
| **God File** | 5개 이상 파일이 의존하는 중심 모듈 |
| **함수 중복** | 동일 이름 공개 함수가 2개 이상 파일에 정의 |
| **미사용 export** | 내보냈지만 프로젝트 내 어디서도 import되지 않음 |
| **과도한 의존** | 8개 이상 내부 파일에 직접 의존 |

### 함수 단위 테스트 커버리지

테스트 파일(`*.test.js`, `test_*.py`, `*.spec.ts`, `*Test.java` 등)을 소스와 함께 업로드하면:

1. 소스 파일에서 공개 함수 이름을 추출
2. 테스트 파일에서 해당 이름이 참조되는 비율 계산
3. 파일별 함수 커버리지 + 프로젝트 전체 커버리지 표시

> 실제 라인 커버리지는 Jest·pytest 등 테스트 러너가 필요합니다. 이 도구는 함수 참조 기반 추정치를 제공합니다.

### 리팩토링 엔진 (자동 코드 변환)

규칙 기반 자동 변환 — 변환 내역은 파일 상단 주석으로 기록됩니다.

**Python**
- `datetime.utcnow()` → `datetime.now(timezone.utc)` + import 자동 추가
- `Model.query.get(id)` → `db.session.get(Model, id)` (SQLAlchemy 2.x)
- `except:` → `except Exception as e:`
- `print(...)` → `logger.info(...)`
- `hashlib.md5/sha1` → `sha256`
- `os.system(...)` → `subprocess.run(...)`
- `__all__` 자동 추가

**JavaScript / TypeScript**
- `var` → `let`
- `==` → `===`
- `console.log` 주석 처리
- CommonJS 파일 상단에 `'use strict'` 추가

---

## 빠른 시작

```bash
git clone https://github.com/spring-kr/code-review-platform.git
cd code-review-platform
python -m http.server 8000
# → http://localhost:8000
```

빌드 과정 없음. Node.js도 불필요합니다.

---

## 사용 방법

### 1. 파일 업로드

- **개별 파일**: 업로드 영역 클릭 또는 드래그 & 드롭
- **프로젝트 폴더**: "프로젝트 폴더 선택" 버튼 — 크로스파일 분석까지 실행됩니다
- 1MB 초과 파일은 자동 제외

분석은 **Web Worker**에서 실행되므로 업로드 중에도 UI가 멈추지 않습니다.

### 2. 대시보드

파일을 선택하면 9개 메트릭 카드와 모든 findings가 표시됩니다.

### 3. 프로젝트 탭

크로스파일 분석 결과 및 함수 커버리지 요약을 확인합니다.  
상단 탭에 `프로젝트 (N)` 형식으로 이슈 수가 표시됩니다.

### 4. 코드 리뷰

파일별 심각도 코멘트 작성, 필터링, 정렬을 지원합니다.

### 5. 리팩토링

"리팩토링 적용" 버튼으로 자동 변환된 코드를 다운로드합니다.

### 6. 리포트 다운로드

JSON · CSV · HTML 형식으로 분석 결과를 내보냅니다.

---

## 메트릭 기준

| 메트릭 | 범위 | 목표 | 계산 방식 |
|---|---|---|---|
| 복잡도 | 0-100 | < 40 | 함수당 분기수 × 6 + 중첩깊이 × 6 + ... |
| 테스트가능성 | 0-100 | > 65 | 테스트 신호 + 함수 커버리지 가중 평균 |
| 버그 위험도 | 0-99 | < 5 | 탐지된 버그 패턴 수 + 복잡도 보정 |
| 성능 | 0-100 | > 60 | 중첩 루프 · 동기 I/O · 긴 줄 패널티 |
| 유지보수성 | 0-100 | > 70 | 복잡도 · 중복 · 파일 크기 역산 |
| 문서화 | 0-100 | > 60 | 주석 비율 + docstring 가산 |
| 테스트 품질 | 0-100 | > 75 | assert/expect 신호 밀도 |
| 의존성 | 개수 | 낮게 | 외부 import 수 |
| 품질 점수 | 0-100 | > 70 | 위 지표의 가중 평균 |

---

## 파일 구조

```
code-review-platform/
├── index.html              # 진입점 (CSP 헤더 포함)
├── app.js                  # UI · 상태 관리 · Worker 오케스트레이션
├── analysis.worker.js      # Web Worker — 파일 분석 + 크로스파일 분석
├── styles.css              # 다크모드 · 반응형 · 접근성 스타일
├── LICENSE                 # MIT 라이선스
└── README.md
```

**`analysis.worker.js`** 는 메인 스레드와 완전히 분리되어 DOM에 접근하지 않습니다.  
`app.js`는 Worker에 `{ type: "ANALYZE", files, thresholds }` 메시지를 보내고  
`{ type: "DONE", analyzed, crossFileIssues, coverageSummary }` 응답을 받습니다.

---

## 지원 언어

Python · JavaScript · TypeScript · Java · C++ · C · C# · Go · Rust · Ruby · PHP · Swift · Kotlin · Scala · SQL · Shell · HTML · CSS · JSON · YAML · Markdown

---

## 현재 한계

| 항목 | 상태 |
|---|---|
| 파일 크기 | 1MB/파일 제한 |
| AST 커버리지 | JS/TS · Python만 토큰 AST 지원, 나머지 언어는 정규식 폴백 |
| 클래스 메서드 감지 | `function` 키워드 없는 클래스 메서드는 함수로 미추적 (복잡도는 집계됨) |
| 테스트 커버리지 | 함수 참조 추정 (실제 라인 커버리지 아님 — Jest·pytest 등 필요) |
| 실시간 협업 | 미지원 (localStorage 단독 사용) |
| 새로고침 후 대용량 파일 | 50KB 초과 파일의 원본 코드는 재업로드 필요 |
| Python import 해석 | 상대 경로 임포트 크로스파일 분석 미지원 |

---

## 기술 스택

- **런타임**: 브라우저 네이티브 (빌드 도구 없음)
- **분석 엔진**: Web Worker + 언어별 토큰 기반 AST 분석기 (외부 파서 의존성 없음)
  - **JS/TS**: 캐릭터 레벨 토크나이저 — 문자열·정규식 리터럴·주석 정확 처리, 실제 사이클로매틱 복잡도
  - **Python**: 라인 레벨 상태 기계 — 트리플쿼트·들여쓰기 추적, 함수별 독립 복잡도 측정
- **차트**: 순수 SVG (외부 라이브러리 없음)
- **저장**: localStorage (가벼운 상태만 직렬화)
- **보안**: CSP `script-src 'self'` 적용

---

## 라이선스

[MIT](LICENSE) 라이선스에 따라 자유롭게 사용, 수정, 배포할 수 있습니다.

---

## 기여하기

1. 이 저장소를 포크합니다.
2. 기능 브랜치를 생성합니다 (`git checkout -b feature/my-feature`).
3. 변경사항을 커밋합니다 (`git commit -am 'Add my feature'`).
4. 브랜치에 푸시합니다 (`git push origin feature/my-feature`).
5. Pull Request를 생성합니다.

버그 제보와 기능 제안은 [Issues](https://github.com/spring-kr/code-review-platform/issues) 탭을 이용해 주세요.

코드 스타일은 기존 코드의 스타일을 따릅니다. 외부 라이브러리 의존성을 추가하는 PR은 신중히 검토합니다 — 이 프로젝트의 핵심 가치는 **제로 의존성**입니다.
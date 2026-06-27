---
name: "review-reverify"
description: "Code Review Platform의 산출물(분석 findings, 리팩토링 코드, 크로스파일 이슈, 메트릭, 리포트)을 한 번 더 검증해 오류·누락·부정합을 찾고 재생산한다. Use when user says 다시 검증, 재확인, 이중 검증, 산출물 점검, audit output"
applyTo: "**/.claude/skills/review-reverify/SKILL.md, **/.github/instructions/review-reverify.instructions.md"
---

# review-reverify

## 개요

Code Review Platform(`analysis.worker.js` + `app.js`)이 생성한 산출물을 두 번째 관점에서 검증하고, 문제 발견 시 재생산합니다.

## 사용법

1. 이 스킬은 사용자가 "@review-reverify", "다시 검증", "재확인", "산출물 점검"을 말하면 활성화됩니다.
2. `.claude/skills/review-reverify/SKILL.md`의 전체 지침을 따라 6개 Phase를 순차 실행합니다.

## Phase 요약

| Phase | 설명 |
|-------|------|
| Phase 0 | 산출물 수집 및 맥락 파악 |
| Phase 1 | Findings 검증 (오탐/미탐 진단) |
| Phase 2 | 리팩토링 코드 검증 (정확성/부작용/일관성) |
| Phase 3 | 크로스파일 이슈 검증 |
| Phase 4 | 메트릭 검증 (이상치/크로스 검증) |
| Phase 5 | 재생산 (문제 수정된 산출물 생성) |
| Phase 6 | 결과 보고 |

## 핵심 규칙

- 변경 전 원본을 반드시 백업
- 모든 판정에 코드 기반 근거 기록
- 재생산은 검증된 문제로만 한정
- 코어 시스템 코드(`analysis.worker.js`, `app.js`, `styles.css`)를 직접 수정하지는 않지만, 분석 엔진 자체의 체계적 결함(일관된 오탐/미탐 패턴)이 발견되면 사용자에게 보고
- 미확인 추정으로 finding 추가 금지
- 재생산 후 원본과 diff 확인

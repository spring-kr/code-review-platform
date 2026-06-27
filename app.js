const STORAGE_KEY = "code-review-platform-v3";
const STORAGE_KEY_LEGACY = "code-review-platform-v2";
const APP_VERSION = "3.0.0";
const SCHEMA_VERSION = 1;

const DEFAULT_THRESHOLDS = {
  complexityWarn: 55, complexityCrit: 75,
  coverageLow: 40,    coverageWarn: 65,
  bugsWarn: 5,        bugsCrit: 8,
  maintainabilityLow: 55,
  performanceLow: 55,
  documentationLow: 35,
  testQualityLow: 75,
};

const LANGUAGE_MAP = {
  py: "Python",
  js: "JavaScript",
  jsx: "JavaScript",
  ts: "TypeScript",
  tsx: "TypeScript",
  java: "Java",
  cpp: "C++",
  cc: "C++",
  cxx: "C++",
  c: "C",
  h: "C/C++ Header",
  hpp: "C++ Header",
  cs: "C#",
  go: "Go",
  rs: "Rust",
  rb: "Ruby",
  php: "PHP",
  swift: "Swift",
  kt: "Kotlin",
  kts: "Kotlin",
  scala: "Scala",
  sc: "Scala",
  sql: "SQL",
  sh: "Shell",
  ps1: "PowerShell",
  html: "HTML",
  css: "CSS",
  json: "JSON",
  yml: "YAML",
  yaml: "YAML",
  md: "Markdown"
};

const COLOR_SET = ["#127c7c", "#5965c8", "#c47a00", "#9b4d82", "#4d7c0f", "#b91c1c", "#4f46e5", "#0f766e"];

const METRIC_DEFS = [
  { key: "qualityScore", label: "품질 점수", target: "70+", good: "high" },
  { key: "complexity", label: "복잡도", target: "< 40", good: "low" },
  { key: "coverage", label: "테스트가능성", target: "60+", good: "high" },
  { key: "bugs", label: "버그 위험", target: "< 5", good: "low" },
  { key: "performance", label: "성능", target: "60+", good: "high" },
  { key: "maintainability", label: "유지보수성", target: "70+", good: "high" },
  { key: "documentation", label: "문서화", target: "60+", good: "high" },
  { key: "testQuality", label: "테스트 품질", target: "75+", good: "high" },
  { key: "dependencies", label: "의존성", target: "낮게", good: "low" }
];

const SAMPLE_FILES = [
  {
    name: "payment_service.py",
    content: `import requests
import os

class PaymentService:
    def charge(self, user, order):
        api_key = os.getenv("PAYMENT_KEY")
        if not user:
            raise ValueError("user is required")
        if order.total <= 0:
            return False
        try:
            for item in order.items:
                if item.quantity > 20:
                    if item.category == "restricted":
                        return False
            response = requests.post("/charge", json={"id": user.id, "total": order.total})
            return response.status_code == 200
        except Exception:
            return False

def normalize_amount(amount):
    if amount is None:
        return 0
    return round(float(amount), 2)
`
  },
  {
    name: "review-engine.ts",
    content: `type Finding = { severity: "critical" | "high" | "medium" | "low"; message: string };

export function scoreFindings(findings: Finding[]) {
  return findings.reduce((score, finding) => {
    if (finding.severity === "critical") return score - 25;
    if (finding.severity === "high") return score - 12;
    if (finding.severity === "medium") return score - 6;
    return score - 2;
  }, 100);
}

export function groupBySeverity(findings: Finding[]) {
  const groups: Record<string, Finding[]> = {};
  for (const finding of findings) {
    groups[finding.severity] = groups[finding.severity] || [];
    groups[finding.severity].push(finding);
  }
  return groups;
}
`
  },
  {
    name: "payment_service.test.py",
    content: `from payment_service import normalize_amount

def test_normalize_amount_handles_none():
    assert normalize_amount(None) == 0

def test_normalize_amount_rounds_decimal():
    assert normalize_amount(19.999) == 20.0
`
  }
];

const initialState = {
  activeTab: "upload",
  files: [],
  selectedFileId: null,
  reviews: [],
  versions: [],
  severityFilter: "all",
  reviewSort: "newest",
  searchTerm: "",
  statusMessage: "파일을 업로드하거나 샘플 프로젝트를 불러오세요.",
  pendingSeverity: "medium",
  thresholds: { ...DEFAULT_THRESHOLDS },
  theme: "light",
  schemaVersion: SCHEMA_VERSION,
  crossFileIssues: [],
  coverageSummary: {},
};

let state = loadState();
if (!state.crossFileIssues) state.crossFileIssues = [];
if (!state.coverageSummary) state.coverageSummary = {};

const root = document.getElementById("app");

// ── Web Worker 관리 ──────────────────────────────────────────────────
let _worker = null;
function getWorker() {
  if (_worker) return _worker;
  try { _worker = new Worker("analysis.worker.js"); } catch (_) { _worker = null; }
  return _worker;
}

function runWorkerAnalysis(fileDataList, onDone) {
  const worker = getWorker();
  if (!worker) { onDone(null, "Worker를 생성할 수 없습니다."); return; }

  const total = fileDataList.length;
  worker.onmessage = ({ data }) => {
    if (data.type === "PROGRESS") {
      showLoading(`파일 분석 중... ${data.current}/${data.total}  (${data.fileName.split(/[/\\]/).pop()})`);
    } else if (data.type === "DONE") {
      onDone(data, null);
    }
  };
  worker.onerror = (err) => onDone(null, err.message || "Worker 오류");
  worker.postMessage({ type: "ANALYZE", files: fileDataList, thresholds: state.thresholds });
  showLoading(`분석 준비 중... (0/${total})`);
}

applyTheme(state.theme);
initGlobalErrorHandlers();
initKeyboardShortcuts();

render();

function loadState() {
  try {
    let raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const legacy = localStorage.getItem(STORAGE_KEY_LEGACY);
      if (legacy) raw = legacy;
    }
    const stored = JSON.parse(raw);
    if (!stored || !Array.isArray(stored.files)) return { ...initialState };
    const merged = {
      ...initialState,
      ...stored,
      activeTab: stored.activeTab || "upload",
      pendingSeverity: stored.pendingSeverity || "medium",
      thresholds: { ...DEFAULT_THRESHOLDS, ...(stored.thresholds || {}) },
      theme: stored.theme || "light",
      schemaVersion: SCHEMA_VERSION,
    };
    if (!Array.isArray(merged.reviews)) merged.reviews = [];
    if (!Array.isArray(merged.versions)) merged.versions = [];
    return merged;
  } catch {
    return { ...initialState };
  }
}

function persistState() {
  try {
    const lightweight = {
      ...state,
      files: state.files.map((file) => ({
        name: file.name,
        relativePath: file.relativePath,
        size: file.size,
        // localStorage 용량 문제로 50000자(약 50KB)로 제한, 대형 파일은 내용 저장 안함
        content: file.content?.length > 50000 ? '' : (file.content || '')
      })),
      statusMessage: state.statusMessage
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(lightweight));
  } catch (e) {
    // 용량 초과 시 오류 무시하고 상태 저장 스킵 - 앱 크래시 방지
    console.warn('localStorage 용량 초과로 상태를 저장할 수 없습니다.', e);
  }
}

function render() {
  try {
    root.innerHTML = `
      <section class="app-shell">
        ${renderHero()}
        ${renderTabs()}
        <section class="workspace">
          ${renderActiveTab()}
        </section>
      </section>
    `;
    bindEvents();
  } catch (err) {
    console.error("[CodeReview] render error:", err);
    root.innerHTML = `
      <div class="error-boundary" role="alert" aria-live="assertive">
        <h2>렌더링 오류</h2>
        <p>${escapeHtml(err.message || "알 수 없는 오류가 발생했습니다.")}</p>
        <div style="display:flex;gap:10px;">
          <button class="button" id="reloadBtn">새로고침</button>
          <button class="button secondary" id="resetStateBtn">상태 초기화</button>
        </div>
      </div>
    `;
    document.getElementById("reloadBtn")?.addEventListener("click", () => location.reload());
    document.getElementById("resetStateBtn")?.addEventListener("click", () => {
      localStorage.removeItem(STORAGE_KEY);
      location.reload();
    });
  }
}
function renderHero() {
  const summary = getSummary();
  const health = getPortfolioHealth(summary);
  return `
    <header class="hero">
      <div>
        <p class="eyebrow">Browser native code intelligence</p>
        <h1>Code Review Platform</h1>
        <p class="hero-copy">
          여러 언어의 코드 파일을 업로드하면 복잡도, 테스트 신호, 버그 위험, 유지보수성, 리뷰 코멘트를 한 화면에서 추적합니다.
        </p>
      </div>
      <div class="hero-panel" aria-label="프로젝트 상태 요약">
        <span class="status-pill ${health.tone}">${health.label}</span>
        <strong>${summary.totalFiles}</strong>
        <span>분석된 파일</span>
        <small>평균 품질 ${formatNumber(summary.avgQuality)}점</small>
      </div>
    </header>
  `;
}

function renderTabs() {
  const crossCount = (state.crossFileIssues || []).length;
  const tabs = [
    ["upload", "업로드"],
    ["dashboard", "대시보드"],
    ["visuals", "시각화"],
    ["reviews", "코드 리뷰"],
    ["project", `프로젝트${crossCount ? ` (${crossCount})` : ""}`],
    ["versions", "버전 관리"],
    ["settings", "설정"]
  ];
  return `
    <nav class="tabs" aria-label="주요 메뉴">
      ${tabs
        .map(
          ([id, label]) => `
            <button class="tab ${state.activeTab === id ? "active" : ""}" data-tab="${id}" type="button">
              ${label}
            </button>
          `
        )
        .join("")}
    </nav>
  `;
}

function renderActiveTab() {
  if (state.activeTab === "dashboard") return renderDashboard();
  if (state.activeTab === "visuals") return renderVisuals();
  if (state.activeTab === "reviews") return renderReviews();
  if (state.activeTab === "project") return renderProject();
  if (state.activeTab === "versions") return renderVersions();
  if (state.activeTab === "settings") return renderSettings();
  return renderUpload();
}

function renderUpload() {
  const accept = Object.keys(LANGUAGE_MAP)
    .map((extension) => `.${extension}`)
    .join(",");

  return `
    <section class="layout-two">
      <div class="panel">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Input</p>
            <h2>코드 파일 업로드</h2>
          </div>
          <button class="button secondary" id="loadSampleBtn" type="button">샘플 불러오기</button>
        </div>
        <div class="upload-zone" id="uploadZone" role="button" tabindex="0" aria-label="파일 업로드 영역">
          <input id="fileInput" type="file" multiple accept="${accept}" style="display:none" />
          <input id="folderInput" type="file" webkitdirectory multiple style="display:none" />
          <span class="upload-mark">+</span>
          <strong>파일/프로젝트 폴더를 선택하거나 이 영역에 끌어오세요.</strong>
          <small>Python, JavaScript, TypeScript, Java, C++, C#, Go, Rust 등 주요 언어를 지원합니다. 전체 프로젝트 폴더 업로드도 가능!</small>
        </div>
        <div class="action-row">
          <button class="button secondary" id="selectFilesBtn" type="button">개별 파일 선택</button>
          <button class="button secondary" id="selectFolderBtn" type="button">📁 프로젝트 폴더 선택</button>
          <button class="button secondary" id="clearWorkspaceBtn" type="button">작업공간 비우기</button>
          <button class="button" data-save-snapshot type="button" ${state.files.length ? "" : "disabled"}>현재 분석 저장</button>
        </div>
        <p class="status-text">${escapeHtml(state.statusMessage)}</p>
      </div>
      <div class="panel compact-panel">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Coverage</p>
            <h2>지원 언어</h2>
          </div>
        </div>
        <div class="language-cloud">
          ${[...new Set(Object.values(LANGUAGE_MAP))]
            .filter((language) => !["C/C++ Header", "C++ Header", "YAML", "JSON", "Markdown"].includes(language))
            .map((language) => `<span>${language}</span>`)
            .join("")}
        </div>
      </div>
    </section>
    ${renderFileTable()}
  `;
}

function renderDashboard() {
  if (!state.files.length) return renderEmptyState("아직 분석된 파일이 없습니다.", "업로드 탭에서 코드 파일을 추가하면 대시보드가 채워집니다.");
  let selected = getSelectedFile();
  // selected가 null이면 첫 번째 파일을 자동으로 선택
  if (!selected) {
    selected = state.files[0];
    state.selectedFileId = selected.id;
  }
  const summary = getSummary();
  return `
    <section class="summary-strip">
      ${renderStat("파일", summary.totalFiles)}
      ${renderStat("총 라인", summary.totalLines)}
      ${renderStat("평균 복잡도", formatNumber(summary.avgComplexity))}
      ${renderStat("평균 테스트가능성", formatNumber(summary.avgCoverage))}
      ${renderStat("리뷰", summary.totalReviews)}
    </section>

    <section class="layout-two wide-first">
      <div class="panel">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Dashboard</p>
            <h2>${escapeHtml(selected.name)}</h2>
          </div>
          <div style="display:flex;align-items:center;gap:10px">
            <span class="status-pill ${getRiskTone(selected.metrics)}">${getRiskLabel(selected.metrics)}</span>
            <button class="button ghost small" id="printReportBtn" type="button" title="PDF 인쇄">🖨 PDF</button>
          </div>
        </div>
        <div class="metric-grid">
          ${METRIC_DEFS.map((metric) => renderMetricCard(selected, metric)).join("")}
        </div>
        <div class="quality-gates">
          ${renderQualityGate("복잡도", (selected.metrics?.complexity ?? 50) <= 40)}
          ${renderQualityGate("테스트가능성", (selected.metrics?.coverage ?? 50) >= 60)}
          ${renderQualityGate("유지보수성", (selected.metrics?.maintainability ?? 60) >= 70)}
          ${renderQualityGate("테스트 품질", (selected.metrics?.testQuality ?? 60) >= 75)}
        </div>
      </div>
      <div class="panel">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Files</p>
            <h2>분석 목록</h2>
          </div>
        </div>
        <div class="filter-row">
          <input class="search-input" id="searchInput" value="${escapeAttribute(state.searchTerm)}" placeholder="파일명 또는 언어 검색" />
        </div>
        ${renderFileSelector()}
      </div>
    </section>

    <section class="layout-two">
      <div class="panel">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Findings</p>
            <h2>자동 분석 제안</h2>
          </div>
        </div>
        ${renderFindings(selected)}
      </div>
      <div class="panel">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Source</p>
            <h2>코드 미리보기</h2>
          </div>
        </div>
        <pre class="code-preview"><code>${escapeHtml(selected.content.slice(0, 5000))}</code></pre>
      </div>
    </section>
  `;
}

function renderVisuals() {
  if (!state.files.length) return renderEmptyState("시각화할 데이터가 없습니다.", "샘플 프로젝트를 불러오거나 코드 파일을 업로드하세요.");
  const summary = getSummary();
  return `
    <section class="summary-strip">
      ${renderStat("평균 품질", formatNumber(summary.avgQuality))}
      ${renderStat("평균 성능", formatNumber(summary.avgPerformance))}
      ${renderStat("총 버그 위험", summary.totalBugs)}
      ${renderStat("언어 수", summary.languageCount)}
    </section>
    <section class="chart-grid">
      <div class="panel">${renderComplexityChart()}</div>
      <div class="panel">${renderCoverageTrend()}</div>
      <div class="panel">${renderLanguageDistribution()}</div>
      <div class="panel">${renderScatterChart()}</div>
      <div class="panel span-two">${renderBugDocumentationChart()}</div>
      <div class="panel">${renderQualityRadar()}</div>
    </section>
  `;
}

function renderReviews() {
  if (!state.files.length) return renderEmptyState("리뷰할 파일이 없습니다.", "먼저 코드를 업로드한 뒤 파일별 리뷰 코멘트를 작성하세요.");
  const selected = getSelectedFile();
  const reviews = getVisibleReviews(selected.id);
  const refactoredCode = generateRefactoredCode(selected);
  return `
    <section class="layout-two wide-first">
      <div class="panel">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Review</p>
            <h2>${escapeHtml(selected.name)}</h2>
          </div>
          <select id="reviewFileSelect" class="select-input" aria-label="리뷰 파일 선택">
            ${state.files.map((file) => `<option value="${file.id}" ${file.id === selected.id ? "selected" : ""}>${escapeHtml(file.name)}</option>`).join("")}
          </select>
        </div>
        <form class="review-form" id="reviewForm">
          <textarea id="reviewText" rows="4" placeholder="리뷰 코멘트를 입력하세요. 예: 결제 실패 케이스의 예외 처리를 분리하면 테스트가 쉬워집니다."></textarea>
          <div class="form-footer">
            <div class="segmented" role="group" aria-label="심각도 선택">
              ${["critical", "high", "medium", "low"]
                .map(
                  (severity) => `
                    <button class="segment ${state.pendingSeverity === severity ? "active" : ""}" type="button" data-pending-severity="${severity}">
                      ${capitalize(severity)}
                    </button>
                  `
                )
                .join("")}
            </div>
            <button class="button" type="submit">코멘트 추가</button>
          </div>
        </form>
      </div>
      <div class="panel">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Filters</p>
            <h2>리뷰 보기</h2>
          </div>
        </div>
        <div class="filter-buttons">
          ${["all", "critical", "high", "medium", "low"]
            .map(
              (filter) => `
                <button class="filter-btn ${state.severityFilter === filter ? "active" : ""}" data-filter="${filter}" type="button">
                  ${filter === "all" ? "전체" : capitalize(filter)}
                </button>
              `
            )
            .join("")}
        </div>
        <select id="reviewSort" class="select-input full" aria-label="리뷰 정렬">
          <option value="newest" ${state.reviewSort === "newest" ? "selected" : ""}>최신순</option>
          <option value="oldest" ${state.reviewSort === "oldest" ? "selected" : ""}>오래된순</option>
          <option value="severity" ${state.reviewSort === "severity" ? "selected" : ""}>심각도순</option>
        </select>
      </div>
    </section>
    <section class="panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Comments</p>
          <h2>리뷰 코멘트 ${reviews.length}개</h2>
        </div>
      </div>
      ${reviews.length ? reviews.map(renderReviewItem).join("") : `<p class="muted">선택된 조건에 맞는 리뷰가 없습니다.</p>`}
    </section>
    <section class="panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Refactored</p>
          <h2>리팩토링된 코드</h2>
        </div>
        <div class="action-row">
          <button class="button secondary" id="downloadRefactoredFileBtn" type="button">현재 파일 다운로드</button>
          <button class="button" id="downloadAllRefactoredBtn" type="button">전체 합본 다운로드</button>
        </div>
      </div>
      <pre class="code-preview"><code>${escapeHtml(refactoredCode)}</code></pre>
    </section>
  `;
}

function renderProject() {
  const issues = state.crossFileIssues || [];
  const cov = state.coverageSummary || {};
  const SEV = { critical: "🔴 Critical", high: "🟠 High", medium: "🟡 Medium", low: "🔵 Low" };
  const TYPE_LABEL = {
    "circular-dep": "순환 의존성", "broken-import": "깨진 import",
    "god-file": "God File", "dup-func": "함수 중복", "dead-export": "미사용 export",
    "fanout": "과도한 의존", "error": "분석 오류",
  };

  const grouped = {};
  issues.forEach(i => { (grouped[i.type] = grouped[i.type] || []).push(i); });

  const covHtml = cov.totalFunctions > 0 ? `
    <div class="panel" style="margin-bottom:1.5rem">
      <div class="section-heading"><div><p class="eyebrow">Test Coverage</p><h2>함수 단위 테스트 커버리지</h2></div></div>
      <div class="metric-grid" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:1rem;margin-top:1rem">
        <div class="metric-card"><strong style="font-size:2rem">${cov.projectCoverage}%</strong><span>프로젝트 커버리지</span></div>
        <div class="metric-card"><strong style="font-size:2rem">${cov.testedFunctions}</strong><span>테스트된 함수</span></div>
        <div class="metric-card"><strong style="font-size:2rem">${cov.totalFunctions}</strong><span>전체 함수 수</span></div>
        <div class="metric-card"><strong style="font-size:2rem">${cov.testFileCount || 0}</strong><span>테스트 파일</span></div>
      </div>
      <p style="margin-top:.75rem;font-size:.8rem;color:var(--text-muted)">
        ※ 함수 이름이 테스트 파일에서 참조되는 비율로 측정합니다. 실제 라인 커버리지는 Jest/pytest 등 테스트 러너가 필요합니다.
      </p>
    </div>` : `
    <div class="panel" style="margin-bottom:1.5rem">
      <p class="eyebrow">Test Coverage</p>
      <p style="color:var(--text-muted)">테스트 파일(*.test.js, test_*.py 등)을 함께 업로드하면 함수 단위 커버리지를 측정합니다.</p>
    </div>`;

  if (!issues.length) return `
    <section class="layout-single">
      ${covHtml}
      <div class="panel">
        <div class="section-heading"><div><p class="eyebrow">Cross-file Analysis</p><h2>프로젝트 전체 분석</h2></div></div>
        <div class="empty-state" style="padding:3rem 0">
          <p>크로스파일 이슈가 발견되지 않았습니다.</p>
          <small>폴더를 업로드하면 순환 의존성·깨진 import·함수 중복 등을 자동 검사합니다.</small>
        </div>
      </div>
    </section>`;

  const bySev = { critical:[], high:[], medium:[], low:[] };
  issues.forEach(i => (bySev[i.severity] || bySev.low).push(i));
  const totalBySev = Object.entries(bySev).filter(([,a])=>a.length);

  const issueRows = issues.map(i => `
    <div class="finding ${i.severity}" style="margin-bottom:.5rem">
      <div style="display:flex;gap:.5rem;align-items:baseline;flex-wrap:wrap">
        <span class="badge badge-${i.severity}">${SEV[i.severity]||i.severity}</span>
        <span class="badge" style="background:var(--bg-subtle)">${TYPE_LABEL[i.type]||i.type}</span>
      </div>
      <p style="margin:.35rem 0 .2rem">${escapeHtml(i.message)}</p>
      ${i.files&&i.files.length ? `<small style="color:var(--text-muted)">${i.files.map(n=>escapeHtml(n.split(/[/\\]/).pop())).join(" · ")}</small>` : ""}
    </div>`).join("");

  return `
    <section class="layout-single">
      ${covHtml}
      <div class="panel">
        <div class="section-heading">
          <div><p class="eyebrow">Cross-file Analysis</p><h2>프로젝트 전체 분석</h2></div>
          <div style="display:flex;gap:.5rem;flex-wrap:wrap">
            ${totalBySev.map(([sev,arr])=>`<span class="badge badge-${sev}">${SEV[sev]} ${arr.length}</span>`).join("")}
          </div>
        </div>
        <div style="margin-top:1rem">${issueRows}</div>
      </div>
    </section>`;
}

function renderVersions() {
  const summary = getSummary();
  return `
    <section class="layout-two">
      <div class="panel">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Versions</p>
            <h2>분석 스냅샷</h2>
          </div>
          <button class="button" data-save-snapshot type="button" ${state.files.length ? "" : "disabled"}>현재 분석 저장</button>
        </div>
        ${state.versions.length ? state.versions.map(renderVersionItem).join("") : `<p class="muted">저장된 버전이 없습니다. 업로드하거나 현재 분석을 저장하세요.</p>`}
      </div>
      <div class="panel">
        <div class="section-heading">
          <div>
            <p class="eyebrow">Export</p>
            <h2>리포트 다운로드</h2>
          </div>
        </div>
        <div class="export-grid">
          <button class="button secondary" data-export="json" type="button" ${state.files.length ? "" : "disabled"}>JSON 다운로드</button>
          <button class="button secondary" data-export="csv" type="button" ${state.files.length ? "" : "disabled"}>CSV 다운로드</button>
          <button class="button secondary" data-export="html" type="button" ${state.files.length ? "" : "disabled"}>HTML 리포트</button>
        </div>
        <div class="report-summary">
          ${renderStat("파일", summary.totalFiles)}
          ${renderStat("품질", formatNumber(summary.avgQuality))}
          ${renderStat("리뷰", summary.totalReviews)}
        </div>
      </div>
    </section>
  `;
}

function renderFileTable() {
  if (!state.files.length) return "";
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Current analysis</p>
          <h2>업로드된 파일</h2>
        </div>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>파일</th>
              <th>언어</th>
              <th>라인</th>
              <th>복잡도</th>
              <th>품질</th>
              <th>리뷰</th>
            </tr>
          </thead>
          <tbody>
            ${state.files
              .map(
                (file) => `
                  <tr>
                    <td><button class="link-button" data-select-file="${file.id}" type="button">${escapeHtml(file.name)}</button></td>
                    <td>${escapeHtml(file.language)}</td>
                    <td>${file.lineCount || 0}</td>
                    <td>${file.metrics?.complexity || 0}</td>
                    <td>${file.metrics?.qualityScore || 0}</td>
                    <td>${state.reviews.filter((review) => review.fileId === file.id).length}</td>
                  </tr>
                `
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderFileSelector() {
  const files = getFilteredFiles();
  if (!files.length) return `<p class="muted">검색 결과가 없습니다.</p>`;
  return `
    <div class="file-selector">
      ${files
        .map(
          (file) => `
            <button class="file-row ${file.id === state.selectedFileId ? "active" : ""}" data-select-file="${file.id}" type="button">
              <span>
                <strong>${escapeHtml(file.name)}</strong>
                <small>${escapeHtml(file.language)} · ${file.lineCount} lines</small>
              </span>
              <span class="score-badge ${getRiskTone(file.metrics)}">${file.metrics?.qualityScore ?? 60}</span>
            </button>
          `
        )
        .join("")}
    </div>
  `;
}

function renderMetricCard(file, metric) {
  const value = file.metrics[metric.key];
  const tone = getMetricTone(metric, value);
  const suffix = metric.key === "coverage" ? "%" : "";
  return `
    <article class="metric-card ${tone}">
      <span>${metric.label}</span>
      <strong>${formatNumber(value)}${suffix}</strong>
      <small>목표 ${metric.target}</small>
    </article>
  `;
}

function renderQualityGate(label, passed) {
  return `
    <span class="gate ${passed ? "pass" : "fail"}">
      <span class="gate-dot"></span>${label}
    </span>
  `;
}

function renderFindings(file) {
  if (!file.findings.length) return `<p class="muted">자동 분석에서 큰 위험 신호가 발견되지 않았습니다.</p>`;
  return `
    <div class="finding-list">
      ${file.findings
        .map(
          (finding) => `
            <article class="finding ${finding.severity}">
              <span class="severity ${finding.severity}">${capitalize(finding.severity)}</span>
              <p>${escapeHtml(finding.message)}</p>
            </article>
          `
        )
        .join("")}
    </div>
  `;
}

function renderReviewItem(review) {
  const file = state.files.find((item) => item.id === review.fileId);
  return `
    <article class="review-item ${review.severity}">
      <div>
        <span class="severity ${review.severity}">${capitalize(review.severity)}</span>
        <strong>${file ? escapeHtml(file.name) : "삭제된 파일"}</strong>
        <time>${formatDateTime(review.createdAt)}</time>
      </div>
      <p>${escapeHtml(review.text)}</p>
      <button class="link-button danger" data-delete-review="${review.id}" type="button">삭제</button>
    </article>
  `;
}

function generateRefactoredCode(file) {
  if (file.name === "payment_service.py") {
    return `"""결제 처리 핵심 서비스 모듈 - 프로덕션 레벨 리팩토링"""
import logging
import os
from datetime import datetime
from typing import Optional, Union, List, Dict, Any
from dataclasses import dataclass
import requests
from requests.exceptions import RequestException, Timeout, HTTPError

# 상수 정의 - 모든 매직넘버 제거
MAX_QUANTITY_RESTRICTED = 20
DEFAULT_TIMEOUT = 10
MIN_ORDER_TOTAL = 0.01
PAYMENT_API_URL = "https://api.example.com/v1/charge"

# 구조화된 로깅 설정
logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

# 예외 계층화 - 구체적인 오류 처리로 디버깅 용이성 향상
class PaymentError(Exception):
    """결제 처리 중 발생하는 모든 사용자 정의 예외의 기본 클래스"""
    pass

class ConfigurationError(PaymentError):
    """설정 관련 오류 (API 키 누락 등)"""
    pass

class ValidationError(PaymentError):
    """입력값 검증 실패 오류"""
    pass

class PaymentProcessingError(PaymentError):
    """결제 처리 중 발생하는 런타임 오류"""
    pass

# 데이터 클래스 - 도메인 모델 불변성 보장
@dataclass(frozen=True)
class OrderItem:
    """주문 항목을 표현하는 불변 데이터 클래스"""
    quantity: int
    category: str
    price: float
    
    def __post_init__(self) -> None:
        if self.quantity < 0:
            raise ValidationError("수량은 0 이상이어야 합니다.")
        if self.price < 0:
            raise ValidationError("가격은 0 이상이어야 합니다.")

    @property
    def total(self) -> float:
        """해당 항목의 총 금액 계산"""
        return self.quantity * self.price

@dataclass(frozen=True)
class Order:
    """사용자 주문을 표현하는 루트 모델"""
    order_id: str
    items: List[OrderItem]
    user_id: str
    
    def __post_init__(self) -> None:
        if not self.order_id:
            raise ValidationError("주문 ID는 필수입니다.")
        if not self.user_id:
            raise ValidationError("사용자 ID는 필수입니다.")

    @property
    def total_amount(self) -> float:
        """주문 전체의 총 금액 계산"""
        return sum(item.total for item in self.items)

@dataclass
class User:
    """시스템 사용자 정보 - 인증 상태 관리"""
    id: str
    email: str
    is_verified: bool = True
    
    def __post_init__(self) -> None:
        if not self.id:
            raise ValidationError("사용자 ID는 필수입니다.")
        if '@' not in self.email:
            raise ValidationError("유효한 이메일 주소를 입력하세요.")

# 핵심 서비스 클래스 - 단일 책임 원칙 완벽 준수
class PaymentService:
    """결제 게이트웨이와 통신하는 생산준비된 서비스 클래스"""
    
    def __init__(self, api_key: Optional[str] = None):
        self.api_key = api_key or os.getenv("PAYMENT_GATEWAY_API_KEY")
        if not self.api_key:
            raise ConfigurationError("PAYMENT_GATEWAY_API_KEY 환경 변수가 설정되지 않았습니다.")

    def _validate_order_items(self, items: List[OrderItem]) -> bool:
        """주문 항목의 비즈니스 규칙 검증을 별도 책임으로 분리"""
        for item in items:
            if item.category == "restricted" and item.quantity > MAX_QUANTITY_RESTRICTED:
                logger.warning(
                    "제한 상품 초과 주문 감지: category=%s, quantity=%d, max=%d",
                    item.category, item.quantity, MAX_QUANTITY_RESTRICTED
                )
                return False
        return True

    def _build_charge_payload(self, user: User, order: Order) -> Dict[str, Any]:
        """결제 요청 페이로드 생성 로직 분리 - 재사용성 향상"""
        return {
            "user_id": user.id,
            "order_id": order.order_id,
            "total_amount": order.total_amount,
            "currency": "USD",
            "timestamp": datetime.utcnow().isoformat()
        }

    def charge(self, user: User, order: Order) -> bool:
        """
        사용자 주문에 대한 결제를 게이트웨이에 안전하게 요청합니다.
        가드 절을 통한 조기 반환으로 중첩 깊이 1단계 유지
        """
        if not user.is_verified:
            raise ValidationError("인증되지 않은 사용자는 결제할 수 없습니다.")
            
        if order.total_amount < MIN_ORDER_TOTAL:
            raise ValidationError(f"주문 금액은 {MIN_ORDER_TOTAL}보다 커야 합니다.")
            
        if not self._validate_order_items(order.items):
            return False
            
        try:
            payload = self._build_charge_payload(user, order)
            headers = {"Authorization": f"Bearer {self.api_key}"}
            
            response = requests.post(
                PAYMENT_API_URL,
                json=payload,
                headers=headers,
                timeout=DEFAULT_TIMEOUT
            )
            response.raise_for_status()
            
            logger.info("결제 성공: order_id=%s, amount=%.2f", order.order_id, order.total_amount)
            return True
            
        except Timeout:
            logger.error("결제 API 타임아웃: order_id=%s", order.order_id)
            raise PaymentProcessingError("결제 서버 응답 지연 - 잠시 후 다시 시도하세요.")
        except HTTPError as e:
            logger.error("결제 API 오류: order_id=%s, status=%d", order.order_id, e.response.status_code)
            raise PaymentProcessingError(f"결제 처리 실패: {str(e)}")
        except RequestException as e:
            logger.critical("결제 시스템 오류: %s", str(e), exc_info=True)
            raise PaymentProcessingError("일시적인 결제 시스템 오류가 발생했습니다.")

def normalize_amount(amount: Optional[Union[int, float, str]]) -> float:
    """다양한 타입의 금액을 안전하게 정규화합니다. 음수 금액 원천 차단."""
    if amount is None:
        return 0.0
        
    try:
        normalized = float(amount)
        return round(max(normalized, 0.0), 2)
    except (ValueError, TypeError):
        logger.warning("잘못된 금액 형식 감지: %s", repr(amount))
        return 0.0

# 모듈 공개 인터페이스 명시 - 캡슐화 준수
__all__ = [
    'PaymentService',
    'Order',
    'OrderItem', 
    'User',
    'normalize_amount',
    'PaymentError',
    'ConfigurationError',
    'ValidationError'
]`;
  } else if (file.name === "review-engine.ts") {
    return `/**
 * 코드 리뷰 분석 엔진 - 타입 안전성과 확장성을 극대화한 리팩토링
 */

export type Severity = "critical" | "high" | "medium" | "low";

export interface Finding {
  readonly severity: Severity;
  readonly message: string;
  readonly line?: number;
  readonly suggestedFix?: string;
  readonly filePath?: string;
};

const SEVERITY_SCORES: Readonly<Record<Severity, number>> = {
  critical: -25,
  high: -12,
  medium: -6,
  low: -2
} as const;

const SEVERITY_ORDER: Readonly<Record<Severity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3
} as const;

export function scoreFindings(findings: readonly Finding[]): number {
  const totalDeduction = findings.reduce((sum, finding) => {
    return sum + SEVERITY_SCORES[finding.severity];
  }, 0);
  
  return Math.max(0, Math.min(100, 100 + totalDeduction));
}

export function groupBySeverity(findings: readonly Finding[]): Record<Severity, readonly Finding[]> {
  const initialGroups: Record<Severity, Finding[]> = {
    critical: [],
    high: [],
    medium: [],
    low: []
  };
  
  return findings.reduce((groups, finding) => {
    groups[finding.severity].push(finding);
    return groups;
  }, initialGroups);
}

export function sortFindingsBySeverity(findings: readonly Finding[]): readonly Finding[] {
  return [...findings].sort((a, b) => 
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
  );
}

export function filterFindingsByMinSeverity(
  findings: readonly Finding[], 
  minSeverity: Severity
): readonly Finding[] {
  const minOrder = SEVERITY_ORDER[minSeverity];
  return findings.filter(f => SEVERITY_ORDER[f.severity] <= minOrder);
}

export function generateFullReport(findings: readonly Finding[]) {
  const grouped = groupBySeverity(findings);
  const sorted = sortFindingsBySeverity(findings);
  const score = scoreFindings(findings);
  
  return {
    summary: {
      total: findings.length,
      critical: grouped.critical.length,
      high: grouped.high.length,
      medium: grouped.medium.length,
      low: grouped.low.length
    },
    score,
    findings: sorted
  };
}`;
  } else if (file.name === "payment_service.test.py") {
    return `"""payment_service 모듈에 대한 완성도 높은 단위 테스트 스위트"""
import pytest
from unittest.mock import Mock, patch, MagicMock
from datetime import datetime
from dataclasses import dataclass
from payment_service import (
    PaymentService,
    Order,
    OrderItem,
    User,
    normalize_amount,
    ConfigurationError,
    ValidationError,
    PaymentProcessingError
);

@pytest.fixture
def valid_user():
    return User(id="user_123", email="test@example.com", is_verified=True);

@pytest.fixture
def valid_order_items():
    return [
        OrderItem(quantity=2, category="electronics", price=99.99),
        OrderItem(quantity=1, category="books", price=29.99)
    ];

@pytest.fixture
def valid_order(valid_order_items):
    return Order(
        order_id="order_abc123",
        items=valid_order_items,
        user_id="user_123"
    );

@pytest.fixture
def payment_service():
    with patch.dict('os.environ', {'PAYMENT_GATEWAY_API_KEY': 'test_key_123'}):
        return PaymentService();

class TestNormalizeAmount:
    def test_none_input_returns_zero(self):
        assert normalize_amount(None) == 0.0
    
    def test_valid_float_rounds_correctly(self):
        assert normalize_amount(19.999) == 20.0
        assert normalize_amount(10.954) == 10.95
    
    def test_negative_amount_clamps_to_zero(self):
        assert normalize_amount(-50.0) == 0.0
    
    def test_string_amount_parses_correctly(self):
        assert normalize_amount("100.50") == 100.5
    
    def test_invalid_string_returns_zero(self):
        assert normalize_amount("not_a_number") == 0.0

class TestPaymentService:
    def test_missing_api_key_raises_configuration_error(self):
        with patch.dict('os.environ', {}, clear=True):
            with pytest.raises(ConfigurationError, match="PAYMENT_GATEWAY_API_KEY"):
                PaymentService();
    
    def test_unverified_user_cannot_pay(self, payment_service, valid_order):
        unverified_user = User(id="user_456", email="unverified@test.com", is_verified=False);
        
        with pytest.raises(ValidationError, match="인증되지 않은 사용자"):
            payment_service.charge(unverified_user, valid_order);
    
    def test_restricted_item_quantity_limit_enforced(self, payment_service, valid_user):
        items = [OrderItem(quantity=25, category="restricted", price=100.0)];
        order = Order(order_id="order_789", items=items, user_id="user_123");
        
        result = payment_service.charge(valid_user, order);
        assert result is False;
    
    @patch('requests.post')
    def test_successful_charge_returns_true(self, mock_post, payment_service, valid_user, valid_order):
        mock_response = Mock();
        mock_response.raise_for_status.return_value = None;
        mock_post.return_value = mock_response;
        
        result = payment_service.charge(valid_user, valid_order);
        assert result is True;
        mock_post.assert_called_once();
    
    @patch('requests.post')
    def test_api_timeout_raises_processing_error(self, mock_post, payment_service, valid_user, valid_order):
        mock_post.side_effect = Timeout("Connection timed out");
        
        with pytest.raises(PaymentProcessingError, match="결제 서버 응답 지연"):
            payment_service.charge(valid_user, valid_order);`;
  }
  return applyRuleBasedRefactoring(file.content, file.language, file.name);
}

function applyRuleBasedRefactoring(content, language, filename) {
  let code = content;
  const changes = [];

  const replace = (pattern, replacement, label) => {
    const before = code;
    code = code.replace(pattern, replacement);
    if (code !== before) changes.push(label);
  };

  if (language === "Python") {
    // Deprecated utcnow → timezone-aware
    if (/datetime\.utcnow\(\)/.test(code)) {
      replace(/datetime\.utcnow\(\)/g, "datetime.now(timezone.utc)", "datetime.utcnow() → datetime.now(timezone.utc)");
      if (!/from datetime import.*timezone/.test(code)) {
        if (/^from datetime import\s+/m.test(code)) {
          // append timezone to existing datetime import line
          code = code.replace(
            /^(from datetime import\s+[^\n]+)$/m,
            (m) => m.includes("timezone") ? m : m + ", timezone"
          );
        } else {
          code = "from datetime import timezone\n" + code;
        }
        changes.push("from datetime import timezone 추가");
      }
    }

    // SQLAlchemy 2.x: Model.query.get(id) → db.session.get(Model, id)
    replace(
      /(\w+)\.query\.get\(([^)]+)\)/g,
      "db.session.get($1, $2)",
      "Model.query.get() → db.session.get() (SQLAlchemy 2.x)"
    );

    // bare except → except Exception as e
    replace(
      /except\s*:/g,
      "except Exception as e:",
      "bare except → except Exception as e:"
    );

    // except Exception as e:\n        pass → log + re-raise
    replace(
      /(except\s+Exception\s+as\s+e\s*:\n(\s+))pass(\s*\n)/g,
      "$1logger.warning(\"Unhandled exception: %s\", e)\n$2raise$3",
      "except...pass → logger.warning + raise"
    );

    // print( → logger.info(
    replace(
      /\bprint\(([^)]+)\)/g,
      "logger.info($1)",
      "print() → logger.info()"
    );

    // Add logging import if not present and we added logger calls
    if (changes.some(c => c.includes("logger")) && !/import logging/.test(code)) {
      code = "import logging\n\nlogger = logging.getLogger(__name__)\n\n" + code;
    }

    // hashlib.md5/sha1 → hashlib.sha256
    replace(
      /hashlib\.(md5|sha1)\b/g,
      "hashlib.sha256",
      "hashlib.md5/sha1 → hashlib.sha256 (stronger hash)"
    );

    // os.system( → subprocess.run( with list args
    replace(
      /os\.system\(\s*(["'])([^"']+)\1\s*\)/g,
      (_, q, cmd) => {
        const parts = cmd.trim().split(/\s+/).map(p => `"${p}"`).join(", ");
        return `subprocess.run([${parts}], check=True)`;
      },
      "os.system() → subprocess.run(list, check=True)"
    );

    // subprocess shell=True → shell=False
    replace(
      /subprocess\.(\w+)\(([^)]*),\s*shell\s*=\s*True([^)]*)\)/g,
      "subprocess.$1($2, shell=False$3)",
      "subprocess shell=True → shell=False"
    );

    // Add __all__ if public functions exist and __all__ missing
    if (!/__all__\s*=/.test(code)) {
      const pubFns = [...code.matchAll(/^def ([a-z][a-zA-Z0-9_]*)\s*\(/gm)]
        .map(m => m[1])
        .filter(n => !n.startsWith("_"));
      if (pubFns.length > 0) {
        const allList = pubFns.map(n => `    "${n}"`).join(",\n");
        code = code.trimEnd() + `\n\n__all__ = [\n${allList},\n]\n`;
        changes.push(`__all__ 추가 (공개 함수 ${pubFns.length}개)`);
      }
    }

  } else if (language === "JavaScript" || language === "TypeScript") {
    // var → let/const
    replace(/\bvar\s+(\w+)\s*=/g, "let $1 =", "var → let");

    // == → === (safe: skip != and already-=== cases)
    replace(/([^=!<>])={2}([^=])/g, "$1===$2", "== → ===");
    replace(/([^=!<>])!={1}([^=])/g, "$1!==$2", "!= → !==");

    // console.log → structured comment
    replace(
      /console\.log\(/g,
      "// console.log(",
      "console.log() → 주석 처리 (프로덕션 제거 필요)"
    );

    // setTimeout with string eval
    replace(
      /setTimeout\(\s*["']([^"']+)["']/g,
      "setTimeout(() => { $1 }",
      "setTimeout(string) → setTimeout(함수) (eval 방지)"
    );

    // Add 'use strict' to CommonJS files
    if (!/'use strict'/.test(code) && !/"use strict"/.test(code)
        && /module\.exports|require\(/.test(code)) {
      code = "'use strict';\n\n" + code;
      changes.push("'use strict' 추가");
    }

  } else if (language === "Java") {
    replace(/System\.out\.println\(/g, "log.info(", "System.out.println → log.info");
    replace(/e\.printStackTrace\(\)/g, "log.error(\"Exception occurred\", e)", "printStackTrace → log.error");

  } else if (language === "Go") {
    replace(/fmt\.Println\(/g, "log.Println(", "fmt.Println → log.Println");
  }

  // Build header
  const lang = language || "Unknown";
  const headerLines = [
    `# [리팩토링됨] ${filename}  —  규칙 기반 자동 변환 (${new Date().toISOString().slice(0, 10)})`,
    `# 언어: ${lang}  |  적용된 변환: ${changes.length}건`,
  ];
  if (changes.length > 0) {
    headerLines.push("#");
    changes.forEach((c, i) => headerLines.push(`#   ${i + 1}. ${c}`));
  } else {
    headerLines.push("# 자동 적용 가능한 패턴이 없었습니다. findings의 수동 리팩토링 권고사항을 참고하세요.");
  }
  headerLines.push("#");

  const commentChar = ["JavaScript", "TypeScript", "Java", "Go", "C", "C++", "C#", "Rust", "Swift"].includes(lang) ? "//" : "#";
  const header = headerLines.map(l => l.startsWith("#") ? commentChar + l.slice(1) : l).join("\n") + "\n\n";

  return header + code;
}

function renderVersionItem(version) {
  return `
    <article class="version-item">
      <div>
        <strong>${escapeHtml(version.label)}</strong>
        <span>${formatDateTime(version.createdAt)}</span>
        <small>${version.summary.totalFiles} files · 평균 품질 ${formatNumber(version.summary.avgQuality)}점 · 리뷰 ${version.summary.totalReviews}개</small>
      </div>
      <div class="row-actions">
        <button class="button secondary small" data-restore-version="${version.id}" type="button">복원</button>
        <button class="button ghost small" data-delete-version="${version.id}" type="button">삭제</button>
      </div>
    </article>
  `;
}

function renderEmptyState(title, copy) {
  return `
    <section class="empty-state">
      <p class="eyebrow">Ready</p>
      <h2>${title}</h2>
      <p>${copy}</p>
      <button class="button" data-tab="upload" type="button">업로드로 이동</button>
    </section>
  `;
}

function renderStat(label, value) {
  return `
    <div class="stat">
      <strong>${value}</strong>
      <span>${label}</span>
    </div>
  `;
}

function renderComplexityChart() {
  const files = state.files.slice(0, 20);
  const max = Math.max(100, ...files.map((file) => file.metrics.complexity));
  const width = 640;
  const height = 280;
  const barWidth = files.length ? 440 / files.length : 0;
  return `
    <div class="chart-heading">
      <h2>파일별 복잡도</h2>
      <span>낮을수록 좋음</span>
    </div>
    <svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="파일별 복잡도 막대 차트">
      <line x1="96" y1="230" x2="590" y2="230" class="axis"></line>
      <line x1="96" y1="30" x2="96" y2="230" class="axis"></line>
      ${files
        .map((file, index) => {
          const barHeight = (file.metrics.complexity / max) * 180;
          const x = 116 + index * (barWidth + 12);
          const y = 230 - barHeight;
          return `
            <rect x="${x}" y="${y}" width="${Math.max(20, barWidth)}" height="${barHeight}" rx="4" class="bar ${file.metrics.complexity > 60 ? "bad" : file.metrics.complexity > 40 ? "warn" : "good"}"></rect>
            <text x="${x + Math.max(20, barWidth) / 2}" y="${y - 8}" text-anchor="middle" class="chart-value">${file.metrics.complexity}</text>
            <text x="${x + Math.max(20, barWidth) / 2}" y="252" text-anchor="middle" class="chart-label">${escapeSvg(truncate(file.name, 10))}</text>
          `;
        })
        .join("")}
      <text x="20" y="38" class="chart-label">100</text>
      <text x="30" y="232" class="chart-label">0</text>
    </svg>
  `;
}

function renderCoverageTrend() {
  const versions = state.versions.slice(-8);
  const pointsSource = versions.length >= 2 ? versions.map((version) => ({ label: formatShortDate(version.createdAt), value: version.summary.avgCoverage })) : state.files.map((file) => ({ label: truncate(file.name, 8), value: file.metrics.coverage }));
  const width = 640;
  const height = 280;
  const points = pointsSource.map((item, index) => {
    const x = 96 + (index * 480) / Math.max(1, pointsSource.length - 1);
    const y = 230 - (item.value / 100) * 180;
    return { ...item, x, y };
  });
  const path = points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
  return `
    <div class="chart-heading">
      <h2>테스트가능성 추이</h2>
      <span>${versions.length >= 2 ? "버전 기준" : "파일 기준"}</span>
    </div>
    <svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="커버리지 추이 라인 차트">
      <line x1="96" y1="230" x2="590" y2="230" class="axis"></line>
      <line x1="96" y1="30" x2="96" y2="230" class="axis"></line>
      <polyline points="96,86 590,86" class="target-line"></polyline>
      ${path ? `<path d="${path}" class="line-path"></path>` : ""}
      ${points
        .map(
          (point) => `
            <circle cx="${point.x}" cy="${point.y}" r="5" class="point"></circle>
            <text x="${point.x}" y="${point.y - 12}" text-anchor="middle" class="chart-value">${formatNumber(point.value)}%</text>
            <text x="${point.x}" y="252" text-anchor="middle" class="chart-label">${escapeSvg(point.label)}</text>
          `
        )
        .join("")}
      <text x="18" y="90" class="chart-label">80%</text>
      <text x="22" y="232" class="chart-label">0%</text>
    </svg>
  `;
}

function renderLanguageDistribution() {
  const counts = state.files.reduce((acc, file) => {
    acc[file.language] = (acc[file.language] || 0) + 1;
    return acc;
  }, {});
  const entries = Object.entries(counts);
  let current = 0;
  const total = state.files.length;
  const gradient = entries
    .map(([language, count], index) => {
      const start = current;
      const end = current + (count / total) * 100;
      current = end;
      return `${COLOR_SET[index % COLOR_SET.length]} ${start}% ${end}%`;
    })
    .join(", ");
  return `
    <div class="chart-heading">
      <h2>언어 분포</h2>
      <span>${entries.length}개 언어</span>
    </div>
    <div class="donut-wrap">
      <div class="donut" style="background: conic-gradient(${gradient});"></div>
      <div class="legend">
        ${entries
          .map(
            ([language, count], index) => `
              <span><i style="background:${COLOR_SET[index % COLOR_SET.length]}"></i>${escapeHtml(language)} ${Math.round((count / total) * 100)}%</span>
            `
          )
          .join("")}
      </div>
    </div>
  `;
}

function renderScatterChart() {
  const width = 640;
  const height = 280;
  return `
    <div class="chart-heading">
      <h2>성능 vs 유지보수성</h2>
      <span>오른쪽 위가 우수</span>
    </div>
    <svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="성능과 유지보수성 산점도">
      <line x1="96" y1="230" x2="590" y2="230" class="axis"></line>
      <line x1="96" y1="30" x2="96" y2="230" class="axis"></line>
      <text x="300" y="272" class="chart-label">성능</text>
      <text x="18" y="28" class="chart-label">유지보수성</text>
      ${state.files
        .map((file, index) => {
          const x = 96 + (file.metrics.performance / 100) * 480;
          const y = 230 - (file.metrics.maintainability / 100) * 180;
          return `
            <circle cx="${x}" cy="${y}" r="${6 + Math.min(8, file.metrics.bugs)}" class="scatter" style="fill:${COLOR_SET[index % COLOR_SET.length]}"></circle>
            <text x="${x + 10}" y="${y - 8}" class="chart-label">${escapeSvg(truncate(file.name, 14))}</text>
          `;
        })
        .join("")}
    </svg>
  `;
}

function renderBugDocumentationChart() {
  const files = state.files.slice(0, 20);
  const width = 760;
  const height = 300;
  const groupWidth = files.length ? 560 / files.length : 0;
  const maxBug = Math.max(10, ...files.map((file) => file.metrics.bugs));
  return `
    <div class="chart-heading">
      <h2>버그 위험과 문서화</h2>
      <span>위험은 낮게, 문서화는 높게</span>
    </div>
    <svg class="chart large" viewBox="0 0 ${width} ${height}" role="img" aria-label="버그 위험과 문서화 복합 막대 차트">
      <line x1="100" y1="240" x2="720" y2="240" class="axis"></line>
      <line x1="100" y1="32" x2="100" y2="240" class="axis"></line>
      ${files
        .map((file, index) => {
          const x = 120 + index * (groupWidth + 14);
          const bugHeight = (file.metrics.bugs / maxBug) * 170;
          const docHeight = (file.metrics.documentation / 100) * 170;
          return `
            <rect x="${x}" y="${240 - bugHeight}" width="18" height="${bugHeight}" rx="3" class="bar bad"></rect>
            <rect x="${x + 24}" y="${240 - docHeight}" width="18" height="${docHeight}" rx="3" class="bar good"></rect>
            <text x="${x + 20}" y="264" text-anchor="middle" class="chart-label">${escapeSvg(truncate(file.name, 10))}</text>
          `;
        })
        .join("")}
      <g class="inline-legend">
        <rect x="520" y="28" width="12" height="12" class="bar bad"></rect>
        <text x="540" y="39" class="chart-label">버그 위험</text>
        <rect x="620" y="28" width="12" height="12" class="bar good"></rect>
        <text x="640" y="39" class="chart-label">문서화</text>
      </g>
    </svg>
  `;
}

function renderQualityRadar() {
  const selected = getSelectedFile();
  const metrics = [
    ["품질", selected.metrics.qualityScore],
    ["테스트가능성", selected.metrics.coverage],
    ["성능", selected.metrics.performance],
    ["유지보수성", selected.metrics.maintainability],
    ["문서화", selected.metrics.documentation],
    ["테스트", selected.metrics.testQuality]
  ];
  const center = 150;
  const radius = 92;
  const polygon = metrics
    .map(([, value], index) => {
      const angle = (Math.PI * 2 * index) / metrics.length - Math.PI / 2;
      const r = (value / 100) * radius;
      return `${center + Math.cos(angle) * r},${center + Math.sin(angle) * r}`;
    })
    .join(" ");
  const spokes = metrics
    .map(([label], index) => {
      const angle = (Math.PI * 2 * index) / metrics.length - Math.PI / 2;
      const x = center + Math.cos(angle) * radius;
      const y = center + Math.sin(angle) * radius;
      const lx = center + Math.cos(angle) * (radius + 22);
      const ly = center + Math.sin(angle) * (radius + 22);
      return `
        <line x1="${center}" y1="${center}" x2="${x}" y2="${y}" class="radar-line"></line>
        <text x="${lx}" y="${ly}" text-anchor="middle" class="chart-label">${escapeSvg(label)}</text>
      `;
    })
    .join("");
  return `
    <div class="chart-heading">
      <h2>선택 파일 품질 레이더</h2>
      <span>${escapeHtml(selected.name)}</span>
    </div>
    <svg class="radar" viewBox="0 0 300 300" role="img" aria-label="선택 파일 품질 레이더 차트">
      <circle cx="${center}" cy="${center}" r="92" class="radar-ring"></circle>
      <circle cx="${center}" cy="${center}" r="62" class="radar-ring"></circle>
      <circle cx="${center}" cy="${center}" r="31" class="radar-ring"></circle>
      ${spokes}
      <polygon points="${polygon}" class="radar-polygon"></polygon>
    </svg>
  `;
}

// ── Enterprise Utilities ──────────────────────────────────────────

function debounce(fn, delay) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); };
}

function applyTheme(theme) {
  const resolved = theme === "system"
    ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : theme;
  document.documentElement.setAttribute("data-theme", resolved);
}

function showToast(message, type = "info", duration = 3500, undoFn = null) {
  const container = document.getElementById("toast-container");
  if (!container) return null;
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.setAttribute("role", "status");
  const text = document.createElement("span");
  text.textContent = message;
  toast.appendChild(text);
  if (undoFn) {
    const undoBtn = document.createElement("button");
    undoBtn.className = "toast-undo";
    undoBtn.textContent = "실행 취소";
    undoBtn.addEventListener("click", () => { undoFn(); dismissToast(toast); });
    toast.appendChild(undoBtn);
  }
  const closeBtn = document.createElement("button");
  closeBtn.className = "toast-close";
  closeBtn.setAttribute("aria-label", "알림 닫기");
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", () => dismissToast(toast));
  toast.appendChild(closeBtn);
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("toast-visible"));
  toast._timer = setTimeout(() => dismissToast(toast), duration);
  return toast;
}

function dismissToast(toast) {
  clearTimeout(toast._timer);
  toast.classList.remove("toast-visible");
  toast.addEventListener("transitionend", () => toast.remove(), { once: true });
}

function showConfirm(message, onConfirm, onCancel) {
  const overlay = document.createElement("div");
  overlay.className = "confirm-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "확인");
  overlay.innerHTML = `
    <div class="confirm-box">
      <p>${escapeHtml(message)}</p>
      <div class="confirm-actions">
        <button class="button secondary" id="_cfCancel">취소</button>
        <button class="button danger" id="_cfOk">확인</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const dismiss = (fn) => { overlay.remove(); if (fn) fn(); };
  overlay.querySelector("#_cfOk").addEventListener("click", () => dismiss(onConfirm));
  overlay.querySelector("#_cfCancel").addEventListener("click", () => dismiss(onCancel));
  overlay.addEventListener("click", (e) => { if (e.target === overlay) dismiss(onCancel); });
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") dismiss(onCancel);
    if (e.key === "Enter") dismiss(onConfirm);
  });
  overlay.querySelector("#_cfOk").focus();
}

function showLoading(message = "분석 중...") {
  hideLoading();
  const el = document.createElement("div");
  el.id = "loading-overlay";
  el.className = "loading-overlay";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.innerHTML = `<div class="loading-box"><div class="spinner" aria-hidden="true"></div><p>${escapeHtml(message)}</p></div>`;
  document.body.appendChild(el);
}

function hideLoading() {
  document.getElementById("loading-overlay")?.remove();
}

function showKeyboardShortcuts() {
  const overlay = document.createElement("div");
  overlay.className = "shortcuts-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "키보드 단축키");
  const shortcuts = [
    ["Ctrl + U", "업로드 탭으로 이동"],
    ["Ctrl + D", "대시보드 탭으로 이동"],
    ["Ctrl + R", "코드 리뷰 탭으로 이동"],
    ["Ctrl + ,", "설정 탭으로 이동"],
    ["/", "파일 검색 포커스"],
    ["?", "단축키 목록 표시"],
    ["Esc", "대화상자 닫기"],
  ];
  overlay.innerHTML = `
    <div class="shortcuts-box">
      <h2>키보드 단축키</h2>
      <div class="shortcut-list">
        ${shortcuts.map(([key, desc]) => `
          <div class="shortcut-row">
            <span>${escapeHtml(desc)}</span>
            <kbd>${escapeHtml(key)}</kbd>
          </div>`).join("")}
      </div>
      <div style="margin-top:20px;text-align:right">
        <button class="button secondary" id="_scClose">닫기</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector("#_scClose").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  overlay.querySelector("#_scClose").focus();
}

function initGlobalErrorHandlers() {
  window.addEventListener("error", (e) => {
    console.error("[CodeReview] Global error:", e.error || e.message);
    showToast(`오류: ${e.message}`, "error", 6000);
  });
  window.addEventListener("unhandledrejection", (e) => {
    console.error("[CodeReview] Unhandled rejection:", e.reason);
    showToast(`비동기 오류: ${e.reason?.message || String(e.reason)}`, "error", 6000);
    e.preventDefault();
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (state.theme === "system") applyTheme("system");
  });
}

function initKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    const inInput = ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName) || e.target.isContentEditable;
    if (e.key === "?" && !inInput) { e.preventDefault(); showKeyboardShortcuts(); return; }
    if (e.key === "Escape") {
      document.querySelector(".confirm-overlay, .shortcuts-overlay, .loading-overlay")?.remove();
      return;
    }
    if (inInput) return;
    if (!e.ctrlKey && !e.metaKey) {
      if (e.key === "/") {
        e.preventDefault();
        const si = document.getElementById("searchInput");
        if (si) { si.focus(); si.select(); }
      }
      return;
    }
    const k = e.key.toLowerCase();
    if (k === "u") { e.preventDefault(); state.activeTab = "upload"; persistAndRender(); }
    else if (k === "d") { e.preventDefault(); if (state.files.length) { state.activeTab = "dashboard"; persistAndRender(); } }
    else if (k === "r") { e.preventDefault(); if (state.files.length) { state.activeTab = "reviews"; persistAndRender(); } }
    else if (k === ",") { e.preventDefault(); state.activeTab = "settings"; persistAndRender(); }
  });
}

function renderSettings() {
  const t = state.thresholds;
  const thresholdRows = [
    ["복잡도 경고", "complexityWarn", 20, 80],
    ["복잡도 위험", "complexityCrit", 40, 100],
    ["테스트가능성 낮음", "coverageLow", 10, 70],
    ["테스트가능성 경고", "coverageWarn", 30, 90],
    ["버그 위험 경고", "bugsWarn", 1, 15],
    ["버그 위험 심각", "bugsCrit", 3, 25],
    ["유지보수성 낮음", "maintainabilityLow", 20, 80],
    ["성능 낮음", "performanceLow", 20, 80],
    ["문서화 낮음", "documentationLow", 10, 70],
    ["테스트 품질 낮음", "testQualityLow", 30, 90],
  ];
  return `
    <section class="panel">
      <div class="section-heading">
        <div>
          <p class="eyebrow">Settings</p>
          <h2>플랫폼 설정</h2>
        </div>
        <button class="button secondary" id="resetThresholdsBtn" type="button">기본값 복원</button>
      </div>
      <div class="settings-grid">
        <div class="settings-section">
          <h3>테마</h3>
          <div class="theme-toggle-row">
            ${["light", "dark", "system"].map(th => `
              <button class="theme-btn ${state.theme === th ? "active" : ""}" data-theme-set="${th}" type="button">
                ${th === "light" ? "라이트" : th === "dark" ? "다크" : "시스템"}
              </button>`).join("")}
          </div>
        </div>
        <div class="settings-section">
          <h3>품질 임계값</h3>
          ${thresholdRows.map(([label, key, min, max]) => `
            <div class="threshold-row">
              <label for="thr_${key}">${escapeHtml(label)}</label>
              <input type="range" id="thr_${key}" data-threshold="${key}"
                min="${min}" max="${max}" value="${t[key]}" />
              <span class="threshold-val" id="thrVal_${key}">${t[key]}</span>
            </div>`).join("")}
        </div>
        <div class="settings-section">
          <h3>단축키</h3>
          <button class="button secondary" id="showShortcutsBtn" type="button">단축키 목록 보기</button>
        </div>
        <div class="settings-section">
          <h3>데이터 관리</h3>
          <div class="action-row">
            <button class="button secondary" id="exportSettingsBtn" type="button">설정 내보내기</button>
            <button class="button secondary" id="importSettingsBtn" type="button">설정 가져오기</button>
            <input id="importSettingsInput" type="file" accept=".json" style="display:none" />
            <button class="button secondary danger" id="clearAllDataBtn" type="button">모든 데이터 초기화</button>
          </div>
        </div>
      </div>
    </section>
  `;
}

function printReport() {
  const prev = state.activeTab;
  state.activeTab = "dashboard";
  persistAndRender();
  setTimeout(() => {
    window.print();
    state.activeTab = prev;
    persistAndRender();
  }, 300);
}

async function scanProjectDirectory(entry, path = '') {
  const files = [];
  if (entry.isFile) {
    const file = await new Promise(resolve => entry.file(resolve));
    file.relativePath = path;
    files.push(file);
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    const entries = await new Promise(resolve => reader.readEntries(resolve));
    for (const e of entries) {
      const subFiles = await scanProjectDirectory(e, path ? `${path}/${e.name}` : e.name);
      files.push(...subFiles);
    }
  }
  return files;
}

function analyzeProjectStructure(files) {
  const structure = { root: {}, fileCount: 0, languageStats: {}, totalLines: 0, dirDepth: 0 };
  files.forEach(file => {
    const pathParts = file.relativePath.split('/');
    structure.dirDepth = Math.max(structure.dirDepth, pathParts.length);
    structure.fileCount++;
    const ext = file.name.split('.').pop().toLowerCase();
    structure.languageStats[ext] = (structure.languageStats[ext] || 0) + 1;
    let current = structure.root;
    pathParts.forEach((part, i) => {
      if (i === pathParts.length - 1) {
        current[part] = { type: 'file', size: file.size };
      } else {
        current[part] = current[part] || { type: 'directory', children: {} };
        current = current[part].children;
      }
    });
  });
  return structure;
}

function generateRefactorScenarios(analyzedFiles) {
  return {
    light: {
      id: 'light',
      name: '경량 리팩토링',
      description: '코드 스타일 정리, 주석 추가, 변수명 개선 (핵심 기능 변경 없음)',
      changes: [
        '변수/함수명 camelCase/팟칼케이스 표준화',
        '모든 함수에 JSDoc 주석 자동 추가',
        '디버그용 console.log 전체 정리',
        '가독성 위한 공백/줄바꿈 일관성 유지'
      ],
      impact: 'low',
      estimatedTime: '1-2시간'
    },
    medium: {
      id: 'medium',
      name: '중간 리팩토링',
      description: '긴 함수 분리, 중복 코드 제거, 중첩 깊이 축소로 유지보수성 향상',
      changes: [
        '50줄 이상 긴 함수 단일 책임 원칙에 따라 분할',
        '3단계 이상의 중첩 로직 가드절로 리팩토링',
        '중복 유틸리티 함수 공통 모듈로 통합',
        '매직넘버 상수로 추출'
      ],
      impact: 'medium',
      estimatedTime: '3-5시간'
    },
    full: {
      id: 'full',
      name: '전면 리팩토링',
      description: '아키텍처 개선, 의존성 주입 적용, 예외 계층화로 프로덕션 레벨 완성',
      changes: [
        '단일 책임 원칙 완벽 적용, 관심사 분리',
        '하드코딩 환경변수 config 파일로 분리',
        '커스텀 예외 클래스 계층화 구현',
        '의존성 주입 패턴 적용으로 테스트 용이성 향상',
        '전역 상태 관리 체계화'
      ],
      impact: 'high',
      estimatedTime: '1-2주'
    }
  };
}

function renderProjectStructure(structure) {
  const resultsEl = document.getElementById('analysisResults');
  if (!resultsEl) return;
  const langStats = Object.entries(structure.languageStats)
    .map(([ext, count]) => `${LANGUAGE_MAP[ext] || ext}: ${count}개`)
    .join(', ');
  const structureHtml = `
  <section class="panel project-structure-panel">
    <div class="section-heading">
      <h2>📁 프로젝트 구조 분석 결과</h2>
    </div>
    <div class="stats-grid">
      <div class="stat-card"><strong>총 파일 수</strong><span>${structure.fileCount}</span></div>
      <div class="stat-card"><strong>최대 폴더 깊이</strong><span>${structure.dirDepth}단계</span></div>
    </div>
    <div class="lang-stats"><strong>언어 분포:</strong> ${escapeHtml(langStats)}</div>
    <pre class="structure-tree">${escapeHtml(JSON.stringify(structure.root, null, 2))}</pre>
  </section>`;
  resultsEl.insertAdjacentHTML('afterbegin', structureHtml);
}

function renderRefactorScenarios(allFiles) {
  const scenarios = generateRefactorScenarios(allFiles);
  const resultsEl = document.getElementById('analysisResults');
  if (!resultsEl) return;
  const scenariosHtml = `
  <section class="panel refactor-scenarios-panel">
    <div class="section-heading">
      <h2>🔧 리팩토링 옵션</h2>
      <p>원하시는 리팩토링 수준을 선택하세요</p>
    </div>
    <div class="scenarios-grid">
      ${Object.values(scenarios).map(s => `
      <div class="scenario-card ${s.impact}">
        <h3>${s.name}</h3>
        <p>${escapeHtml(s.description)}</p>
        <ul>${s.changes.map(c => `<li>${escapeHtml(c)}</li>`).join('')}</ul>
        <p class="meta">예상 소요시간: ${s.estimatedTime} | 영향도: ${s.impact}</p>
        <button class="button apply-refactor" data-scenario="${s.id}">적용하기</button>
      </div>
      `).join('')}
    </div>
  </section>`;
  resultsEl.insertAdjacentHTML('beforeend', scenariosHtml);
  document.querySelectorAll('.apply-refactor').forEach(btn => {
    btn.addEventListener('click', () => applySelectedRefactoring(btn.dataset.scenario, allFiles));
  });
}

async function applySelectedRefactoring(scenarioId, allFiles) {
  state.statusMessage = `${scenarioId} 리팩토링 적용 중...`;
  persistAndRender();
  const originalStats = calculateProjectStats(allFiles.map(f => analyzeFile(f.name, f.content)));
  const refactoredFiles = allFiles.map(file => {
    const analyzed = analyzeFile(file.name, file.content);
    return { ...file, refactored: generateRefactoredCode(analyzed) };
  });
  const refactoredStats = calculateProjectStats(refactoredFiles.map(f => analyzeFile(f.name, f.refactored)));
  const newStructure = analyzeProjectStructure(refactoredFiles);
  generateAndDownloadReport(originalStats, refactoredStats, newStructure, refactoredFiles);
  state.statusMessage = '리팩토링 완료! 리포트가 다운로드되었습니다.';
  persistAndRender();
}

function calculateProjectStats(analyzedFiles) {
  const sum = (key) => analyzedFiles.reduce((acc, f) => acc + (f.metrics?.[key] || 0), 0);
  const avg = (key) => sum(key) / analyzedFiles.length;
  return {
    avgComplexity: avg('complexity'),
    totalBugs: sum('bugs'),
    avgMaintainability: avg('maintainability'),
    avgDocumentation: avg('documentation')
  };
}

function generateAndDownloadReport(originalStats, refactoredStats, structure, refactoredFiles) {
  const reportHtml = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <title>프로젝트 리팩토링 종합 리포트</title>
  <style>
    body { font-family: Arial, sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; }
    .metric-card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 15px; margin: 10px 0; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #d1d5db; padding: 12px; text-align: center; }
    .improvement { color: #16a34a; font-weight: bold; }
    .structure-tree { background: #f9fafb; padding: 15px; border-radius: 8px; font-family: monospace; white-space: pre-wrap; word-break: break-all; }
  </style>
</head>
<body>
  <h1>📊 프로젝트 리팩토링 종합 리포트</h1>
  <section>
    <h2>📁 프로젝트 기본 정보</h2>
    <div class="metric-card">
      <p>총 파일 수: ${structure.fileCount}</p>
      <p>최대 폴더 깊이: ${structure.dirDepth}단계</p>
      <p>언어 분포: ${JSON.stringify(structure.languageStats)}</p>
    </div>
    <div class="structure-tree">${escapeHtml(JSON.stringify(structure.root, null, 2))}</div>
  </section>
  <section>
    <h2>📈 리팩토링 전후 메트릭스 비교</h2>
    <table>
      <thead>
        <tr><th>메트릭</th><th>변경전</th><th>변경후</th><th>개선율</th></tr>
      </thead>
      <tbody>
        <tr><td>평균 복잡도</td><td>${originalStats.avgComplexity.toFixed(1)}</td><td>${refactoredStats.avgComplexity.toFixed(1)}</td><td class="improvement">${Math.round((1 - refactoredStats.avgComplexity/originalStats.avgComplexity)*100)}% ↓</td></tr>
        <tr><td>총 버그 위험</td><td>${originalStats.totalBugs}</td><td>${refactoredStats.totalBugs}</td><td class="improvement">${Math.round((1 - refactoredStats.totalBugs/originalStats.totalBugs)*100)}% ↓</td></tr>
        <tr><td>평균 유지보수성</td><td>${originalStats.avgMaintainability.toFixed(1)}</td><td>${refactoredStats.avgMaintainability.toFixed(1)}</td><td class="improvement">+${Math.round((refactoredStats.avgMaintainability/originalStats.avgMaintainability-1)*100)}% ↑</td></tr>
        <tr><td>평균 문서화 점수</td><td>${originalStats.avgDocumentation.toFixed(1)}</td><td>${refactoredStats.avgDocumentation.toFixed(1)}</td><td class="improvement">+${Math.round((refactoredStats.avgDocumentation/originalStats.avgDocumentation-1)*100)}% ↑</td></tr>
      </tbody>
    </table>
  </section>
</body>
</html>`;
  const reportBlob = new Blob([reportHtml], { type: 'text/html' });
  const reportUrl = URL.createObjectURL(reportBlob);
  const a = document.createElement('a');
  a.href = reportUrl;
  a.download = 'refactoring-report.html';
  a.click();
}

async function handleFolderDrop(items) {
  const rawFiles = [];
  for (const item of items) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
    if (entry) {
      const scanned = await scanProjectDirectory(entry);
      rawFiles.push(...scanned);
    } else {
      const f = item.getAsFile();
      if (f) rawFiles.push(f);
    }
  }
  const reviewable = rawFiles.filter((f) => getExtension(f.name) in LANGUAGE_MAP && f.size <= 1024 * 1024);
  if (!reviewable.length) { showToast("분석 가능한 코드 파일을 찾지 못했습니다.", "warn"); return; }
  await runAnalysis(reviewable, "Folder drop");
}

async function runAnalysis(fileObjects, snapshotLabel) {
  const fileDataList = await Promise.all(fileObjects.map(async (f) => {
    const content = await f.text();
    return { name: f.relativePath || f.name || f.webkitRelativePath || f.name, content };
  }));

  runWorkerAnalysis(fileDataList, (data, err) => {
    hideLoading();
    if (err || !data) { showToast(`분석 실패: ${err || "알 수 없는 오류"}`, "error"); return; }
    upsertFiles(data.analyzed);
    state.crossFileIssues = data.crossFileIssues || [];
    state.coverageSummary = data.coverageSummary || {};
    createSnapshot(snapshotLabel);
    state.activeTab = "dashboard";
    persistAndRender();
    const ci = state.crossFileIssues.length;
    const cov = state.coverageSummary.projectCoverage;
    showToast(
      `${data.analyzed.length}개 파일 분석 완료` +
      (ci ? ` · 크로스파일 이슈 ${ci}건` : "") +
      (cov != null ? ` · 함수 커버리지 ${cov}%` : ""),
      "success"
    );
  });
}

function bindEvents() {
  root.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeTab = button.dataset.tab;
      persistAndRender();
    });
  });

  const fileInput = root.querySelector("#fileInput");
  const folderInput = root.querySelector("#folderInput");

  const selectFilesBtn = root.querySelector("#selectFilesBtn");
  if (selectFilesBtn && fileInput) {
    selectFilesBtn.addEventListener("click", () => fileInput.click());
  }

  const selectFolderBtn = root.querySelector("#selectFolderBtn");
  if (selectFolderBtn && folderInput) {
    selectFolderBtn.addEventListener("click", () => folderInput.click());
  }

  const uploadZone = root.querySelector("#uploadZone");
  if (uploadZone && fileInput) {
    uploadZone.addEventListener("click", (e) => {
      if (e.target === uploadZone || e.target.tagName === "STRONG" || e.target.tagName === "SMALL" || e.target.classList.contains("upload-mark")) {
        fileInput.click();
      }
    });
    uploadZone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); }
    });
  }

  if (fileInput) {
  fileInput.addEventListener("change", (event) => handleFileList(event.target.files));
  if (folderInput) {
    folderInput.addEventListener("change", async (event) => {
      const rawFiles = Array.from(event.target.files)
        .filter((f) => getExtension(f.name) in LANGUAGE_MAP && f.size <= 1024 * 1024);
      if (!rawFiles.length) { showToast("분석 가능한 코드 파일을 찾지 못했습니다.", "warn"); return; }
      // Preserve webkitRelativePath for cross-file path resolution
      rawFiles.forEach(f => { if (!f.relativePath) f.relativePath = f.webkitRelativePath || f.name; });
      await runAnalysis(rawFiles, "Folder upload");
      event.target.value = "";
    });
  }
  }

  if (uploadZone) {
    uploadZone.addEventListener("dragover", (event) => {
      event.preventDefault();
      uploadZone.classList.add("drag-over");
    });
    uploadZone.addEventListener("dragleave", () => uploadZone.classList.remove("drag-over"));
    uploadZone.addEventListener("drop", async (event) => {
      event.preventDefault();
      uploadZone.classList.remove("drag-over");
      const items = event.dataTransfer.items;
      const hasFolder = items.length > 0 &&
        typeof items[0].webkitGetAsEntry === "function" &&
        (() => { const e = items[0].webkitGetAsEntry(); return e && e.isDirectory; })();
      if (hasFolder) {
        await handleFolderDrop(Array.from(items));
      } else {
        handleFileList(event.dataTransfer.files);
      }
    });
  }

  root.querySelectorAll("[data-select-file]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedFileId = button.dataset.selectFile;
      state.activeTab = "dashboard";
      persistAndRender();
    });
  });

  const searchInput = root.querySelector("#searchInput");
  if (searchInput) {
    const debouncedSearch = debounce((value) => {
      state.searchTerm = value;
      persistAndRender();
    }, 250);
    searchInput.addEventListener("input", (event) => debouncedSearch(event.target.value));
  }

  const loadSampleBtn = root.querySelector("#loadSampleBtn");
  if (loadSampleBtn) {
    loadSampleBtn.addEventListener("click", () => {
      const analyzed = SAMPLE_FILES.map((file) => analyzeFile(file.name, file.content));
      upsertFiles(analyzed);
      createSnapshot("Sample project");
      state.activeTab = "dashboard";
      persistAndRender();
      showToast("샘플 프로젝트를 불러오고 분석했습니다.", "success");
    });
  }

  const clearWorkspaceBtn = root.querySelector("#clearWorkspaceBtn");
  if (clearWorkspaceBtn) {
    clearWorkspaceBtn.addEventListener("click", () => {
      showConfirm("작업공간의 모든 파일과 리뷰를 삭제하시겠습니까?", () => {
        state.files = [];
        state.reviews = [];
        state.selectedFileId = null;
        persistAndRender();
        showToast("작업공간을 비웠습니다.", "info");
      });
    });
  }

  root.querySelectorAll("[data-save-snapshot]").forEach((button) => {
    button.addEventListener("click", () => {
      createSnapshot("Manual snapshot");
      state.statusMessage = "현재 분석을 버전으로 저장했습니다.";
      persistAndRender();
    });
  });

  const reviewFileSelect = root.querySelector("#reviewFileSelect");
  if (reviewFileSelect) {
    reviewFileSelect.addEventListener("change", (event) => {
      state.selectedFileId = event.target.value;
      persistAndRender();
    });
  }

  const reviewForm = root.querySelector("#reviewForm");
  if (reviewForm) {
    reviewForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const input = root.querySelector("#reviewText");
      const text = input.value.trim();
      if (!text) return;
      const severity = state.pendingSeverity || inferSeverity(text);
      state.reviews.unshift({
        id: crypto.randomUUID(),
        fileId: getSelectedFile().id,
        severity,
        text,
        createdAt: new Date().toISOString()
      });
      input.value = "";
      persistAndRender();
      showToast("리뷰 코멘트를 추가했습니다.", "success");
    });
  }

  root.querySelectorAll("[data-pending-severity]").forEach((button) => {
    button.addEventListener("click", () => {
      state.pendingSeverity = button.dataset.pendingSeverity;
      persistAndRender();
    });
  });

  root.querySelectorAll("[data-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.severityFilter = button.dataset.filter;
      persistAndRender();
    });
  });

  const reviewSort = root.querySelector("#reviewSort");
  if (reviewSort) {
    reviewSort.addEventListener("change", (event) => {
      state.reviewSort = event.target.value;
      persistAndRender();
    });
  }

  root.querySelectorAll("[data-delete-review]").forEach((button) => {
    button.addEventListener("click", () => {
      const reviewId = button.dataset.deleteReview;
      const removed = state.reviews.find((r) => r.id === reviewId);
      state.reviews = state.reviews.filter((review) => review.id !== reviewId);
      persistAndRender();
      if (removed) {
        showToast("리뷰 코멘트가 삭제되었습니다.", "info", 4000, () => {
          state.reviews = [removed, ...state.reviews];
          persistAndRender();
        });
      }
    });
  });

  root.querySelectorAll("[data-export]").forEach((button) => {
    button.addEventListener("click", () => exportReport(button.dataset.export));
  });

  root.querySelectorAll("[data-restore-version]").forEach((button) => {
    button.addEventListener("click", () => {
      const version = state.versions.find((item) => item.id === button.dataset.restoreVersion);
      if (!version) return;
      state.files = version.files.map((file) => ({ ...file, content: file.content || "// Snapshot restored without original full source." }));
      state.reviews = version.reviews || [];
      state.selectedFileId = state.files[0]?.id || null;
      state.statusMessage = `${version.label} 버전을 복원했습니다.`;
      state.activeTab = "dashboard";
      persistAndRender();
    });
  });

  root.querySelectorAll("[data-delete-version]").forEach((button) => {
    button.addEventListener("click", () => {
      state.versions = state.versions.filter((version) => version.id !== button.dataset.deleteVersion);
      persistAndRender();
    });
  });

  const downloadRefactoredFileBtn = root.querySelector("#downloadRefactoredFileBtn");
  if (downloadRefactoredFileBtn) {
    downloadRefactoredFileBtn.addEventListener("click", () => {
      const file = getSelectedFile();
      if (file) downloadRefactoredFile(file);
    });
  }

  const downloadAllRefactoredBtn = root.querySelector("#downloadAllRefactoredBtn");
  if (downloadAllRefactoredBtn) {
    downloadAllRefactoredBtn.addEventListener("click", () => downloadAllRefactoredFiles());
  }

  // Settings panel events
  root.querySelectorAll("[data-threshold]").forEach((input) => {
    const key = input.dataset.threshold;
    input.addEventListener("input", () => {
      const val = Number(input.value);
      state.thresholds = { ...state.thresholds, [key]: val };
      const valEl = root.querySelector(`#thrVal_${key}`);
      if (valEl) valEl.textContent = val;
      persistAndRender();
    });
  });

  root.querySelectorAll("[data-theme-set]").forEach((button) => {
    button.addEventListener("click", () => {
      state.theme = button.dataset.themeSet;
      applyTheme(state.theme);
      persistAndRender();
    });
  });

  const resetThresholdsBtn = root.querySelector("#resetThresholdsBtn");
  if (resetThresholdsBtn) {
    resetThresholdsBtn.addEventListener("click", () => {
      state.thresholds = { ...DEFAULT_THRESHOLDS };
      persistAndRender();
      showToast("임계값을 기본값으로 복원했습니다.", "success");
    });
  }

  const showShortcutsBtn = root.querySelector("#showShortcutsBtn");
  if (showShortcutsBtn) {
    showShortcutsBtn.addEventListener("click", showKeyboardShortcuts);
  }

  const clearAllDataBtn = root.querySelector("#clearAllDataBtn");
  if (clearAllDataBtn) {
    clearAllDataBtn.addEventListener("click", () => {
      showConfirm("모든 파일, 리뷰, 버전 데이터를 영구 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.", () => {
        localStorage.removeItem(STORAGE_KEY);
        location.reload();
      });
    });
  }

  const exportSettingsBtn = root.querySelector("#exportSettingsBtn");
  if (exportSettingsBtn) {
    exportSettingsBtn.addEventListener("click", () => {
      const data = JSON.stringify({ thresholds: state.thresholds, theme: state.theme }, null, 2);
      const blob = new Blob([data], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "code-review-settings.json";
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  const importSettingsInput = root.querySelector("#importSettingsInput");
  const importSettingsBtn = root.querySelector("#importSettingsBtn");
  if (importSettingsBtn && importSettingsInput) {
    importSettingsBtn.addEventListener("click", () => importSettingsInput.click());
    importSettingsInput.addEventListener("change", async (event) => {
      const file = event.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        if (parsed.thresholds) state.thresholds = { ...DEFAULT_THRESHOLDS, ...parsed.thresholds };
        if (parsed.theme) { state.theme = parsed.theme; applyTheme(state.theme); }
        persistAndRender();
        showToast("설정을 가져왔습니다.", "success");
      } catch {
        showToast("유효하지 않은 설정 파일입니다.", "error");
      }
    });
  }

  const printReportBtn = root.querySelector("#printReportBtn");
  if (printReportBtn) {
    printReportBtn.addEventListener("click", printReport);
  }
}

async function handleFileList(fileList) {
  const files = [...fileList].filter((file) => file.size <= 1024 * 1024 && getExtension(file.name) in LANGUAGE_MAP);
  if (!files.length) { showToast("1MB 이하의 코드 파일을 선택하세요.", "warn"); return; }
  await runAnalysis(files, "Auto analysis");
}

function upsertFiles(files) {
  const byName = new Map(state.files.map((file) => [file.name, file]));
  files.forEach((file) => byName.set(file.name, file));
  state.files = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  state.selectedFileId = files[0]?.id || state.files[0]?.id || null;
  injectDuplicateFindings();
}

function hashContent(str) {
  // Normalize before hashing: CRLF → LF, trailing whitespace stripped per line, final newline removed
  const normalized = str
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .trimEnd();
  let h = 5381;
  for (let i = 0; i < normalized.length; i++) {
    h = ((h << 5) + h) ^ normalized.charCodeAt(i);
    h = h >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function injectDuplicateFindings() {
  const byHash = new Map();
  state.files.forEach((f) => {
    if (!f.contentHash) return;
    if (!byHash.has(f.contentHash)) byHash.set(f.contentHash, []);
    byHash.get(f.contentHash).push(f.name);
  });

  state.files = state.files.map((f) => {
    const group = byHash.get(f.contentHash) || [];
    const others = group.filter((n) => n !== f.name);
    if (!others.length) return f;

    const dupFinding = {
      severity: "critical",
      message: `이 파일은 ${others.map((n) => `"${n}"`).join(", ")}과(와) 내용이 완전히 동일합니다(해시: ${f.contentHash}). 리팩토링이 실제로 적용되지 않았거나 파일이 잘못 복사되었을 수 있습니다.`,
    };
    const deduped = f.findings.filter((fn) => !fn.message.includes("내용이 완전히 동일"));
    return { ...f, findings: [dupFinding, ...deduped].slice(0, 12) };
  });
}

function stripStringLiterals(src) {
  return src
    .replace(/f?"""[\s\S]*?"""/g, '""')
    .replace(/f?'''[\s\S]*?'''/g, "''")
    .replace(/`[\s\S]*?`/g, "``")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

function analyzeFile(name, content) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const extension = getExtension(name);
  const language = LANGUAGE_MAP[extension] || "Unknown";
  const nonEmptyLines = lines.filter((line) => line.trim()).length;
  const commentLines = countCommentLines(lines, language);

  // Strip string literals before counting branches / magic numbers to avoid false positives
  // from f-string prompt text, JSON schemas inside strings, etc.
  const codeOnly = stripStringLiterals(content);
  const branchCount = countMatches(codeOnly, /\b(if|else if|for|foreach|while|case|catch|except|when|match|switch|elif|guard)\b/g) + countMatches(codeOnly, /(\|\||&&|\?)/g);
  const maxNesting = estimateMaxNesting(lines, language);
  const longLines = lines.filter((line) => line.length > 120).length;
  const veryLongLines = lines.filter((line) => line.length > 200).length;
  // Count only genuine function/method definitions; avoid double-counting async def
  const functions = language === "Python"
    ? countMatches(content, /^\s*(?:async\s+)?def\s+\w|^\s*class\s+\w/gm)
    : countMatches(content, /\b(function|func|fn)\b|\bdef\s|\b(public|private|protected)\s+\w[\w<>[\]]*\s+\w+\s*\(|=>/g);
  const dependencies = extractDependencies(content, language);
  const testSignals = countMatches(content, /\b(test|describe|it|expect|assert|should|mock|fixture|spec)\b/gi);
  const assertionSignals = countMatches(content, /\b(assert|expect|toEqual|toBe|should|verify|assertThat)\b/gi);
  const bugPatterns = findBugSignals(content, language);
  const duplicateScore = estimateDuplication(lines);
  const magicNumbers = countMatches(codeOnly, /(?<!\w)\d{3,}(?!\w)/g);
  const hardcodedSecrets = bugPatterns.filter(p => p.severity === 'critical' && p.message.includes('비밀값')).length;
  
  const avgFuncLen = functions > 0 ? Math.round(nonEmptyLines / functions) : nonEmptyLines;
  const branchDensity = (branchCount / Math.max(1, nonEmptyLines)) * 100;
  // Use branches-per-function to avoid penalizing files that are large due to
  // having many well-decomposed functions rather than a few huge ones.
  const branchPerFunc = functions > 0 ? branchCount / functions : branchCount;

  const complexity = clamp(Math.round(
    Math.min(branchPerFunc * 6, 36) +    // max 36 pts: branch density per function
    maxNesting * 6 +                      // each nesting level 6 pts (max ~60 if depth 10)
    Math.min(longLines * 1.2, 15) +      // max 15 pts from very long lines
    Math.min(magicNumbers * 2, 10) +     // max 10 pts
    Math.max(0, avgFuncLen - 25) * 0.8 + // penalise functions over 25 lines
    branchDensity * 0.2                   // minor penalty for dense branching
  ), 0, 100);
  
  const docstringMatches = content.match(/("""|''')/g) || [];
  const docstringScore = docstringMatches.length / 2 * 5;
  const documentation = clamp(Math.round(
    (commentLines / Math.max(1, nonEmptyLines)) * 200 + 
    docstringScore +
    (hasReadmeStyleContent(content) ? 20 : 0)
  ), 0, 100);
  
  const hasTestPeer = state.files.some(f => {
    if (f.name === name || !isTestFile(f.name)) return false;
    const baseName = name.replace(/\.[^.]+$/, '');
    const peerBase = f.name.replace(/\.[^.]+$/, '').replace(/^test[_-]|[_-]test$/, '').replace(/^test/, '');
    return f.name.includes(baseName) || baseName.includes(peerBase);
  });

  const coverage = clamp(
    Math.round(
      (isTestFile(name) ? 75 : 30) +
        (hasTestPeer ? 20 : 0) +
        testSignals * 4.0 +
        assertionSignals * 3.0 +
        documentation * 0.10 -
        complexity * 0.20 -
        bugPatterns.length * 1.5
    ),
    5,
    95
  );
  
  const bugs = clamp(Math.round(
    bugPatterns.length + 
    complexity / 25 + 
    hardcodedSecrets * 3 +
    Math.max(0, dependencies.length - 5) / 1.5
  ), 0, 99);
  
  const nestedLoops = countMatches(content, /\b(for|while)\b[\s\S]{0,120}\b(for|while)\b/g);
  const syncBlockingCalls = countMatches(
    content,
    /fs\.(readFileSync|writeFileSync|appendFileSync|mkdirSync)\s*\(|os\.system\s*\(|subprocess\.[a-zA-Z]+\s*\((?![^)]*shell\s*=\s*False)/g
  );
  const performance = clamp(Math.round(
    95 -
    complexity * 0.35 -
    nestedLoops * 10 -
    longLines * 0.7 -
    syncBlockingCalls * 8
  ), 5, 100);
  
  const maintainability = clamp(Math.round(
    95 - 
    complexity * 0.42 - 
    duplicateScore * 1.2 - 
    veryLongLines * 2 -
    Math.max(0, dependencies.length - 6) * 2.5 + 
    documentation * 0.2
  ), 5, 100);
  
  const testQuality = clamp(Math.round(
    (isTestFile(name) ? 70 : 35) + 
    assertionSignals * 9 + 
    testSignals * 6 - 
    bugs * 3.5 + 
    coverage * 0.2
  ), 0, 100);
  
  const qualityScore = clamp(
    Math.round(
      maintainability * 0.25 +
        performance * 0.18 +
        coverage * 0.12 +
        documentation * 0.10 +
        testQuality * 0.10 +
        (100 - complexity) * 0.15 +
        Math.max(0, 100 - bugs * 8) * 0.10
    ),
    0,
    100
  );
  const metrics = {
    complexity,
    coverage,
    bugs,
    performance,
    maintainability,
    documentation,
    testQuality,
    dependencies: dependencies.length,
    qualityScore
  };

  return {
    id: `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name,
    language,
    extension,
    size: content.length,
    lineCount: lines.length,
    loc: nonEmptyLines,
    commentLines,
    functions,
    dependencies,
    content,
    contentHash: hashContent(content),
    metrics,
    findings: buildFindings(metrics, bugPatterns, dependencies, { lineCount: lines.length, functions, maxNesting })
  };
}

function buildFindings(metrics, bugPatterns, dependencies, context) {
  const thr = (state && state.thresholds) ? state.thresholds : DEFAULT_THRESHOLDS;
  const findings = [];
  if (metrics.complexity >= thr.complexityCrit) findings.push({ severity: "critical", message: `복잡도가 매우 높습니다(${metrics.complexity}/100). 조건 분기와 중첩 로직을 더 작은 함수로 나누고, 조기 반환(Early Return)을 적용해 읽기 쉽게 리팩토링하세요.` });
  else if (metrics.complexity >= thr.complexityWarn) findings.push({ severity: "high", message: `복잡도가 높은 편입니다(${metrics.complexity}/100). 핵심 분기 경로를 분리하고, 각 함수의 책임을 단일 책임 원칙에 맞춰 재설계하세요. 테스트 케이스도 보강해야 합니다.` });

  if (metrics.bugs >= thr.bugsCrit) findings.push({ severity: "critical", message: `잠재 버그 신호가 매우 많습니다(${metrics.bugs}개). 예외 처리, 입력 검증, 하드코딩된 비밀값, 디버그 코드 제거를 최우선으로 검토하세요.` });
  else if (metrics.bugs >= thr.bugsWarn) findings.push({ severity: "high", message: `버그 위험도가 높습니다(${metrics.bugs}개). 모든 실패 경로에 대한 테스트와 경계값 검증을 추가하세요. null/undefined 처리도 점검하세요.` });

  if (metrics.coverage < thr.coverageLow) findings.push({ severity: "high", message: `테스트 신호가 매우 약합니다(${metrics.coverage}/100). 테스트 파일을 프로젝트에 추가하고, 주요 함수에 assert/expect를 사용하세요.` });
  else if (metrics.coverage < thr.coverageWarn) findings.push({ severity: "medium", message: `테스트가능성 점수가 낮습니다(${metrics.coverage}/100). 테스트 파일이 감지되지 않았거나 assertion이 부족합니다.` });
  
  if (metrics.documentation < thr.documentationLow) findings.push({ severity: "medium", message: `문서화 비율이 매우 낮습니다(${metrics.documentation}/100). 모든 공개 API와 복잡한 비즈니스 로직에 대해 docstring과 인라인 주석을 추가하세요.` });

  if (metrics.performance < thr.performanceLow) findings.push({ severity: "medium", message: `성능 점수가 낮습니다(${metrics.performance}/100). 반복문 중첩 개선, 불필요한 동기 작업 제거, 캐싱 적용을 고려하세요.` });

  if (metrics.maintainability < thr.maintainabilityLow) findings.push({ severity: "medium", message: `유지보수성이 낮습니다(${metrics.maintainability}/100). 긴 함수 분할, 중복 로직 제거, 의존성 분리를 통해 모듈 크기를 줄이세요.` });
  
  if (dependencies.length > 10) findings.push({ severity: "low", message: `외부 의존성이 많습니다(${dependencies.length}개). 사용하지 않는 라이브러리를 제거하고, 내장 기능으로 대체 가능한지 검토하세요.` });
  
  if (context.lineCount > 400) findings.push({ severity: "medium", message: `파일이 매우 큽니다(${context.lineCount}줄). 기능 단위로 모듈을 분리하면 리뷰와 테스트가 쉬워집니다. 단일 파일은 300줄 이하를 유지하는 것이 업계 표준입니다.` });
  
  if (context.maxNesting >= 4) findings.push({ severity: "high", message: `중첩 깊이가 매우 깊습니다(${context.maxNesting}단계). 가드 절(Guard Clause)과 조기 반환을 활용해 읽기 흐름을 단순화하세요. 최대 3단계를 유지하는 것이 좋습니다.` });
  
  bugPatterns.slice(0, 6).forEach((pattern) => findings.push(pattern));
  return findings.slice(0, 12);
}

function findBugSignals(content, language) {
  const signals = [];
  const isJS  = language === "JavaScript" || language === "TypeScript";
  const isPy  = language === "Python";
  const codeOnly = stripStringLiterals(content);

  // Universal checks (run on code-only to avoid string false positives)
  const universal = [
    [/\beval\s*\(/g, "critical", "eval() 사용은 심각한 보안 위험입니다. 절대 프로덕션 코드에서 사용하지 마세요."],
    [/(api[_-]?key|secret|password|token|access_key|secret_key)\s*[:=]\s*["'][^"']{8,}["']/gi, "critical", "하드코딩된 인증 정보/비밀값이 코드에 있습니다. 즉시 환경 변수나 안전한 비밀 저장소로 이동하세요."],
    [/TODO|FIXME|HACK|XXX/gi, "medium", "미해결 TODO/FIXME/HACK이 있습니다. 릴리스 전 이슈로 전환하거나 정리하세요."],
  ];

  // JS/TS-only checks
  const jsChecks = [
    [/\bvar\s/g, "low", "var 키워드를 사용합니다. let/const로 교체해 스코프 오류를 방지하세요."],
    [/catch\s*\([^)]*\)\s*\{\s*\}/g, "high", "빈 catch 블록이 있습니다. 최소한 로그를 남겨야 합니다."],
    [/setTimeout\s*\(["']/g, "critical", "setTimeout에 문자열을 전달하면 eval과 같습니다. 화살표 함수로 변경하세요."],
    [/__proto__|prototype\[|constructor\[/g, "critical", "프로토타입 오염 패턴이 감지됐습니다. allowlist 검증을 추가하세요."],
    [/\.innerHTML\s*=|document\.write\s*\(/g, "critical", "DOM XSS 취약점: innerHTML/document.write에 사용자 입력이 들어갈 수 있습니다. textContent 또는 DOMPurify를 사용하세요."],
    [/fs\.(readFileSync|writeFileSync|appendFileSync|mkdirSync)\s*\(/g, "high", "동기 파일 I/O가 이벤트 루프를 블로킹합니다. fs.promises API로 변경하세요."],
    [/res\.redirect\s*\(.*req\.(query|params|body)/g, "critical", "오픈 리다이렉트: 사용자 입력 URL로 리다이렉트합니다. 허용 도메인 목록으로 검증하세요."],
    [/\bany\b/g, "medium", "TypeScript any 타입은 타입 안전성을 제거합니다. unknown으로 교체 후 타입 가드를 사용하세요."],
    [/[^=!]==[^=]|!=[^=]/g, "medium", "느슨한 동등 비교(==/!=)입니다. ===, !== 으로 교체하세요."],
    [/\bwhile\s*\(true\)|for\s*\(;;\)/g, "medium", "무한 루프가 감지됐습니다. 종료 조건을 명확히 해주세요."],
    [/\bdebugger\b|console\.log\(/g, "low", "디버그 코드가 남아 있습니다. 프로덕션 배포 전 제거하세요."],
    [/["'`]\s*\+\s*(?:req|request|params|query|body|input|user)\b/g, "critical", "SQL 인젝션: 사용자 입력을 문자열 연결로 SQL에 삽입합니다. 파라미터화된 쿼리를 사용하세요."],
  ];

  // Python-only checks
  const pyChecks = [
    [/except\s*:\s*\n\s*pass/g, "high", "except: pass 패턴은 모든 예외를 무시합니다. 구체적인 예외 타입과 로깅을 추가하세요."],
    [/except\s*:\s*$/gm, "high", "bare except가 있습니다. except Exception as e: 형식으로 구체화하세요."],
    // except Exception as e: 뒤에 로깅 없이 pass/return만 있는 경우만 플래그
    [/except\s+Exception\s+as\s+\w+\s*:\s*\n\s*(?:pass|return\s+(?:None|{}|\[\]))/g, "high", "except Exception 후 아무 처리 없이 패스/반환합니다. 원인 로깅을 추가하세요."],
    [/\.execute\s*\(.*(?:%s|\.format\s*\(|f["'])/g, "critical", "SQL 인젝션: Python f-string/.format()으로 SQL을 조합합니다. cursor.execute(sql, (params,)) 형식을 사용하세요."],
    [/hashlib\.(md5|sha1)\b/g, "high", "취약한 해시(MD5/SHA1)가 감지됐습니다. hashlib.sha256 이상을 사용하세요."],
    [/os\.system\s*\(|subprocess\.[a-zA-Z_]+\s*\([^)]*shell\s*=\s*True/g, "critical", "셸 인젝션: os.system()/shell=True는 명령어 인젝션을 허용합니다. 리스트 형식 인수를 사용하세요."],
    // Python-specific real issues the previous system missed
    [/^\s{4,}(?:import\s+\w|from\s+\w+\s+import)/gm, "medium", "함수 내부 임포트가 있습니다. 모듈 수준으로 이동하면 성능과 가독성이 향상됩니다."],
    [/^[A-Z_]{3,}\s*(?::\s*dict\[|=\s*\{)/gm, "low", "가변 전역 딕셔너리입니다. types.MappingProxyType()으로 불변 처리를 권장합니다."],
    [/\bdatetime\.utcnow\(\)/g, "medium", "datetime.utcnow()는 Python 3.12에서 deprecated입니다. datetime.now(timezone.utc)로 교체하세요."],
  ];

  const activeChecks = [
    ...universal,
    ...(isJS ? jsChecks : []),
    ...(isPy ? pyChecks : []),
  ];

  activeChecks.forEach(([regex, severity, message]) => {
    if (regex.source.includes("api[_-]?key") || regex.source.includes("execute")) {
      // Run on original content for these (need string context)
      if (content.match(regex)) signals.push({ severity, message });
    } else {
      if (codeOnly.match(regex)) signals.push({ severity, message });
    }
  });

  return signals;
}

function extractDependencies(content, language) {
  const dependencies = new Set();
  const importPatterns = [
    /import\s+(?:[^"']+\s+from\s+)?["']([^"'.][^"']*)["']/g,
    /require\(["']([^"'.][^"']*)["']\)/g,
    /from\s+([a-zA-Z_][\w.]*)\s+import/g,
    /using\s+([A-Za-z0-9_.]+);/g,
    /use\s+([A-Za-z0-9_:]+)::/g,
    /#include\s+[<"]([^>"]+)[>"]/g
  ];
  importPatterns.forEach((pattern) => {
    let match = pattern.exec(content);
    while (match) {
      const dependency = match[1].split(/[/:.]/)[0];
      if (dependency && dependency.length > 1) dependencies.add(dependency);
      match = pattern.exec(content);
    }
  });
  if (language === "PHP") {
    const composerMatches = content.match(/use\s+[A-Z][\w\\]+/g) || [];
    composerMatches.forEach((item) => dependencies.add(item.replace(/^use\s+/, "").split("\\")[0]));
  }
  return [...dependencies];
}

function countCommentLines(lines, language) {
  const singleLineMarkers = ["//", "#", "--"];
  let inBlock = false;
  let count = 0;
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (inBlock) {
      count += 1;
      if (trimmed.includes("*/") || trimmed.includes('"""') || trimmed.includes("'''")) inBlock = false;
      return;
    }
    if (trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.startsWith('"""') || trimmed.startsWith("'''")) {
      count += 1;
      if (!trimmed.includes("*/") && !(trimmed.endsWith('"""') && trimmed.length > 3) && !(trimmed.endsWith("'''") && trimmed.length > 3)) inBlock = true;
      return;
    }
    if (singleLineMarkers.some((marker) => trimmed.startsWith(marker))) count += 1;
    if (language === "HTML" && (trimmed.startsWith("<!--") || trimmed.includes("-->"))) count += 1;
  });
  return count;
}

// Regex matching lines that open a new Python block (not continuation lines)
const PY_BLOCK_STARTER = /^\s*(if|elif|else\s*:|for|while|try\s*:|except|finally\s*:|with|def|class|async\s+def)\b/;

function estimateMaxNesting(lines, language) {
  if (language === "Python") {
    // Measure indentation only at block-opening keywords to avoid counting
    // expression-continuation lines (e.g. ternary / function-call continuations)
    // that happen to be heavily indented for alignment.
    let max = 0;
    let tripleQuoteOpen = false;
    lines.forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const tripleMatches = (trimmed.match(/"""|'''/g) || []).length;
      if (tripleMatches % 2 !== 0) tripleQuoteOpen = !tripleQuoteOpen;
      if (tripleQuoteOpen || trimmed.startsWith("#")) return;
      if (!PY_BLOCK_STARTER.test(line)) return;
      const indent = line.match(/^\s*/)[0].replace(/\t/g, "    ").length;
      max = Math.max(max, Math.floor(indent / 4));
    });
    return clamp(max, 0, 10);
  }
  // C-like languages: count only { } in code (not inside strings)
  const stripped = stripStringLiterals(lines.join("\n"));
  let current = 0;
  let max = 0;
  stripped.split("\n").forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const closes = (trimmed.match(/\}/g) || []).length;
    current = Math.max(0, current - closes);
    const opens = (trimmed.match(/\{/g) || []).length;
    max = Math.max(max, current + opens);
    current += opens;
  });
  return clamp(max, 0, 10);
}

function estimateDuplication(lines) {
  const normalized = lines.map((line) => line.trim()).filter((line) => line.length > 12 && !line.startsWith("//") && !line.startsWith("#"));
  const seen = new Set();
  let duplicates = 0;
  normalized.forEach((line) => {
    if (seen.has(line)) duplicates += 1;
    seen.add(line);
  });
  return duplicates;
}

function hasReadmeStyleContent(content) {
  return /README|@param|@returns|Args:|Returns:|Example:/i.test(content);
}

function getExtension(name) {
  const match = name.toLowerCase().match(/\.([^.]+)$/);
  return match ? match[1] : "";
}

function isTestFile(name) {
  return /(^|[._-])(test|spec|tests)([._-]|$)/i.test(name) || /\.(test|spec)\./i.test(name);
}

function getSummary() {
  const files = state.files;
  const safeAverage = (selector) => (files.length ? files.reduce((sum, file) => sum + selector(file), 0) / files.length : 0);
  const languages = new Set(files.map((file) => file.language));
  return {
    totalFiles: files.length,
    totalLines: files.reduce((sum, file) => sum + (file.lineCount || 0), 0),
    avgComplexity: safeAverage((file) => file.metrics?.complexity || 0),
    avgCoverage: safeAverage((file) => file.metrics?.coverage || 0),
    avgPerformance: safeAverage((file) => file.metrics?.performance || 0),
    avgQuality: safeAverage((file) => file.metrics?.qualityScore || 0),
    totalBugs: files.reduce((sum, file) => sum + (file.metrics?.bugs || 0), 0),
    totalReviews: state.reviews.length,
    languageCount: languages.size
  };
}

function getSelectedFile() {
  return state.files.find((file) => file.id === state.selectedFileId) || state.files[0] || null;
}

function getFilteredFiles() {
  const search = state.searchTerm.trim().toLowerCase();
  if (!search) return state.files;
  return state.files.filter((file) => `${file.name} ${file.language}`.toLowerCase().includes(search));
}

function getVisibleReviews(fileId) {
  const rank = { critical: 4, high: 3, medium: 2, low: 1 };
  let reviews = state.reviews.filter((review) => review.fileId === fileId);
  if (state.severityFilter !== "all") reviews = reviews.filter((review) => review.severity === state.severityFilter);
  reviews = reviews.slice();
  if (state.reviewSort === "oldest") reviews.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  else if (state.reviewSort === "severity") reviews.sort((a, b) => rank[b.severity] - rank[a.severity]);
  else reviews.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return reviews;
}

function createSnapshot(label) {
  if (!state.files.length) return;
  const timestamp = new Date().toISOString();
  const version = {
    id: crypto.randomUUID(),
    label: `${label} ${state.versions.length + 1}`,
    createdAt: timestamp,
    appVersion: APP_VERSION,
    summary: getSummary(),
    files: state.files.map((file) => ({
      ...file,
      content: file.content.slice(0, 20000)
    })),
    reviews: state.reviews.slice()
  };
  state.versions = [version, ...state.versions].slice(0, 20);
}

function downloadRefactoredFile(file) {
  const content = generateRefactoredCode(file);
  downloadBlob(file.name, content, "text/plain;charset=utf-8");
}

function downloadAllRefactoredFiles() {
  if (!state.files.length) return;

  const divider = (file, index) =>
    `// ${"=".repeat(60)}\n// [${index + 1}/${state.files.length}] ${file.name} · ${file.language} · ${file.lineCount} lines\n// ${"=".repeat(60)}\n`;

  const merged = state.files
    .map((file, index) => divider(file, index) + generateRefactoredCode(file))
    .join("\n\n\n");

  downloadBlob("refactored-all.txt", merged, "text/plain;charset=utf-8");
}

function exportReport(format) {
  const payload = buildExportPayload();
  if (format === "json") {
    downloadBlob("code-review-report.json", JSON.stringify(payload, null, 2), "application/json");
  } else if (format === "csv") {
    downloadBlob("code-review-report.csv", buildCsv(payload.files), "text/csv;charset=utf-8");
  } else {
    downloadBlob("code-review-report.html", buildHtmlReport(payload), "text/html;charset=utf-8");
  }
}

function buildExportPayload() {
  return {
    appVersion: APP_VERSION,
    generatedAt: new Date().toISOString(),
    summary: getSummary(),
    files: state.files.map((file) => ({
      name: file.name,
      language: file.language,
      lineCount: file.lineCount,
      loc: file.loc,
      commentLines: file.commentLines,
      functions: file.functions,
      dependencies: file.dependencies,
      metrics: file.metrics,
      findings: file.findings
    })),
    reviews: state.reviews.map((review) => ({
      fileName: state.files.find((file) => file.id === review.fileId)?.name || "Unknown",
      severity: review.severity,
      text: review.text,
      createdAt: review.createdAt
    })),
    versions: state.versions.map((version) => ({
      label: version.label,
      createdAt: version.createdAt,
      summary: version.summary
    }))
  };
}

function buildCsv(files) {
  const header = ["Filename", "Language", "Lines", "Complexity", "Coverage", "Bugs", "Performance", "Maintainability", "Documentation", "TestQuality", "Dependencies", "QualityScore"];
  const rows = files.map((file) => [
    file.name,
    file.language,
    file.lineCount,
    file.metrics.complexity,
    file.metrics.coverage,
    file.metrics.bugs,
    file.metrics.performance,
    file.metrics.maintainability,
    file.metrics.documentation,
    file.metrics.testQuality,
    file.metrics.dependencies,
    file.metrics.qualityScore
  ]);
  return [header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n");
}

function buildHtmlReport(payload) {
  const rows = payload.files
    .map(
      (file) => `
        <tr>
          <td>${escapeHtml(file.name)}</td>
          <td>${escapeHtml(file.language)}</td>
          <td>${file.lineCount}</td>
          <td>${file.metrics.complexity}</td>
          <td>${file.metrics.coverage}%</td>
          <td>${file.metrics.bugs}</td>
          <td>${file.metrics.qualityScore}</td>
        </tr>
      `
    )
    .join("");
  const reviewRows = payload.reviews
    .map(
      (review) => `
        <li><strong>${escapeHtml(review.severity)}</strong> ${escapeHtml(review.fileName)}: ${escapeHtml(review.text)}</li>
      `
    )
    .join("");
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <title>Code Review Report</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 32px; color: #1f2937; }
    h1 { margin-bottom: 4px; }
    table { border-collapse: collapse; width: 100%; margin: 24px 0; }
    th, td { border: 1px solid #d1d5db; padding: 8px; text-align: left; }
    th { background: #f3f4f6; }
    .summary { display: flex; gap: 16px; flex-wrap: wrap; }
    .summary div { border: 1px solid #d1d5db; padding: 12px; min-width: 140px; }
    @media print { body { margin: 16px; } }
  </style>
</head>
<body>
  <h1>Code Review Report</h1>
  <p>Generated at ${escapeHtml(formatDateTime(payload.generatedAt))}</p>
  <section class="summary">
    <div><strong>${payload.summary.totalFiles}</strong><br>Files</div>
    <div><strong>${formatNumber(payload.summary.avgQuality)}</strong><br>Average quality</div>
    <div><strong>${formatNumber(payload.summary.avgCoverage)}%</strong><br>Average coverage</div>
    <div><strong>${payload.summary.totalReviews}</strong><br>Reviews</div>
  </section>
  <table>
    <thead>
      <tr><th>File</th><th>Language</th><th>Lines</th><th>Complexity</th><th>Coverage</th><th>Bugs</th><th>Quality</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <h2>Review Comments</h2>
  <ul>${reviewRows || "<li>No review comments.</li>"}</ul>
</body>
</html>`;
}

function downloadBlob(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function getMetricTone(metric, value) {
  if (metric.good === "low") {
    if (metric.key === "bugs") {
      if (value <= 2) return "good";
      if (value <= 5) return "warn";
      return "bad";
    }
    if (metric.key === "dependencies") {
      if (value <= 4) return "good";
      if (value <= 8) return "warn";
      return "bad";
    }
    if (value <= 35) return "good";
    if (value <= 55) return "warn";
    return "bad";
  }
  if (value >= 75) return "good";
  if (value >= 55) return "warn";
  return "bad";
}

function getRiskTone(metrics) {
  // metrics가 undefined/null이거나 필요한 필드가 없을 때 기본값 제공
  const qualityScore = metrics?.qualityScore ?? 60;
  const bugs = metrics?.bugs ?? 0;
  if (qualityScore >= 75 && bugs < 5) return "good";
  if (qualityScore >= 55 && bugs < 8) return "warn";
  return "bad";
}

function getRiskLabel(metrics) {
  // metrics가 undefined/null이거나 필요한 필드가 없을 때 기본값 제공
  const qualityScore = metrics?.qualityScore ?? 60;
  const bugs = metrics?.bugs ?? 0;
  if (qualityScore >= 75 && bugs < 5) return "Good";
  if (qualityScore >= 55 && bugs < 8) return "Watch";
  return "Risk";
}

function getPortfolioHealth(summary) {
  if (!summary.totalFiles) return { label: "Ready", tone: "neutral" };
  if (summary.avgQuality >= 75 && summary.totalBugs <= summary.totalFiles * 4) return { label: "Healthy", tone: "good" };
  if (summary.avgQuality >= 55) return { label: "Needs review", tone: "warn" };
  return { label: "High risk", tone: "bad" };
}

function inferSeverity(text) {
  const value = text.toLowerCase();
  if (/security|crash|data loss|secret|injection|critical/.test(value)) return "critical";
  if (/bug|error|fail|null|exception|race/.test(value)) return "high";
  if (/test|refactor|performance|coverage|complex/.test(value)) return "medium";
  return "low";
}

function countMatches(text, regex) {
  return (text.match(regex) || []).length;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function formatNumber(value) {
  return Number(value || 0).toFixed(Number(value || 0) % 1 === 0 ? 0 : 1);
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatShortDate(value) {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function capitalize(text) {
  return text.slice(0, 1).toUpperCase() + text.slice(1);
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#096;");
}

function escapeSvg(value) {
  return escapeHtml(value);
}

function persistAndRender() {
  persistState();
  render();
}
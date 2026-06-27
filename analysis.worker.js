"use strict";
// ═══════════════════════════════════════════════════════════════════════
// analysis.worker.js — Token-based AST analysis + Cross-file analysis
// JS/TS: character-level tokenizer (handles strings, comments, regex)
// Python: line-level state machine (handles triple-quotes, indentation)
// ═══════════════════════════════════════════════════════════════════════

const LANGUAGE_MAP = {
  py:"Python", js:"JavaScript", jsx:"JavaScript", ts:"TypeScript", tsx:"TypeScript",
  java:"Java", cpp:"C++", cc:"C++", cxx:"C++", c:"C", h:"C/C++ Header",
  hpp:"C++ Header", cs:"C#", go:"Go", rs:"Rust", rb:"Ruby", php:"PHP",
  swift:"Swift", kt:"Kotlin", kts:"Kotlin", scala:"Scala", sc:"Scala",
  sql:"SQL", sh:"Shell", ps1:"PowerShell", html:"HTML", css:"CSS",
  json:"JSON", yml:"YAML", yaml:"YAML", md:"Markdown",
};

const DEFAULT_THRESHOLDS = {
  complexityWarn: 55, complexityCrit: 75,
  coverageLow: 40,    coverageWarn: 65,
  bugsWarn: 5,        bugsCrit: 8,
  maintainabilityLow: 55, performanceLow: 55,
  documentationLow: 35,  testQualityLow: 75,
};

// ═══ Utilities ═══════════════════════════════════════════════════════

function clamp(v, mn, mx) { return Math.min(Math.max(v, mn), mx); }
function countMatches(str, re) { const m = str.match(re); return m ? m.length : 0; }
function getExtension(name) { const m = name.toLowerCase().match(/\.([^.]+)$/); return m ? m[1] : ""; }
function hashContent(str) {
  const n = str.replace(/\r\n/g,"\n").split("\n").map(l=>l.trimEnd()).join("\n").trimEnd();
  let h = 5381;
  for (let i = 0; i < n.length; i++) { h = ((h<<5)+h)^n.charCodeAt(i); h = h>>>0; }
  return h.toString(16).padStart(8,"0");
}
function isTestFile(name) {
  return /(^|[._/-])(test|spec|tests)([._/-]|$)/i.test(name) || /\.(test|spec)\./i.test(name) ||
    /^test_.*\.(py|js|ts)$/.test(name.split(/[/\\]/).pop()) ||
    /(Test|Spec)\.(java|kt|cs|go|rb)$/.test(name);
}

// ═══ String stripping ════════════════════════════════════════════════

function stripStringLiterals(src) {
  return src
    .replace(/f?"""[\s\S]*?"""/g, '""')
    .replace(/f?'''[\s\S]*?'''/g, "''")
    .replace(/`[\s\S]*?`/g, "``")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''");
}

// ═══ Per-file analysis ═══════════════════════════════════════════════

const PY_BLOCK = /^\s*(if|elif|else\s*:|for|while|try\s*:|except|finally\s*:|with|def|class|async\s+def)\b/;

function countCommentLines(lines, language) {
  const single = ["//","#","--"];
  let inBlock = false, count = 0;
  lines.forEach(line => {
    const t = line.trim();
    if (!t) return;
    if (inBlock) {
      count++;
      if (t.includes("*/") || t.includes('"""') || t.includes("'''")) inBlock = false;
      return;
    }
    if (t.startsWith("/*")||t.startsWith("*")||t.startsWith('"""')||t.startsWith("'''")) {
      count++;
      if (!t.includes("*/") && !(t.endsWith('"""')&&t.length>3) && !(t.endsWith("'''")&&t.length>3)) inBlock = true;
      return;
    }
    if (single.some(m => t.startsWith(m))) count++;
    if (language==="HTML" && (t.startsWith("<!--")||t.includes("-->"))) count++;
  });
  return count;
}

function estimateMaxNesting(lines, language) {
  if (language === "Python") {
    let max = 0, tqOpen = false;
    lines.forEach(line => {
      const t = line.trim();
      if (!t) return;
      const tq = (t.match(/"""|'''/g)||[]).length;
      if (tq%2 !== 0) tqOpen = !tqOpen;
      if (tqOpen || t.startsWith("#")) return;
      if (!PY_BLOCK.test(line)) return;
      const indent = line.match(/^\s*/)[0].replace(/\t/g,"    ").length;
      max = Math.max(max, Math.floor(indent/4));
    });
    return clamp(max, 0, 10);
  }
  const stripped = stripStringLiterals(lines.join("\n"));
  let cur = 0, max = 0;
  stripped.split("\n").forEach(line => {
    const t = line.trim();
    if (!t) return;
    const cl = (t.match(/\}/g)||[]).length;
    cur = Math.max(0, cur - cl);
    const op = (t.match(/\{/g)||[]).length;
    max = Math.max(max, cur + op);
    cur += op;
  });
  return clamp(max, 0, 10);
}

// ═══ JS/TS token-based AST analyzer ═════════════════════════════════

function analyzeJS(src) {
  // Returns { complexity, maxNesting, functions[], functionCount }
  // complexity = total cyclomatic complexity (sum of all function CCs)
  // functions[]: { name, startLine, endLine, loc, complexity, params, maxNesting }

  const BRANCH_KW = new Set(['if','for','while','do','switch','case','catch']);
  let i = 0, n = src.length, depth = 0, maxDepth = 0, totalCC = 1, line = 1;
  let prevWasValue = false;
  const funcStack = [], completed = [];

  function cf() { return funcStack[funcStack.length - 1]; }
  function addBranch() { totalCC++; if (cf()) cf().complexity++; }
  function skipWS() { while (i < n && (src[i]===' '||src[i]==='\t'||src[i]==='\r')) i++; }

  function scanStr(q) {
    i++;
    while (i < n && src[i] !== q) {
      if (src[i]==='\\') { if (src[i+1]==='\n') line++; i+=2; continue; }
      if (src[i]==='\n') line++;
      i++;
    }
    i++;
  }

  function scanTemplate() {
    i++; // skip `
    while (i < n) {
      if (src[i]==='\\') { i+=2; continue; }
      if (src[i]==='\n') line++;
      if (src[i]==='`') { i++; break; }
      if (src[i]==='$' && src[i+1]==='{') {
        i += 2;
        let bd = 1;
        while (i < n && bd > 0) {
          if (src[i]==='{') bd++;
          else if (src[i]==='}') { bd--; if (!bd) { i++; break; } }
          else if (src[i]==='\n') line++;
          else if (src[i]==='"'||src[i]==="'") { scanStr(src[i]); continue; }
          else if (src[i]==='`') { scanTemplate(); continue; }
          i++;
        }
        continue;
      }
      i++;
    }
  }

  function scanRegex() {
    i++;
    while (i < n && src[i] !== '/' && src[i] !== '\n') {
      if (src[i]==='\\') { i+=2; continue; }
      if (src[i]==='[') { i++; while (i<n && src[i]!==']') { if(src[i]==='\\') i++; i++; } }
      i++;
    }
    if (src[i]==='/') i++;
    while (i < n && /[gimsuy]/.test(src[i])) i++;
  }

  function readIdent() {
    let j = i;
    while (j < n && /[a-zA-Z_$0-9]/.test(src[j])) j++;
    const w = src.slice(i, j); i = j; return w;
  }

  function readFuncName() {
    skipWS();
    if (src[i]==='*') { i++; skipWS(); }
    if (/[a-zA-Z_$]/.test(src[i]||'')) {
      let j = i; while (j<n && /[a-zA-Z_$0-9]/.test(src[j])) j++;
      const nm = src.slice(i, j); i = j; return nm;
    }
    return null;
  }

  function countParams() {
    skipWS();
    if (src[i] !== '(') return 0;
    i++;
    let d = 1, ps = '';
    while (i < n && d > 0) {
      if (src[i]==='(') d++;
      else if (src[i]===')') { d--; if (!d) { i++; break; } }
      else if (src[i]==='\n') line++;
      if (d > 0) ps += src[i];
      i++;
    }
    return ps.trim() ? ps.split(',').filter(s=>s.trim()).length : 0;
  }

  while (i < n) {
    const c = src[i];
    if (c==='\n') { line++; i++; prevWasValue=false; continue; }
    if (c==='\r'||c===' '||c==='\t') { i++; continue; }

    if (c==='/'&&src[i+1]==='/') { while(i<n&&src[i]!=='\n')i++; continue; }
    if (c==='/'&&src[i+1]==='*') {
      i+=2; while(i<n-1){if(src[i]==='\n')line++;if(src[i]==='*'&&src[i+1]==='/'){i+=2;break;}i++;} continue;
    }
    if (c==='/') { if(!prevWasValue){scanRegex();prevWasValue=true;}else{i++;prevWasValue=false;} continue; }
    if (c==='"'||c==="'") { scanStr(c); prevWasValue=true; continue; }
    if (c==='`') { scanTemplate(); prevWasValue=true; continue; }
    if (/[0-9]/.test(c)||(c==='.'&&/[0-9]/.test(src[i+1]||''))) {
      while(i<n&&/[0-9a-fA-FxXoObB_.]/.test(src[i]))i++;
      prevWasValue=true; continue;
    }

    if (/[a-zA-Z_$]/.test(c)) {
      const word = readIdent();
      if (BRANCH_KW.has(word)) { addBranch(); prevWasValue=false; continue; }
      if (word==='function') {
        const isAsync = prevWasValue===false && funcStack.length>0; // heuristic
        const name = readFuncName() || '(anonymous)';
        const params = countParams();
        funcStack.push({ name, depth, complexity:1, startLine:line, params, maxNesting:0, nestBase:depth });
        prevWasValue=false; continue;
      }
      const VALUE_KW = new Set(['this','true','false','null','undefined','NaN','Infinity','super']);
      const OP_KW = new Set(['return','throw','typeof','void','delete','new','in','instanceof','yield','await','case','of','from']);
      prevWasValue = VALUE_KW.has(word) || (!OP_KW.has(word) && !BRANCH_KW.has(word));
      continue;
    }

    if (c==='&'&&src[i+1]==='&') { addBranch(); i+=2; prevWasValue=false; continue; }
    if (c==='|'&&src[i+1]==='|') { addBranch(); i+=2; prevWasValue=false; continue; }
    if (c==='?'&&src[i+1]==='?'&&src[i+2]!=='=') { i+=2; prevWasValue=false; continue; }
    if (c==='?'&&src[i+1]!=='.'&&src[i+1]!=='?') { addBranch(); i++; prevWasValue=false; continue; }

    if (c==='='&&src[i+1]==='>') {
      // Arrow function: only push when body uses braces
      let k=i+2; while(k<n&&(src[k]===' '||src[k]==='\t'||src[k]==='\n'||src[k]==='\r'))k++;
      if (src[k]==='{') funcStack.push({ name:'(arrow)', depth, complexity:1, startLine:line, params:0, maxNesting:0, nestBase:depth });
      i+=2; prevWasValue=false; continue;
    }
    if ((c==='+'&&src[i+1]==='+')||(c==='-'&&src[i+1]==='-')) { i+=2; prevWasValue=true; continue; }

    if (c==='{') {
      depth++; maxDepth=Math.max(maxDepth,depth);
      const f=cf(); if(f) f.maxNesting=Math.max(f.maxNesting,depth-f.nestBase);
      i++; prevWasValue=false; continue;
    }
    if (c==='}') {
      depth--;
      while(funcStack.length>0&&funcStack[funcStack.length-1].depth>=depth){
        const f=funcStack.pop(); f.endLine=line; f.loc=f.endLine-f.startLine+1; completed.push(f);
      }
      i++; prevWasValue=true; continue;
    }
    if (c===')'||c===']') { i++; prevWasValue=true; continue; }
    if (c==='('||c==='['||c===','||c===';'||c===':') { i++; prevWasValue=false; continue; }
    i++; prevWasValue=false;
  }
  while(funcStack.length>0){
    const f=funcStack.pop(); f.endLine=line; f.loc=f.endLine-f.startLine+1; completed.push(f);
  }
  return { complexity:totalCC, maxNesting:clamp(maxDepth,0,10), functions:completed, functionCount:completed.length };
}

// ═══ Python line-based AST analyzer ══════════════════════════════════

function getPythonCodeLines(rawLines) {
  // Returns lines with strings/comments stripped; triple-quoted body lines → ''
  const out = [];
  let inTriple = false, tripleQ = '';
  for (const raw of rawLines) {
    if (inTriple) {
      const idx = raw.indexOf(tripleQ);
      if (idx !== -1) { inTriple=false; out.push(raw.slice(idx+3)); }
      else out.push('');
      continue;
    }
    let res = '', j = 0;
    while (j < raw.length) {
      if (raw[j]==='#') break;
      // Triple quote check
      if ((raw[j]==='"'||raw[j]==="'") && raw[j]===raw[j+1] && raw[j]===raw[j+2]) {
        const tq = raw[j].repeat(3);
        const end = raw.indexOf(tq, j+3);
        if (end !== -1) { j=end+3; res+=' '; continue; }
        inTriple=true; tripleQ=tq; res+=' '; break;
      }
      // Regular string
      if (raw[j]==='"'||raw[j]==="'") {
        const q=raw[j]; j++;
        while(j<raw.length&&raw[j]!==q){if(raw[j]==='\\')j++;j++;}
        j++; res+='""'; continue;
      }
      res+=raw[j]; j++;
    }
    out.push(res);
  }
  return out;
}

function analyzePython(src) {
  const rawLines = src.split('\n');
  const codeLines = getPythonCodeLines(rawLines);
  const n = rawLines.length;
  const functions = [];

  // Detect indent size (2 or 4 spaces)
  let indentSize = 4;
  for (const cl of codeLines) {
    const m = cl.match(/^( {2,})\S/);
    if (m) { indentSize = m[1].length <= 2 ? 2 : 4; break; }
  }

  for (let i = 0; i < n; i++) {
    const cl = codeLines[i].replace(/\t/g, ' '.repeat(indentSize));
    if (!cl.trim()) continue;

    const defMatch = cl.match(/^(\s*)(?:async\s+)?def\s+(\w+)/);
    if (!defMatch) continue;

    const funcIndent = defMatch[1].length;
    const funcName = defMatch[2];

    // Count params (scan to matching close paren, may span lines)
    let params = 0;
    const openIdx = cl.indexOf('(');
    if (openIdx !== -1) {
      let ps = '', pd = 0, scanning = false;
      outer: for (let pi = i; pi < Math.min(i+10, n); pi++) {
        const pl = (codeLines[pi]||'').replace(/\t/g, ' '.repeat(indentSize));
        const start = (pi===i) ? openIdx : 0;
        for (let ci = start; ci < pl.length; ci++) {
          if (pl[ci]==='(') { pd++; scanning=true; }
          else if (pl[ci]===')') { pd--; if (pd===0) break outer; else if (scanning&&pd>0) ps+=pl[ci]; }
          else if (scanning && pd>0) ps+=pl[ci];
        }
      }
      params = ps.trim() ? ps.split(',').filter(s=>s.trim()).length : 0;
    }

    // Find function body end
    let j = i + 1;
    while (j < n) {
      const bl = codeLines[j].replace(/\t/g, ' '.repeat(indentSize));
      if (!bl.trim()) { j++; continue; }
      if ((bl.match(/^\s*/)||[''])[0].length <= funcIndent) break;
      j++;
    }

    // Measure per-function complexity and nesting
    let cc = 1, maxNest = 0;
    for (let k = i+1; k < j; k++) {
      const bl = codeLines[k].replace(/\t/g, ' '.repeat(indentSize));
      if (!bl.trim()) continue;
      const bIndent = (bl.match(/^\s*/)||[''])[0].length;
      const relD = Math.round((bIndent - funcIndent) / indentSize);
      maxNest = Math.max(maxNest, relD);
      if (/^\s*(if|elif|for|while|with|except)\b/.test(bl)) cc++;
      cc += (bl.match(/\band\b|\bor\b/g)||[]).length;
    }

    functions.push({ name:funcName, startLine:i+1, endLine:j, loc:j-i-1, complexity:cc, params, maxNesting:clamp(maxNest,0,10) });
  }

  // Total: sum of function CCs; fall back to module-level count if no functions
  let totalCC;
  if (functions.length > 0) {
    totalCC = functions.reduce((s,f)=>s+f.complexity, 0);
  } else {
    totalCC = 1;
    codeLines.forEach(l => {
      if (/^\s*(if|elif|for|while|with|except)\b/.test(l)) totalCC++;
      totalCC += (l.match(/\band\b|\bor\b/g)||[]).length;
    });
  }

  const maxNesting = functions.length > 0 ? Math.max(...functions.map(f=>f.maxNesting), 0) : 0;
  return { complexity:totalCC, maxNesting:clamp(maxNesting,0,10), functions, functionCount:functions.length };
}

// ═══ Per-function findings ════════════════════════════════════════════

function buildPerFunctionFindings(functions) {
  if (!functions || !functions.length) return [];
  const findings = [];
  [...functions].sort((a,b)=>b.complexity-a.complexity).slice(0,6).forEach(f => {
    if (f.complexity >= 15) findings.push({ severity:'critical', message:`함수 '${f.name}' 복잡도 ${f.complexity} — 즉시 분리하세요.` });
    else if (f.complexity >= 10) findings.push({ severity:'high', message:`함수 '${f.name}' 복잡도 ${f.complexity} (${f.loc}줄) — 서브 함수로 분리하세요.` });
    else if (f.complexity >= 6) findings.push({ severity:'medium', message:`함수 '${f.name}' 복잡도 ${f.complexity} — 분기 추출을 고려하세요.` });
    if (f.loc > 70 && f.complexity < 10) findings.push({ severity:'medium', message:`함수 '${f.name}' 길이 ${f.loc}줄 — 단일 책임에 따라 분할하세요.` });
    else if (f.loc > 50 && f.complexity < 6) findings.push({ severity:'low', message:`함수 '${f.name}' 길이 ${f.loc}줄 — 50줄 이하 권장.` });
    if (f.params > 5) findings.push({ severity:'medium', message:`함수 '${f.name}' 파라미터 ${f.params}개 — Options Object 패턴을 고려하세요.` });
    else if (f.params > 3) findings.push({ severity:'low', message:`함수 '${f.name}' 파라미터 ${f.params}개 — 4개 이하 권장.` });
  });
  return findings;
}

function estimateDuplication(lines) {
  const norm = lines.map(l=>l.trim()).filter(l=>l.length>12&&!l.startsWith("//")&&!l.startsWith("#"));
  const seen = new Set(); let dup = 0;
  norm.forEach(l => { if (seen.has(l)) dup++; seen.add(l); });
  return dup;
}

function hasReadmeStyle(content) {
  return /README|@param|@returns|Args:|Returns:|Example:/i.test(content);
}

function extractDependencies(content, language) {
  const deps = new Set();
  [
    /import\s+(?:[^"']+\s+from\s+)?["']([^"'.][^"']*)["']/g,
    /require\(["']([^"'.][^"']*)["']\)/g,
    /from\s+([a-zA-Z_][\w.]*)\s+import/g,
    /using\s+([A-Za-z0-9_.]+);/g,
    /use\s+([A-Za-z0-9_:]+)::/g,
    /#include\s+[<"]([^>"]+)[>"]/g,
  ].forEach(re => {
    let m;
    while ((m = re.exec(content)) !== null) {
      const d = m[1].split(/[/:.]/)[0];
      if (d && d.length > 1) deps.add(d);
    }
  });
  if (language==="PHP") {
    (content.match(/use\s+[A-Z][\w\\]+/g)||[]).forEach(u => deps.add(u.replace(/^use\s+/,"").split("\\")[0]));
  }
  return [...deps];
}

function findBugSignals(content, language) {
  const signals = [];
  const isJS = language==="JavaScript"||language==="TypeScript";
  const isPy = language==="Python";
  const code = stripStringLiterals(content);

  const universal = [
    [/\beval\s*\(/g,"critical","eval() 사용은 심각한 보안 위험입니다."],
    [/(api[_-]?key|secret|password|token|access_key|secret_key)\s*[:=]\s*["'][^"']{8,}["']/gi,"critical","하드코딩된 인증 정보/비밀값이 코드에 있습니다. 즉시 환경변수로 이동하세요."],
    [/TODO|FIXME|HACK|XXX/gi,"medium","미해결 TODO/FIXME/HACK이 있습니다."],
  ];
  const jsChecks = [
    [/\bvar\s/g,"low","var를 let/const로 교체하세요."],
    [/catch\s*\([^)]*\)\s*\{\s*\}/g,"high","빈 catch 블록이 있습니다. 최소한 로그를 남기세요."],
    [/setTimeout\s*\(["']/g,"critical","setTimeout에 문자열 전달 — eval과 동일한 위험. 화살표 함수로 변경하세요."],
    [/__proto__|prototype\[|constructor\[/g,"critical","프로토타입 오염 패턴 감지."],
    [/\.innerHTML\s*=|document\.write\s*\(/g,"critical","DOM XSS 취약점: textContent 또는 DOMPurify를 사용하세요."],
    [/fs\.(readFileSync|writeFileSync|appendFileSync|mkdirSync)\s*\(/g,"high","동기 파일 I/O가 이벤트 루프를 블로킹합니다."],
    [/res\.redirect\s*\(.*req\.(query|params|body)/g,"critical","오픈 리다이렉트 취약점."],
    [/\bany\b/g,"medium","TypeScript any 타입 — unknown으로 교체 후 타입 가드 사용."],
    [/[^=!]==[^=]|!=[^=]/g,"medium","느슨한 동등 비교(==/!=) — ===, !== 으로 교체."],
    [/\bwhile\s*\(true\)|for\s*\(;;\)/g,"medium","무한 루프 감지. 종료 조건을 명확히 하세요."],
    [/\bdebugger\b|console\.log\(/g,"low","디버그 코드가 남아 있습니다."],
    [/["'`]\s*\+\s*(?:req|request|params|query|body|input|user)\b/g,"critical","SQL 인젝션: 파라미터화된 쿼리를 사용하세요."],
  ];
  const pyChecks = [
    [/except\s*:\s*\n\s*pass/g,"high","except: pass — 모든 예외를 무시합니다."],
    [/except\s*:\s*$/gm,"high","bare except가 있습니다. 구체적인 타입을 지정하세요."],
    [/except\s+Exception\s+as\s+\w+\s*:\s*\n\s*(?:pass|return\s+(?:None|\{\}|\[\]))/g,"high","except Exception 후 로깅 없이 패스/반환합니다."],
    [/\.execute\s*\(.*(?:%s|\.format\s*\(|f["'])/g,"critical","SQL 인젝션: cursor.execute(sql,(params,)) 형식을 사용하세요."],
    [/hashlib\.(md5|sha1)\b/g,"high","취약한 해시(MD5/SHA1) — sha256 이상 사용."],
    [/os\.system\s*\(|subprocess\.[a-zA-Z_]+\s*\([^)]*shell\s*=\s*True/g,"critical","셸 인젝션 위험 — 리스트 형식 인수 사용."],
    [/^\s{4,}(?:import\s+\w|from\s+\w+\s+import)/gm,"medium","함수 내부 임포트 — 모듈 수준으로 이동하세요."],
    [/^[A-Z_]{3,}\s*(?::\s*dict\[|=\s*\{)/gm,"low","가변 전역 딕셔너리 — MappingProxyType으로 불변 처리 권장."],
    [/\bdatetime\.utcnow\(\)/g,"medium","datetime.utcnow() — Python 3.12 deprecated, datetime.now(timezone.utc)로 교체."],
  ];

  [...universal, ...(isJS?jsChecks:[]), ...(isPy?pyChecks:[])].forEach(([re, sev, msg]) => {
    const src = re.source.includes("api[_-]?key")||re.source.includes("execute") ? content : code;
    if (src.match(re)) signals.push({ severity: sev, message: msg });
  });
  return signals;
}

function buildFindings(metrics, bugPatterns, deps, ctx, thr, perFuncFindings) {
  thr = thr || DEFAULT_THRESHOLDS;
  const f = [];
  if (metrics.complexity >= thr.complexityCrit) f.push({severity:"critical",message:`복잡도 매우 높음(${metrics.complexity}/100). 함수 분리 및 조기 반환을 적용하세요.`});
  else if (metrics.complexity >= thr.complexityWarn) f.push({severity:"high",message:`복잡도 높음(${metrics.complexity}/100). 핵심 분기를 분리하세요.`});
  if (metrics.bugs >= thr.bugsCrit) f.push({severity:"critical",message:`잠재 버그 신호 과다(${metrics.bugs}개). 예외 처리·입력 검증·하드코딩 비밀값 확인.`});
  else if (metrics.bugs >= thr.bugsWarn) f.push({severity:"high",message:`버그 위험도 높음(${metrics.bugs}개). 실패 경로 테스트와 경계값 검증 추가.`});
  if (metrics.coverage < thr.coverageLow) f.push({severity:"high",message:`테스트 신호 매우 약함(${metrics.coverage}/100). 테스트 파일을 추가하세요.`});
  else if (metrics.coverage < thr.coverageWarn) f.push({severity:"medium",message:`테스트가능성 낮음(${metrics.coverage}/100). Assertion이 부족합니다.`});
  if (metrics.documentation < thr.documentationLow) f.push({severity:"medium",message:`문서화 비율 매우 낮음(${metrics.documentation}/100). 공개 API에 docstring을 추가하세요.`});
  if (metrics.performance < thr.performanceLow) f.push({severity:"medium",message:`성능 점수 낮음(${metrics.performance}/100). 중첩 루프 개선·동기 I/O 제거 고려.`});
  if (metrics.maintainability < thr.maintainabilityLow) f.push({severity:"medium",message:`유지보수성 낮음(${metrics.maintainability}/100). 긴 함수 분할·중복 제거 필요.`});
  if (deps.length > 10) f.push({severity:"low",message:`외부 의존성 많음(${deps.length}개). 미사용 라이브러리를 제거하세요.`});
  if (ctx.lineCount > 400) f.push({severity:"medium",message:`파일 크기 과대(${ctx.lineCount}줄). 300줄 이하가 업계 표준입니다.`});
  if (ctx.maxNesting >= 4) f.push({severity:"high",message:`중첩 깊이 ${ctx.maxNesting}단계. 가드 절과 조기 반환으로 최대 3단계를 유지하세요.`});
  bugPatterns.forEach(p => f.push(p));
  if (perFuncFindings) perFuncFindings.forEach(p => f.push(p));
  return f;
}

function analyzeFile(name, content, allFiles, thresholds) {
  const src = content.replace(/\r\n/g,"\n");
  const lines = src.split("\n");
  const ext = getExtension(name);
  const language = LANGUAGE_MAP[ext] || "Unknown";
  const nonEmptyLines = lines.filter(l=>l.trim()).length;
  const commentLines = countCommentLines(lines, language);
  const code = stripStringLiterals(src);
  const isJS = language==="JavaScript"||language==="TypeScript";
  const isPy = language==="Python";

  // === AST-based analysis (JS/TS and Python) ===
  let ast = null;
  if (isJS) { try { ast = analyzeJS(src); } catch(_) {} }
  else if (isPy) { try { ast = analyzePython(src); } catch(_) {} }

  let branchCount, maxNesting, functions, perFuncFindings = [];
  if (ast) {
    branchCount = ast.complexity;
    maxNesting  = ast.maxNesting;
    functions   = ast.functionCount;
    perFuncFindings = buildPerFunctionFindings(ast.functions);
  } else {
    // Regex fallback for unsupported languages
    branchCount = countMatches(code, /\b(if|else if|for|foreach|while|case|catch|except|when|match|switch|elif|guard)\b/g)
                + countMatches(code, /(\|\||&&|\?)/g);
    maxNesting  = estimateMaxNesting(lines, language);
    functions   = isPy
      ? countMatches(src, /^\s*(?:async\s+)?def\s+\w|^\s*class\s+\w/gm)
      : countMatches(src, /\b(function|func|fn)\b|\bdef\s|\b(public|private|protected)\s+\w[\w<>[\]]*\s+\w+\s*\(|=>/g);
  }

  const longLines  = lines.filter(l=>l.length>120).length;
  const veryLong   = lines.filter(l=>l.length>200).length;
  const deps = extractDependencies(src, language);
  const testSig = countMatches(src, /\b(test|describe|it|expect|assert|should|mock|fixture|spec)\b/gi);
  const assertSig = countMatches(src, /\b(assert|expect|toEqual|toBe|should|verify|assertThat)\b/gi);
  const bugPatterns = findBugSignals(src, language);
  const dupScore = estimateDuplication(lines);
  const magicNums = countMatches(code, /(?<!\w)\d{3,}(?!\w)/g);
  const hardSecrets = bugPatterns.filter(p=>p.severity==="critical"&&p.message.includes("비밀값")).length;

  const avgFuncLen = functions>0 ? Math.round(nonEmptyLines/functions) : nonEmptyLines;
  const branchDensity = (branchCount/Math.max(1,nonEmptyLines))*100;
  const branchPerFunc = functions>0 ? branchCount/functions : branchCount;

  const complexity = clamp(Math.round(
    Math.min(branchPerFunc*6, 36) + maxNesting*6 +
    Math.min(longLines*1.2, 15) + Math.min(magicNums*2, 10) +
    Math.max(0, avgFuncLen-25)*0.8 + branchDensity*0.2
  ), 0, 100);

  const docMatch = (content.match(/("""|''')/g)||[]).length;
  const documentation = clamp(Math.round(
    (commentLines/Math.max(1,nonEmptyLines))*200 + docMatch/2*5 + (hasReadmeStyle(content)?20:0)
  ), 0, 100);

  // Test peer detection (works with allFiles list from worker)
  const hasTestPeer = (allFiles||[]).some(f => {
    if (f.name===name || !isTestFile(f.name)) return false;
    const base = name.replace(/\.[^.]+$/,"");
    const peer = f.name.replace(/\.[^.]+$/,"").replace(/^test[_-]|[_-]test$|^test/,"");
    return f.name.includes(base) || base.includes(peer);
  });

  const coverage = clamp(Math.round(
    (isTestFile(name)?75:30) + (hasTestPeer?20:0) + testSig*4 + assertSig*3 +
    documentation*0.1 - complexity*0.2 - bugPatterns.length*1.5
  ), 5, 95);

  const bugs = clamp(Math.round(bugPatterns.length + complexity/25 + hardSecrets*3 + Math.max(0,deps.length-5)/1.5), 0, 99);

  const nestedLoops = countMatches(content, /\b(for|while)\b[\s\S]{0,120}\b(for|while)\b/g);
  const syncBlock = countMatches(content, /fs\.(readFileSync|writeFileSync|appendFileSync|mkdirSync)\s*\(|os\.system\s*\(/g);
  const performance = clamp(Math.round(95 - complexity*0.35 - nestedLoops*10 - longLines*0.7 - syncBlock*8), 5, 100);

  const maintainability = clamp(Math.round(
    95 - complexity*0.42 - dupScore*1.2 - veryLong*2 - Math.max(0,deps.length-6)*2.5 + documentation*0.2
  ), 5, 100);

  const testQuality = clamp(Math.round(
    (isTestFile(name)?70:35) + assertSig*9 + testSig*6 - bugs*3.5 + coverage*0.2
  ), 0, 100);

  const qualityScore = clamp(Math.round(
    maintainability*0.25 + performance*0.18 + coverage*0.12 + documentation*0.10 +
    testQuality*0.10 + (100-complexity)*0.15 + Math.max(0,100-bugs*8)*0.10
  ), 0, 100);

  const metrics = { complexity, coverage, bugs, performance, maintainability, documentation, testQuality, dependencies: deps.length, qualityScore };

  return {
    id: `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name, language, extension: ext, size: src.length,
    lineCount: lines.length, loc: nonEmptyLines, commentLines, functions,
    dependencies: deps, content: src, contentHash: hashContent(src), metrics,
    functionsData: ast ? ast.functions : [],
    findings: buildFindings(metrics, bugPatterns, deps, { lineCount: lines.length, functions, maxNesting }, thresholds, perFuncFindings),
  };
}

// ═══ Cross-file analysis helpers ═════════════════════════════════════

function extractExports(content, language) {
  const names = new Set();
  let m;
  if (language==="JavaScript"||language==="TypeScript") {
    const re1 = /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|type|interface|enum)\s+(\w+)/g;
    while ((m=re1.exec(content))!==null) names.add(m[1]);
    const re2 = /\bexport\s*\{([^}]+)\}/g;
    while ((m=re2.exec(content))!==null)
      m[1].split(",").forEach(s => { const n=s.trim().split(/\s+as\s+/).pop().trim(); if(n) names.add(n); });
    if (/\bexport\s+default\b/.test(content)) names.add("default");
  } else if (language==="Python") {
    const allM = content.match(/__all__\s*=\s*\[([^\]]+)\]/);
    if (allM) { for (const nm of allM[1].matchAll(/['"](\w+)['"]/g)) names.add(nm[1]); }
    const re = /^(?:def|class)\s+(\w+)/gm;
    while ((m=re.exec(content))!==null) { if(!m[1].startsWith("_")) names.add(m[1]); }
  }
  return names;
}

function extractImports(content, language) {
  const imports = [];
  let m;
  if (language==="JavaScript"||language==="TypeScript") {
    const re1 = /\bimport\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
    while ((m=re1.exec(content))!==null) {
      const clause = m[1]; const from = m[2]; const names = [];
      const brace = clause.match(/\{([^}]+)\}/);
      if (brace) brace[1].split(",").forEach(s => { const n=s.trim().split(/\s+as\s+/)[0].trim(); if(n&&n!=="*") names.push(n); });
      if (/^\s*\*\s+as/.test(clause)) names.push("*");
      if (/^\s*\w/.test(clause.replace(/\{[^}]+\}/,"").replace(/\*\s+as\s+\w+/,"").trim())) names.push("default");
      imports.push({ from, names });
    }
    const re2 = /\bimport\s+['"]([^'"]+)['"]/g;
    while ((m=re2.exec(content))!==null) imports.push({ from: m[1], names:[] });
    const re3 = /\brequire\(['"]([^'"]+)['"]\)/g;
    while ((m=re3.exec(content))!==null) imports.push({ from: m[1], names:["default"] });
  } else if (language==="Python") {
    const re1 = /^from\s+([\w.]+)\s+import\s+(.+)$/gm;
    while ((m=re1.exec(content))!==null) {
      const names = m[2].split(",").map(s=>s.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
      imports.push({ from: m[1], names });
    }
    const re2 = /^import\s+([\w.]+)/gm;
    while ((m=re2.exec(content))!==null) imports.push({ from: m[1], names:[] });
  }
  return imports;
}

function extractFunctionNames(content, language) {
  const names = new Set(); let m;
  if (language==="JavaScript"||language==="TypeScript") {
    const re1 = /\b(?:async\s+)?function\s+(\w+)\s*\(/g;
    while((m=re1.exec(content))!==null) names.add(m[1]);
    const re2 = /\b(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\(/g;
    while((m=re2.exec(content))!==null) names.add(m[1]);
    const re3 = /\b(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?function/g;
    while((m=re3.exec(content))!==null) names.add(m[1]);
    const re4 = /^\s{2,}(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{/gm;
    while((m=re4.exec(content))!==null) { if(!["if","for","while","catch","switch","constructor"].includes(m[1])) names.add(m[1]); }
  } else if (language==="Python") {
    const re = /^(?:\s*)def\s+(\w+)\s*\(/gm;
    while((m=re.exec(content))!==null) names.add(m[1]);
  } else {
    const re = /\b(?:func|fun|fn|def|function)\s+(\w+)\s*[(<(]/g;
    while((m=re.exec(content))!==null) names.add(m[1]);
  }
  return names;
}

function resolveRelativePath(fromFile, importPath) {
  if (!importPath.startsWith(".")) return null;
  const dir = fromFile.replace(/\\/g,"/").split("/").slice(0,-1).join("/");
  const joined = (dir ? dir+"/" : "") + importPath;
  const parts = joined.split("/");
  const out = [];
  for (const p of parts) { if(p==="..") out.pop(); else if(p!==".") out.push(p); }
  return out.join("/");
}

function findFileByResolved(files, resolved) {
  const exts = ["",".js",".ts",".jsx",".tsx",".py",".rb",".java",".go",".rs",".cs"];
  const base = resolved.split("/").pop();
  for (const ext of exts) {
    const cand = resolved + ext;
    const found = files.find(f => {
      const fn = f.name.replace(/\\/g,"/");
      return fn===cand || fn.endsWith("/"+cand) || fn===base+ext;
    });
    if (found) return found;
  }
  return null;
}

function detectCycles(graph) {
  const visited = new Set(), stack = new Set(), cycles = [];
  function dfs(node, path) {
    if (stack.has(node)) { const ci=path.indexOf(node); cycles.push([...path.slice(ci),node]); return; }
    if (visited.has(node)) return;
    visited.add(node); stack.add(node); path.push(node);
    for (const nb of (graph.get(node)||[])) dfs(nb,[...path]);
    stack.delete(node);
  }
  for (const n of graph.keys()) if(!visited.has(n)) dfs(n,[]);
  const seen=new Set();
  return cycles.filter(c => { const k=[...c].sort().join(","); if(seen.has(k)) return false; seen.add(k); return true; });
}

// ═══ Test coverage ═══════════════════════════════════════════════════

function computeTestCoverage(analyzedFiles, rawFiles) {
  const testFiles = rawFiles.filter(f => isTestFile(f.name));
  if (!testFiles.length) return { projectCoverage: 0, testedFunctions: 0, totalFunctions: 0, testFileCount: 0 };

  const testContent = testFiles.map(f => f.content).join("\n");
  let total = 0, tested = 0;

  analyzedFiles.forEach(af => {
    if (isTestFile(af.name)) return;
    const raw = rawFiles.find(f => f.name===af.name);
    if (!raw) return;
    const lang = LANGUAGE_MAP[getExtension(af.name)] || "Unknown";
    const funcs = [...extractFunctionNames(raw.content, lang)].filter(n => n.length>=3 && !n.startsWith("_"));
    total += funcs.length;
    const testedHere = funcs.filter(n => testContent.includes(n)).length;
    tested += testedHere;
    // Attach per-file coverage
    af.functionCoverage = funcs.length>0 ? Math.round((testedHere/funcs.length)*100) : null;
    af.testedFunctions = testedHere;
    af.totalFunctions  = funcs.length;
    // Boost the coverage metric for files that have dedicated test peers
    if (af.functionCoverage !== null) {
      const boosted = clamp(Math.round(af.metrics.coverage*0.5 + af.functionCoverage*0.5), 5, 95);
      af.metrics.coverage = boosted;
      af.metrics.qualityScore = clamp(Math.round(
        af.metrics.maintainability*0.25 + af.metrics.performance*0.18 + boosted*0.12 +
        af.metrics.documentation*0.10 + af.metrics.testQuality*0.10 +
        (100-af.metrics.complexity)*0.15 + Math.max(0,100-af.metrics.bugs*8)*0.10
      ), 0, 100);
    }
  });

  return { projectCoverage: total>0?Math.round((tested/total)*100):0, testedFunctions: tested, totalFunctions: total, testFileCount: testFiles.length };
}

// ═══ Cross-file project analysis ═════════════════════════════════════

function analyzeProject(analyzedFiles, rawFiles) {
  const issues = [];
  const langOf = f => LANGUAGE_MAP[getExtension(f.name)] || "Unknown";

  // Build maps
  const exportMap = new Map(); // name → Set<string>
  const importMap = new Map(); // name → [{from,names}]
  rawFiles.forEach(f => {
    exportMap.set(f.name, extractExports(f.content, langOf(f)));
    importMap.set(f.name, extractImports(f.content, langOf(f)));
  });

  // Dependency graph (relative imports only)
  const depGraph = new Map();
  rawFiles.forEach(f => {
    const deps = [];
    (importMap.get(f.name)||[]).forEach(imp => {
      const res = resolveRelativePath(f.name, imp.from);
      if (!res) return;
      const tgt = findFileByResolved(rawFiles, res);
      if (tgt) deps.push(tgt.name);
    });
    depGraph.set(f.name, deps);
  });

  // 1. Circular dependencies
  const cycles = detectCycles(depGraph);
  cycles.slice(0,5).forEach(cycle => {
    const names = cycle.map(n => n.split(/[/\\]/).pop());
    issues.push({
      type:"circular-dep", severity:"high", files: cycle,
      message:`순환 의존성 발견: ${names.join(" → ")}. 공통 모듈 추출 또는 DIP(의존성 역전 원칙)를 적용하세요.`,
    });
  });

  // 2. Broken imports (JS/TS only - Python doesn't have explicit export declarations)
  rawFiles.forEach(f => {
    if (!["JavaScript","TypeScript"].includes(langOf(f))) return;
    (importMap.get(f.name)||[]).forEach(imp => {
      if (!imp.from.startsWith(".")) return;
      const res = resolveRelativePath(f.name, imp.from);
      if (!res) return;
      const tgt = findFileByResolved(rawFiles, res);
      if (!tgt) return;
      const exports = exportMap.get(tgt.name) || new Set();
      imp.names.filter(n => n!=="*"&&n!=="default"&&!exports.has(n)).forEach(n => {
        issues.push({
          type:"broken-import", severity:"critical", files:[f.name, tgt.name],
          message:`'${f.name.split(/[/\\]/).pop()}'이 '${tgt.name.split(/[/\\]/).pop()}'에서 '${n}'을 import하지만 해당 export가 없습니다.`,
        });
      });
    });
  });

  // 3. God files — imported by ≥5 files
  const importedByCount = new Map();
  rawFiles.forEach(f => (depGraph.get(f.name)||[]).forEach(dep => importedByCount.set(dep,(importedByCount.get(dep)||0)+1)));
  importedByCount.forEach((count, fname) => {
    if (count >= 5) issues.push({
      type:"god-file", severity:"medium", files:[fname],
      message:`'${fname.split(/[/\\]/).pop()}'은(는) ${count}개 파일이 의존하는 중심 모듈입니다. 변경 시 광범위한 영향이 발생합니다.`,
    });
  });

  // 4. Duplicate public function names across files
  const funcMap = new Map();
  rawFiles.forEach(f => {
    const lang = langOf(f);
    [...extractFunctionNames(f.content, lang)].forEach(n => {
      if (n.length<4||n.startsWith("_")) return;
      const arr = funcMap.get(n)||[]; arr.push(f.name); funcMap.set(n, arr);
    });
  });
  funcMap.forEach((files, name) => {
    if (files.length>=2) issues.push({
      type:"dup-func", severity:"medium", files,
      message:`함수 '${name}'이(가) ${files.length}개 파일에 중복 정의됨: ${files.map(n=>n.split(/[/\\]/).pop()).join(", ")}. 공유 유틸로 추출을 고려하세요.`,
    });
  });

  // 5. Dead exports — exported but never imported within the project
  const importedNames = new Map(); // targetFile → Set<name>
  rawFiles.forEach(f => {
    (importMap.get(f.name)||[]).forEach(imp => {
      const res = resolveRelativePath(f.name, imp.from);
      if (!res) return;
      const tgt = findFileByResolved(rawFiles, res);
      if (!tgt) return;
      const s = importedNames.get(tgt.name)||new Set();
      imp.names.forEach(n => s.add(n));
      importedNames.set(tgt.name, s);
    });
  });
  rawFiles.forEach(f => {
    if (!["JavaScript","TypeScript"].includes(langOf(f))) return;
    const exports = exportMap.get(f.name)||new Set();
    const usedBy = importedNames.get(f.name)||new Set();
    exports.forEach(name => {
      if (name!=="default"&&!usedBy.has(name)) issues.push({
        type:"dead-export", severity:"low", files:[f.name],
        message:`'${f.name.split(/[/\\]/).pop()}'의 export '${name}'이(가) 프로젝트 내 다른 파일에서 사용되지 않습니다.`,
      });
    });
  });

  // 6. Large dependency fan-out — file depends on ≥10 internal files
  depGraph.forEach((deps, fname) => {
    if (deps.length>=8) issues.push({
      type:"fanout", severity:"medium", files:[fname],
      message:`'${fname.split(/[/\\]/).pop()}'이(가) ${deps.length}개 내부 파일에 의존합니다. 중간 계층 추상화를 고려하세요.`,
    });
  });

  return issues;
}

// ═══ Duplicate content injection ═════════════════════════════════════

function injectDuplicates(files) {
  const byHash = new Map();
  files.forEach(f => { if (!f.contentHash) return; const g=byHash.get(f.contentHash)||[]; g.push(f.name); byHash.set(f.contentHash,g); });
  return files.map(f => {
    const group = byHash.get(f.contentHash)||[];
    const others = group.filter(n=>n!==f.name);
    if (!others.length) return f;
    const dup = { severity:"critical", message:`이 파일은 ${others.map(n=>`"${n}"`).join(", ")}과(와) 내용이 완전히 동일합니다(해시:${f.contentHash}).` };
    const deduped = f.findings.filter(fn=>!fn.message.includes("내용이 완전히 동일"));
    return { ...f, findings: [dup,...deduped].slice(0,12) };
  });
}

// ═══ Worker message handler ══════════════════════════════════════════

self.onmessage = function(e) {
  const { type, files, thresholds } = e.data;
  if (type !== "ANALYZE") return;

  const total = files.length;
  const analyzed = [];

  // Pass-1: analyze each file individually
  for (let i = 0; i < total; i++) {
    const f = files[i];
    try {
      const result = analyzeFile(f.name, f.content, files, thresholds);
      analyzed.push(result);
    } catch (err) {
      analyzed.push({ name: f.name, error: err.message, language: LANGUAGE_MAP[getExtension(f.name)]||"Unknown",
        metrics:{ complexity:0,coverage:0,bugs:0,performance:0,maintainability:0,documentation:0,testQuality:0,dependencies:0,qualityScore:0 },
        findings:[{ severity:"medium", message:`분석 오류: ${err.message}` }] });
    }
    self.postMessage({ type:"PROGRESS", current: i+1, total, fileName: f.name });
  }

  // Pass-2: cross-file analysis
  let crossFileIssues = [];
  let coverageSummary = {};
  try {
    crossFileIssues = analyzeProject(analyzed, files);
    coverageSummary = computeTestCoverage(analyzed, files);
  } catch(err) {
    crossFileIssues = [{ type:"error", severity:"medium", files:[], message:`크로스파일 분석 오류: ${err.message}` }];
  }

  // Pass-3: duplicate content detection
  const withDups = injectDuplicates(analyzed);

  self.postMessage({ type:"DONE", analyzed: withDups, crossFileIssues, coverageSummary });
};

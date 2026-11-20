'use strict';
/* Scope Guard Lite checks: secrets, destructive SQL, and paths outside allowed-paths.
   Derived from the Scope Guard 1.0.0 default rule engine (free subset only). MIT licensed. */

var ELLIPSIS = '\u2026';

function finding(ruleId, severity, title, message, path, line, symbol, evidence) {
  return {
    rule_id: ruleId,
    severity: severity,
    title: title,
    message: message,
    path: path == null ? null : path,
    line: line == null ? null : line,
    symbol: symbol == null ? null : symbol,
    evidence: evidence == null ? null : evidence,
    source: "rule"
  };
}


function unescapeGit(value) {
  return value.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}


function stripAb(path) {
  if (!path) return null;
  if (path.indexOf("a/") === 0 || path.indexOf("b/") === 0) path = path.slice(2);
  if (path === "/dev/null") return null;
  return path;
}


function headerPath(raw) {
  var text = raw.trim();
  if (text.charAt(0) === '"' && text.charAt(text.length - 1) === '"' && text.length >= 2) {
    text = unescapeGit(text.slice(1, -1));
  }
  if (text.indexOf("\t") !== -1) text = text.split("\t")[0];
  if (text.indexOf("a/") === 0 || text.indexOf("b/") === 0) return text.slice(2);
  return text;
}


function splitGitHeader(line) {
  var rest = line.slice("diff --git ".length);
  if (rest.charAt(0) === '"') {
    var quoted = rest.match(/"((?:\\.|[^"\\])*)"/g) || [];
    if (quoted.length >= 2) {
      var oldQ = unescapeGit(quoted[0].slice(1, -1));
      var newQ = unescapeGit(quoted[1].slice(1, -1));
      return [stripAb(oldQ), stripAb(newQ)];
    }
  }
  var marker = " b/";
  var pivot = rest.lastIndexOf(marker);
  if (pivot === -1) {
    var parts = rest.split(" ");
    if (parts.length >= 2) return [stripAb(parts[0]), stripAb(parts[parts.length - 1])];
    return [null, null];
  }
  return [stripAb(rest.slice(0, pivot)), stripAb(rest.slice(pivot + 1))];
}


function filePath(fd) {
  return fd.new_path || fd.old_path || "";
}


function addedLines(fd) {
  var out = [];
  fd.hunks.forEach(function (hunk) {
    hunk.lines.forEach(function (line) { if (line.kind === "add") out.push(line); });
  });
  return out;
}

function removedLines(fd) {
  var out = [];
  fd.hunks.forEach(function (hunk) {
    hunk.lines.forEach(function (line) { if (line.kind === "del") out.push(line); });
  });
  return out;
}


function addedText(fd) {
  return addedLines(fd).map(function (line) { return line.text; }).join("\n");
}


function parseDiff(text) {
  var normalized = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  var lines = normalized.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  var files = [];
  var current = null;
  var hunk = null;
  var oldLine = 0;
  var newLine = 0;
  var sawHunk = false;
  var index = 0;

  function flush() {
    if (current && (filePath(current) || current.hunks.length || current.is_binary)) {
      if (current.status === "modified" && current.is_binary) current.status = "binary";
      files.push(current);
    }
    current = null;
    hunk = null;
    sawHunk = false;
  }

  while (index < lines.length) {
    var line = lines[index];
    var nxt = index + 1 < lines.length ? lines[index + 1] : null;
    if (line.indexOf("diff --git ") === 0) {
      flush();
      var pair = splitGitHeader(line);
      current = { old_path: pair[0], new_path: pair[1], status: "modified", hunks: [], is_binary: false };
      index += 1;
      continue;
    }
    if (line.indexOf("--- ") === 0 && nxt && nxt.indexOf("+++ ") === 0) {
      var oldP = headerPath(line.slice(4));
      var newP = headerPath(nxt.slice(4));
      if (!current || sawHunk) {
        flush();
        current = { old_path: null, new_path: null, status: "modified", hunks: [], is_binary: false };
      }
      current.old_path = oldP === "/dev/null" ? null : oldP;
      current.new_path = newP === "/dev/null" ? null : newP;
      if (current.status !== "renamed") {
        if (current.old_path == null && current.new_path != null) current.status = "added";
        else if (current.new_path == null && current.old_path != null) current.status = "deleted";
      }
      index += 2;
      continue;
    }
    if (!current) { index += 1; continue; }
    if (line.indexOf("deleted file mode") === 0) { current.status = "deleted"; index += 1; continue; }
    if (line.indexOf("new file mode") === 0) { current.status = "added"; index += 1; continue; }
    if (line.indexOf("rename from ") === 0) { current.old_path = line.slice("rename from ".length); current.status = "renamed"; index += 1; continue; }
    if (line.indexOf("rename to ") === 0) { current.new_path = line.slice("rename to ".length); current.status = "renamed"; index += 1; continue; }
    if (line.indexOf("Binary files ") === 0 || line.indexOf("GIT binary patch") === 0) { current.is_binary = true; index += 1; continue; }
    if (line.indexOf("old mode ") === 0 || line.indexOf("new mode ") === 0 || line.indexOf("index ") === 0 || line.indexOf("similarity index ") === 0 || line.indexOf("dissimilarity index ") === 0) {
      index += 1; continue;
    }
    var hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunkMatch) {
      sawHunk = true;
      hunk = { lines: [] };
      current.hunks.push(hunk);
      oldLine = parseInt(hunkMatch[1], 10);
      newLine = parseInt(hunkMatch[3], 10);
      index += 1;
      continue;
    }
    if (!hunk) { index += 1; continue; }
    if (line.charAt(0) === "\\") { index += 1; continue; }
    if (line.charAt(0) === "+") {
      hunk.lines.push({ kind: "add", text: line.slice(1), old_lineno: null, new_lineno: newLine });
      newLine += 1;
    } else if (line.charAt(0) === "-") {
      hunk.lines.push({ kind: "del", text: line.slice(1), old_lineno: oldLine, new_lineno: null });
      oldLine += 1;
    } else if (line.charAt(0) === " ") {
      hunk.lines.push({ kind: "context", text: line.slice(1), old_lineno: oldLine, new_lineno: newLine });
      oldLine += 1;
      newLine += 1;
    } else if (line === "") {
      hunk.lines.push({ kind: "context", text: "", old_lineno: oldLine, new_lineno: newLine });
      oldLine += 1;
      newLine += 1;
    } else {
      index += 1;
      continue;
    }
    index += 1;
  }
  flush();
  return files;
}


function allMatches(re, text) {
  var flags = re.flags.indexOf("g") === -1 ? re.flags + "g" : re.flags;
  var copy = new RegExp(re.source, flags);
  return Array.from(text.matchAll(copy));
}


function normalizePath(path) {
  var text = String(path || "").replace(/\\/g, "/").trim();
  while (text.indexOf("./") === 0) text = text.slice(2);
  return text.replace(/^\/+/, "");
}

var globCache = {};
function compileGlob(pattern) {
  if (globCache[pattern]) return globCache[pattern];
  var translated = "";
  var i = 0;
  while (i < pattern.length) {
    if (pattern.substr(i, 3) === "**/") {
      translated += "(?:.*/)?";
      i += 3;
    } else if (pattern.substr(i, 2) === "**") {
      translated += ".*";
      i += 2;
    } else if (pattern.charAt(i) === "*") {
      translated += "[^/]*";
      i += 1;
    } else if (pattern.charAt(i) === "?") {
      translated += "[^/]";
      i += 1;
    } else {
      translated += pattern.charAt(i).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  globCache[pattern] = new RegExp("^" + translated + "$");
  return globCache[pattern];
}

function globMatch(path, pattern) {
  var target = normalizePath(path);
  var needle = normalizePath(pattern);
  if (!needle) return false;
  return compileGlob(needle).test(target);
}

function anyGlob(path, patterns) {
  for (var i = 0; i < patterns.length; i++) if (globMatch(path, patterns[i])) return true;
  return false;
}


function firstChangedLine(fd) {
  var added = addedLines(fd);
  for (var i = 0; i < added.length; i++) if (added[i].new_lineno) return added[i].new_lineno;
  var removed = removedLines(fd);
  for (var j = 0; j < removed.length; j++) if (removed[j].old_lineno) return removed[j].old_lineno;
  return null;
}

function lineContaining(fd, snippet) {
  var needle = snippet.trim().slice(0, 60);
  var added = addedLines(fd);
  for (var i = 0; i < added.length; i++) if (needle && added[i].text.indexOf(needle) !== -1) return added[i].new_lineno;
  var removed = removedLines(fd);
  for (var j = 0; j < removed.length; j++) if (needle && removed[j].text.indexOf(needle) !== -1) return removed[j].old_lineno;
  return firstChangedLine(fd);
}


function cleanIdent(value) {
  return value.replace(/[`"\[\]]/g, "");
}

function dropFinding(ruleId, fd, title, evidence, symbol) {
  var collapsed = evidence.replace(/\s+/g, " ").slice(0, 180);
  var line = lineContaining(fd, evidence.trim().split("\n")[0].slice(0, 80));
  return emit(ruleId, {
    title: title,
    message: title + " in " + filePath(fd) + ".",
    path: filePath(fd),
    line: line,
    symbol: symbol,
    evidence: collapsed
  });
}



function emit(ruleId, fields) {
  return finding(ruleId, RULES[ruleId], fields.title, fields.message, fields.path, fields.line, fields.symbol, fields.evidence);
}

var RULES = {
  "db.drop_table": "critical",
  "db.drop_column": "critical",
  "secret.committed": "critical",
  "scope.outside_allowed": "high"
};

var RANK = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

var IGNORE = [
  "node_modules/**", "vendor/**", "third_party/**", "dist/**", "build/**",
  ".next/**", "coverage/**", "**/*.min.js", "**/*.map"
];
var LOCKFILE_NAMES = ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "poetry.lock", "Pipfile.lock", "uv.lock", "Cargo.lock", "go.sum", "Gemfile.lock", "composer.lock"];

function isLockfile(path) {
  return LOCKFILE_NAMES.indexOf(baseName(path)) !== -1;
}

function baseName(path) {
  var norm = String(path || "").replace(/\\/g, "/");
  var i = norm.lastIndexOf("/");
  return i === -1 ? norm : norm.slice(i + 1);
}

function isDoc(path) {
  var lower = path.toLowerCase();
  return lower.indexOf("docs/") === 0 || /\.(md|rst|adoc)$/.test(lower);
}

function ignored(fd) {
  var paths = [];
  if (filePath(fd)) paths.push(filePath(fd));
  if (fd.old_path) paths.push(fd.old_path);
  if (fd.new_path) paths.push(fd.new_path);
  return paths.some(function (path) { return anyGlob(path, IGNORE); });
}

// ---- Free check 1: destructive SQL (plain SQL only) ----
var DROP_TABLE = /\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?<name>(?:[`"\[]?\w+[`"\]]?\.)*[`"\[]?\w+[`"\]]?)/gi;
var DROP_COLUMN = /\bDROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?(?<name>[`"\[]?\w+[`"\]]?)/gi;
var ALTER_DROP = /\bALTER\s+TABLE\s+(?<table>(?:[`"\[]?\w+[`"\]]?\.)*[`"\[]?\w+[`"\]]?)\s+DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?(?<col>[`"\[]?\w+[`"\]]?)/gi;


function spansOverlap(start, spans) {
  for (var i = 0; i < spans.length; i++) if (start >= spans[i][0] && start < spans[i][1]) return true;
  return false;
}

function sqlFindings(files) {
  var out = [];
  files.forEach(function (fd) {
    var path = filePath(fd);
    if (!path || fd.is_binary || isDoc(path) || fd.status === "deleted") return;
    var added = addedText(fd);
    allMatches(DROP_TABLE, added).forEach(function (match) {
      var name = cleanIdent(match.groups.name);
      out.push(dropFinding("db.drop_table", fd, "Dropped table " + name, match[0], name));
    });
    var alterSpans = [];
    allMatches(ALTER_DROP, added).forEach(function (match) {
      var symbol = cleanIdent(match.groups.table) + "." + cleanIdent(match.groups.col);
      alterSpans.push([match.index, match.index + match[0].length]);
      out.push(dropFinding("db.drop_column", fd, "Dropped column " + symbol, match[0], symbol));
    });
    allMatches(DROP_COLUMN, added).forEach(function (match) {
      if (spansOverlap(match.index, alterSpans)) return;
      var name = cleanIdent(match.groups.name);
      out.push(dropFinding("db.drop_column", fd, "Dropped column " + name, match[0], name));
    });
  });
  return out;
}

// ---- Free check 2: committed secrets (known key formats + database URLs) ----
var SECRET_PATTERNS = [
  ["aws_access_key", /\b(AKIA[0-9A-Z]{16})\b/g, "AWS access key id"],
  ["github_pat", /\b(ghp_[A-Za-z0-9]{36})\b/g, "GitHub personal access token"],
  ["github_fine_grained", /\b(github_pat_[A-Za-z0-9_]{20,})\b/g, "GitHub fine-grained token"],
  ["github_oauth", /\b(gho_[A-Za-z0-9]{36})\b/g, "GitHub OAuth token"],
  ["github_server", /\b(ghs_[A-Za-z0-9]{36})\b/g, "GitHub server token"],
  ["stripe_live", /\b((?:sk|rk)_live_[A-Za-z0-9]{16,})\b/g, "Stripe live secret key"],
  ["stripe_webhook", /\b(whsec_[A-Za-z0-9]{16,})\b/g, "Stripe webhook signing secret"],
  ["slack_token", /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g, "Slack token"],
  ["slack_webhook", /(https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+)/g, "Slack webhook URL"],
  ["google_api", /\b(AIza[0-9A-Za-z\-_]{35})\b/g, "Google API key"],
  ["npm_token", /\b(npm_[A-Za-z0-9]{36})\b/g, "npm token"],
  ["pypi_token", /\b(pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_\-]{20,})\b/g, "PyPI token"],
  ["sendgrid", /\b(SG\.[A-Za-z0-9_\-]{22}\.[A-Za-z0-9_\-]{43})\b/g, "SendGrid API key"],
  ["private_key", /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/g, "private key"],
  ["jwt", /\b(eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{8,})\b/g, "JSON Web Token"]
];

var DB_URL = /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/([^:\s/]+):([^@\s]{8,})@/gi;

function redact(value) {
  var compact = String(value).trim();
  if (compact.length <= 8) return "***";
  return compact.slice(0, 4) + ELLIPSIS + compact.slice(-2);
}


function covered(start, end, spans) {
  for (var i = 0; i < spans.length; i++) if (!(end <= spans[i][0] || start >= spans[i][1])) return true;
  return false;
}

function secretFinding(path, line, symbol, label, raw) {
  return finding(
    "secret.committed",
    "critical",
    "Committed secret (" + label + ")",
    "Added line in " + path + " contains a " + label + ". The value is shown redacted.",
    path,
    line.new_lineno,
    symbol,
    redact(raw)
  );
}


function scanLine(line, path) {
  var out = [];
  var spans = [];
  SECRET_PATTERNS.forEach(function (spec) {
    allMatches(spec[1], line.text).forEach(function (match) {
      var raw = match.length > 1 && match[1] != null ? match[1] : match[0];
      out.push(secretFinding(path, line, spec[0], spec[2], raw));
      spans.push([match.index, match.index + match[0].length]);
    });
  });
  allMatches(DB_URL, line.text).forEach(function (match) {
    if (covered(match.index, match.index + match[0].length, spans)) return;
    out.push(secretFinding(path, line, "database_url", "database URL with an embedded password", match[0]));
    spans.push([match.index, match.index + match[0].length]);
  });
  return out;
}

function secretFindings(files) {
  var out = [];
  files.forEach(function (fd) {
    var path = filePath(fd);
    if (fd.is_binary || !path || isLockfile(path)) return;
    addedLines(fd).forEach(function (line) { scanLine(line, path).forEach(function (item) { out.push(item); }); });
  });
  return out;
}

// ---- Free check 3: files outside allowed-paths ----
function outsideAllowedFindings(files, allowed) {
  var out = [];
  if (!allowed || !allowed.length) return out;
  files.forEach(function (fd) {
    var path = filePath(fd);
    if (!path) return;
    [fd.old_path, fd.new_path].filter(Boolean).forEach(function (p, i, arr) {
      if (arr.length === 2 && arr[0] === arr[1] && i === 1) return;
      if (anyGlob(p, allowed)) return;
      out.push(emit("scope.outside_allowed", {
        title: "Path outside allowed-paths: " + p,
        message: p + " does not match any pattern in allowed-paths.",
        path: p,
        symbol: baseName(p)
      }));
    });
  });
  return out;
}

function analyze(diffText, options) {
  options = options || {};
  var parsed = parseDiff(diffText);
  var files = parsed.filter(function (fd) { return !ignored(fd); });
  var findings = [].concat(
    secretFindings(files),
    sqlFindings(files),
    outsideAllowedFindings(files, options.allowedPaths || [])
  );
  var seen = {};
  findings = findings.filter(function (f) {
    var key = [f.rule_id, f.path, f.symbol, f.line].join("\0");
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
  findings.sort(function (a, b) {
    if (RANK[a.severity] !== RANK[b.severity]) return RANK[b.severity] - RANK[a.severity];
    return String(a.path).localeCompare(String(b.path)) || (a.line || 0) - (b.line || 0);
  });
  return { findings: findings, files_scanned: files.length };
}

module.exports = { analyze: analyze, parseDiff: parseDiff, RULES: RULES };

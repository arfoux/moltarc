/* moltarc subprocess hooks (sanctioned path b): back the C extension by
 * exec-ing `bun ext/moltarc.ts find|seal`. zero format code here: the
 * canonical reader stays in src/seal.ts + src/find.ts via moltarc.ts.
 *
 * Exit contract (mirrors ext/moltarc.ts):
 *   find: exit 0 == row JSON on stdout; exit 1 == miss (SQL NULL, no error).
 *   seal: exit 0 == SealResult JSON on stdout; any nonzero exit == failure.
 * stdout capped at 8MB (OUT_CAP). bun stderr is captured per call to a temp
 * file and surfaced to the C caller via *err, so every failure carries the
 * real bun message: seal failures (and non-miss find failures) return -1
 * with *err set, never a bare -1 the SQL layer cannot explain; a miss
 * returns 1 with *err left NULL, so miss vs error stay distinguishable. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef _WIN32
#include <windows.h>
#endif

#ifndef MOLTARC_TS
#error "compile with -DMOLTARC_TS=\"<abs path to ext/moltarc.ts>\""
#endif
#ifndef MOLTARC_BUN
#define MOLTARC_BUN "bun"
#endif
#define OUT_CAP (8u * 1024u * 1024u)
/* stderr detail cap: room for a bun stack, bounded for sqlite3_result_error. */
#define ERR_CAP (64u * 1024u)

static unsigned long g_errseq = 0;

/* Unique temp path for one bun stderr capture. */
static void err_tmp_path(char *dst, size_t n) {
  const char *tmp = getenv("TEMP");
  if (!tmp || !*tmp) tmp = getenv("TMP");
  if (!tmp || !*tmp) tmp = getenv("TMPDIR");
  if (!tmp || !*tmp) tmp = "/tmp";
  g_errseq++;
  snprintf(dst, n, "%s/moltarc_hook_stderr_%p_%lu.tmp", tmp, (void *)dst,
           g_errseq);
}

static char *empty_str(void) {
  char *m = (char *)malloc(1);
  if (m) m[0] = 0;
  return m;
}

/* Slurp a file, capped; NUL-terminated malloc'd buffer (caller frees).
 * Missing/unreadable -> malloc'd "" so callers never NULL-check. Trailing
 * CR/LF/blank trimmed so sqlite errors stay single-line. */
static char *slurp_capped(const char *path, size_t cap) {
  FILE *f = fopen(path, "rb");
  char *buf;
  size_t len = 0;
  if (!f) return empty_str();
  buf = (char *)malloc(cap + 1);
  if (!buf) { fclose(f); return empty_str(); }
  len = fread(buf, 1, cap, f);
  fclose(f);
  while (len > 0 && (buf[len - 1] == '\n' || buf[len - 1] == '\r' ||
                     buf[len - 1] == ' ' || buf[len - 1] == '\t'))
    len--;
  buf[len] = 0;
  return buf;
}

/* Publish a bun failure as a sqlite-ready message in *err. *err is always
 * set (or left alone when err == NULL); detail is bun stderr verbatim. */
static void set_err(char **err, const char *op, int rc, const char *detail) {
  const char *d;
  size_t need;
  char *m;
  if (!err) return;
  d = (detail && *detail) ? detail : "no detail captured from bun stderr";
  need = strlen(op) + strlen(d) + 96;
  m = (char *)malloc(need);
  if (!m) { *err = 0; return; }
  snprintf(m, need, "moltarc_hook %s failed (bun exit %d): %s", op, rc, d);
  *err = m;
}

/* No shell anywhere on this path: argv elements are quoted per MSVCRT rules
 * for CreateProcess only (no cmd.exe), stdout/stderr on pipes. */
/* MSVCRT argv quoting for one CreateProcess argument: wraps in "..." and
 * escapes interior quotes/backslashes per CommandLineToArgvW rules.
 * dst must hold 2*strlen+3 bytes. No shell (no cmd.exe) ever sees this. */
static void quote_arg(char *dst, size_t n, const char *s) {
  size_t di = 0, i, bs;
  if (di < n) dst[di++] = '"';
  for (i = 0; s[i] && di + 1 < n; ) {
    bs = 0;
    while (s[i] == '\\') { i++; bs++; }
    if (!s[i]) { /* trailing backslashes: double them before closing quote */
      while (bs-- && di + 1 < n) { if (di + 1 < n) { dst[di++] = '\\'; dst[di++] = '\\'; } }
      break;
    }
    if (s[i] == '"') {
      while (bs-- && di + 2 < n) { dst[di++] = '\\'; dst[di++] = '\\'; }
      if (di + 2 < n) { dst[di++] = '\\'; dst[di++] = '"'; }
      i++;
    } else {
      while (bs-- && di + 1 < n) dst[di++] = '\\';
      if (di + 1 < n) dst[di++] = s[i++];
    }
  }
  if (di < n) dst[di++] = '"';
  dst[di < n ? di : n - 1] = 0;
}

/* Resolve the TS entry point. Absolute -DMOLTARC_TS used verbatim; a
 * relative value (e.g. "ext/moltarc.ts") is resolved against the loaded
 * DLL directory first, then used verbatim (cwd-relative) as fallback.
 * Rebuild with a relative path:
 *   gcc -shared -O2 -I amalg/sqlite-amalgamation-3530400 -DMOLTARC_TS="ext/moltarc.ts" moltarc.c moltarc_hook.c -o moltarc.dll
 * and keep moltarc.dll next to ext/moltarc.ts (or run with cwd=repo root). */
static void resolve_ts(char *dst, size_t n) {
  const char *ts = MOLTARC_TS;
  int abs = (ts[0] == '/' || ts[0] == '\\' || (ts[0] && ts[1] == ':'));
  if (abs) { snprintf(dst, n, "%s", ts); return; }
#ifdef _WIN32
  {
    char dll[MAX_PATH * 2]; char *slash; char cand[MAX_PATH * 4];
    DWORD len = GetModuleFileNameA(NULL, dll, sizeof dll);
    /* NOTE: NULL handle = host exe path, not the DLL; best-effort only.
     * The verbatim cwd-relative fallback below is the supported path. */
    (void)len;
    HMODULE mod = 0;
    if (GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                           GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                           (LPCSTR)resolve_ts, &mod) && mod) {
      DWORD dl = GetModuleFileNameA(mod, dll, sizeof dll);
      if (dl && dl < sizeof dll) {
        slash = strrchr(dll, '\\'); { char *s2 = strrchr(dll, '/'); if (s2 > slash) slash = s2; }
        if (slash) {
          *slash = 0;
          snprintf(cand, sizeof cand, "%s\\%s", dll, ts);
          { FILE *f = fopen(cand, "rb"); if (f) { fclose(f); snprintf(dst, n, "%s", cand); return; } }
          /* ext/moltarc.ts layout: dll lives in ext/, value may repeat it */
          { const char *base = strrchr(ts, '/'); const char *b2 = strrchr(ts, '\\'); if (b2 > base) base = b2; base = base ? base + 1 : ts;
            snprintf(cand, sizeof cand, "%s\\%s", dll, base);
            { FILE *f2 = fopen(cand, "rb"); if (f2) { fclose(f2); snprintf(dst, n, "%s", cand); return; } } }
        }
      }
    }
  }
#endif
  snprintf(dst, n, "%s", ts);
}

/* exec-vector spawn: CreateProcess on argv (bun, ts, cmd, a, b, [c]) with
 * stdout/stderr on anonymous pipes. No shell, no metachar interpretation:
 * outDir like 'x" & evil' arrives as one argv element. Returns malloc'd
 * stdout (*rc = exit code); bun stderr lands malloc'd in *stderr_text. */
static char *run_bun(int *rc, char **stderr_text, const char *cmd, const char *a,
                     const char *b, const char *c) {
  char ts[8192]; char qa[6][8192]; char line[32768 + 8192];
#ifdef _WIN32
  SECURITY_ATTRIBUTES sa; HANDLE so_r = 0, so_w = 0, se_r = 0, se_w = 0;
  STARTUPINFOA si; PROCESS_INFORMATION pi; DWORD exitcode = 1;
  char *buf = 0; size_t len = 0, cap = 1 << 16; char *serr = 0; size_t slen = 0, scap = 1 << 12;
  const char *parts[7]; int nparts = 0, i;
  BOOL ok;
  resolve_ts(ts, sizeof ts);
  parts[nparts++] = MOLTARC_BUN; parts[nparts++] = ts; parts[nparts++] = cmd;
  parts[nparts++] = a; parts[nparts++] = b; if (c) parts[nparts++] = c;
  line[0] = 0;
  for (i = 0; i < nparts; i++) {
    quote_arg(qa[i], sizeof qa[i], parts[i]);
    if (strlen(line) + strlen(qa[i]) + 2 >= sizeof line) { *rc = -1; *stderr_text = empty_str(); return 0; }
    if (i) strcat(line, " ");
    strcat(line, qa[i]);
  }
  memset(&sa, 0, sizeof sa); sa.nLength = sizeof sa; sa.bInheritHandle = TRUE;
  if (!CreatePipe(&so_r, &so_w, &sa, 0) || !CreatePipe(&se_r, &se_w, &sa, 0)) {
    if (so_r) CloseHandle(so_r); if (so_w) CloseHandle(so_w);
    *rc = -1; *stderr_text = empty_str(); return 0;
  }
  SetHandleInformation(so_r, HANDLE_FLAG_INHERIT, 0);
  SetHandleInformation(se_r, HANDLE_FLAG_INHERIT, 0);
  memset(&si, 0, sizeof si); si.cb = sizeof si;
  si.hStdOutput = so_w; si.hStdError = se_w; si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
  si.dwFlags = STARTF_USESTDHANDLES;
  memset(&pi, 0, sizeof pi);
  /* lpApplicationName NULL + quoted argv line, no cmd.exe: metachars inert. */
  ok = CreateProcessA(NULL, line, NULL, NULL, TRUE, CREATE_NO_WINDOW, NULL, NULL, &si, &pi);
  CloseHandle(so_w); CloseHandle(se_w); so_w = se_w = 0;
  if (!ok) {
    CloseHandle(so_r); CloseHandle(se_r);
    *rc = -1; *stderr_text = empty_str(); return 0;
  }
  buf = (char *)malloc(cap); serr = (char *)malloc(scap);
  if (!buf || !serr) {
    free(buf); free(serr); CloseHandle(so_r); CloseHandle(se_r);
    CloseHandle(pi.hProcess); CloseHandle(pi.hThread);
    *rc = -1; *stderr_text = empty_str(); return 0;
  }
  for (;;) { DWORD got = 0; if (!ReadFile(so_r, buf + len, (DWORD)(cap - len - 1), &got, NULL) || !got) break; len += got;
    if (len + 1 >= cap && cap < OUT_CAP + 16) { size_t nc = cap * 2; char *nb; if (nc > OUT_CAP + 16) nc = OUT_CAP + 16;
      nb = (char *)realloc(buf, nc); if (!nb) break; buf = nb; cap = nc; }
    if (len + 1 >= cap) break; }
  for (;;) { DWORD got = 0; if (!ReadFile(se_r, serr + slen, (DWORD)(scap - slen - 1), &got, NULL) || !got) break; slen += got;
    if (slen + 1 >= scap && scap < ERR_CAP + 16) { size_t nc = scap * 2; char *nb; if (nc > ERR_CAP + 16) nc = ERR_CAP + 16;
      nb = (char *)realloc(serr, nc); if (!nb) break; serr = nb; scap = nc; }
    if (slen + 1 >= scap) break; }
  CloseHandle(so_r); CloseHandle(se_r);
  WaitForSingleObject(pi.hProcess, INFINITE);
  GetExitCodeProcess(pi.hProcess, &exitcode);
  CloseHandle(pi.hProcess); CloseHandle(pi.hThread);
  buf[len < cap ? len : cap - 1] = 0;
  while (slen > 0 && (serr[slen-1]=='\n'||serr[slen-1]=='\r'||serr[slen-1]==' '||serr[slen-1]=='\t')) slen--;
  serr[slen] = 0;
  *rc = (int)exitcode; *stderr_text = serr; return buf;
#else
  (void)ts; (void)qa; (void)line;
  *rc = -1; *stderr_text = empty_str(); return 0;
#endif
}

int moltarc_chunk_find(const char *outdir, const char *trxid, char **json,
                       char **err) {
  int rc = 0;
  char *serr = 0;
  char *out = run_bun(&rc, &serr, "find", outdir, trxid, 0);
  if (err) *err = 0;
  if (!out) { set_err(err, "find", rc, serr); free(serr); return -1; }
  if (rc == 1) { free(out); free(serr); return 1; } /* miss: SQL NULL, no error */
  if (rc != 0) {
    /* Non-miss failure: bun stderr attached, so the SQL layer reports the
     * real cause instead of a bare "internal error". */
    set_err(err, "find", rc, serr);
    free(out);
    free(serr);
    return -1;
  }
  free(serr);
  *json = out;
  return 0;
}

int moltarc_chunk_seal(const char *hotdb, const char *outdir, const char *table,
                       char **json, char **err) {
  int rc = 0;
  char *serr = 0;
  char *out = run_bun(&rc, &serr, "seal", hotdb, outdir, table);
  if (err) *err = 0;
  if (!out || rc != 0) {
    /* No miss code on the seal path: every nonzero exit is an error with
     * the bun stderr attached, so a failed seal never looks like a
     * find-miss (1) and never surfaces as detail-free -1. */
    set_err(err, "seal", rc, serr);
    free(serr);
    free(out);
    return -1;
  }
  free(serr);
  *json = out;
  return 0;
}

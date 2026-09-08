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

/* build: bun "path" cmd "a" "b" ["c"]; returns malloc'd stdout (caller frees)
 * with *rc = process exit code. NULL on spawn/alloc failure (*rc = -1).
 * bun stderr lands malloc'd in *stderr_text (caller frees, never NULL: ""
 * when bun was silent). stdout stays capped at OUT_CAP. */
static char *run_bun(int *rc, char **stderr_text, const char *cmd, const char *a,
                     const char *b, const char *c) {
  char q[32768];
  char epath[4096];
  char full[32768 + 8192];
  int n = snprintf(q, sizeof q, "%s \"%s\" %s \"%s\" \"%s\"%s%s%s", MOLTARC_BUN,
                   MOLTARC_TS, cmd, a, b, c ? " \"" : "", c ? c : "",
                   c ? "\"" : "");
  FILE *p;
  char *buf;
  size_t len = 0, cap = 1 << 16;
  if (n < 0 || (size_t)n >= sizeof q) {
    *rc = -1;
    *stderr_text = empty_str();
    return 0;
  }
  /* Keep stderr out of the stdout pipe: without the redirect, bun errors
   * either vanish (lost to the host's console) or corrupt the JSON stream.
   * Quoted append works under both cmd (_popen) and sh (popen). */
  err_tmp_path(epath, sizeof epath);
  snprintf(full, sizeof full, "%s 2>\"%s\"", q, epath);
  p = _popen(full, "r");
  if (!p) {
    *rc = -1;
    *stderr_text = empty_str();
    remove(epath);
    return 0;
  }
  buf = (char *)malloc(cap);
  if (!buf) { _pclose(p); *rc = -1; *stderr_text = empty_str(); remove(epath); return 0; }
  for (;;) {
    size_t want = cap - len - 1, got;
    if (len + 1 >= cap || cap >= OUT_CAP + 16) break;
    got = fread(buf + len, 1, want, p);
    len += got;
    if (got < want) break;
    if (len + 1 >= cap && cap < OUT_CAP + 16) {
      size_t ncap = cap * 2;
      char *nb;
      if (ncap > OUT_CAP + 16) ncap = OUT_CAP + 16;
      nb = (char *)realloc(buf, ncap);
      if (!nb) break;
      buf = nb;
      cap = ncap;
    }
  }
  buf[len < cap ? len : cap - 1] = 0;
  *rc = _pclose(p);
  *stderr_text = slurp_capped(epath, ERR_CAP);
  remove(epath);
  return buf;
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

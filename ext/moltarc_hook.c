/* moltarc subprocess hooks (sanctioned path b): back the C extension by
 * exec-ing `bun ext/moltarc.ts find|seal`. zero format code here: the
 * canonical reader stays in src/seal.ts + src/find.ts via moltarc.ts.
 * exit 1 == miss (find) / failure (seal). stdout capped at 8MB. */
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

/* build: bun "path" cmd "a" "b" ["c"]; returns malloc'd stdout (caller frees)
 * with *rc = process exit code. NULL on spawn/alloc failure (*rc = -1). */
static char *run_bun(int *rc, const char *cmd, const char *a, const char *b,
                     const char *c) {
  char q[32768];
  int n = snprintf(q, sizeof q, "%s \"%s\" %s \"%s\" \"%s\"%s%s%s", MOLTARC_BUN,
                   MOLTARC_TS, cmd, a, b, c ? " \"" : "", c ? c : "",
                   c ? "\"" : "");
  FILE *p;
  char *buf;
  size_t len = 0, cap = 1 << 16;
  if (n < 0 || (size_t)n >= sizeof q) { *rc = -1; return 0; }
  p = _popen(q, "r");
  if (!p) { *rc = -1; return 0; }
  buf = (char *)malloc(cap);
  if (!buf) { _pclose(p); *rc = -1; return 0; }
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
  return buf;
}

int moltarc_chunk_find(const char *outdir, const char *trxid, char **json,
                       char **err) {
  int rc = 0;
  char *out = run_bun(&rc, "find", outdir, trxid, 0);
  (void)err;
  if (!out) return -1;
  if (rc == 1) { free(out); return 1; } /* miss */
  if (rc != 0) { free(out); return -1; }
  *json = out;
  return 0;
}

int moltarc_chunk_seal(const char *hotdb, const char *outdir, const char *table,
                       char **json, char **err) {
  int rc = 0;
  char *out = run_bun(&rc, "seal", hotdb, outdir, table);
  (void)err;
  if (!out || rc != 0) { free(out); return -1; }
  *json = out;
  return 0;
}

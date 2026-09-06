/* moltarc sqlite extension — C ABI (compiled, loaded, proven).
 *
 * Status: BUILT + GREEN. ext/moltarc_hook.c backs the two hooks via the
 * sanctioned subprocess path (exec `bun ext/moltarc.ts find|seal`), so zero
 * chunk-format code lives in native land. Proof: ext/moltarc-dll.test.ts
 * loads moltarc.dll via bun:sqlite and runs seal -> find -> miss==NULL.
 *
 * Build (MinGW gcc 14.2, sqlite amalgamation headers in amalg/):
 *   gcc -shared -O2 -I amalg/sqlite-amalgamation-3530400 -DMOLTARC_TS="<abs path>/ext/moltarc.ts" moltarc.c moltarc_hook.c -o moltarc.dll
 *
 * SQL contract (both scalar, both TEXT in / TEXT out):
 *   moltarc_find(outDir TEXT, trxId TEXT) -> TEXT | NULL   -- read-only
 *     NULL on miss. returns one JSON object:
 *       {"id","table","device_id","seq","ts","body","chunk"}
 *   moltarc_seal(hotDb TEXT, outDir TEXT[, table TEXT]) -> TEXT
 *     returns the SealResult JSON. safe by construction: seal() never
 *     deletes input, re-seal is idempotent via the per-device
 *     sealed_upto_seq watermark, refuses below the free-space reserve.
 *
 * No-format-fork rule: the chunk codec (64B UMK1 header + columnar frame +
 * zstd/deflate, crc32c + sha256 per chunk) lives in exactly one place.
 * This file MUST NOT reimplement it. Wire the canonical reader via ONE of:
 *   (a) link a future libmoltarcchunk exposing moltarc_chunk_find(), or
 *   (b) subprocess: exec `bun ext/moltarc.ts find <outDir> <trxId>` and
 *       return its stdout (exit 1 == SQL NULL). slower, zero native deps.
 * Until (a) exists, (b) is the sanctioned path; the skeletons below call
 * the (a)-shaped hook so the cutover is one function body.
 *
 * Build (once a toolchain exists):
 *   gcc -shared -fPIC -O2 -I<sqlite-src> moltarc.c -o moltarc.so
 *   cl /LD moltarc.c sqlite3.lib /Femoltarc.dll      (msvc)
 *
 * Stock sqlite3 CLI proof transcript (the acceptance run):
 *   .load ./moltarc
 *   SELECT moltarc_seal('hot.jsonl', '/tmp/arc', 'log');
 *   SELECT moltarc_find('/tmp/arc', 'trx-00000026');
 *   -- second column returns the sealed row JSON; unknown id returns NULL.
 */

#include "sqlite3ext.h"
SQLITE_EXTENSION_INIT1
#include <stdlib.h>
#include <string.h>

/* Canonical-reader hook (provided by libmoltarcchunk, option (a)).
 * Returns malloc'd row JSON (caller frees), or NULL on miss.
 * rc: 0 = row, 1 = miss, <0 = error with sqlite3-style message in *err. */
extern int moltarc_chunk_find(const char *outdir, const char *trxid,
                              char **json, char **err);

/* Canonical-seal hook. Returns malloc'd SealResult JSON, or NULL on error
 * with message in *err. Never deletes input; idempotent via watermark. */
extern int moltarc_chunk_seal(const char *hotdb, const char *outdir,
                              const char *table, char **json, char **err);

static void x_moltarc_find(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  const char *outdir, *trxid;
  char *json = 0, *err = 0;
  int rc;
  if (argc != 2) {
    sqlite3_result_error(ctx, "moltarc_find(outDir, trxId): wrong arity", -1);
    return;
  }
  outdir = (const char *)sqlite3_value_text(argv[0]);
  trxid = (const char *)sqlite3_value_text(argv[1]);
  if (!outdir || !trxid) { sqlite3_result_null(ctx); return; }
  /* Read-only path: manifest + single-chunk fetch inside the hook.
   * No sqlite3_result_error on miss — a miss is SQL NULL by contract. */
  rc = moltarc_chunk_find(outdir, trxid, &json, &err);
  if (rc == 0) {
    sqlite3_result_text(ctx, json, -1, SQLITE_TRANSIENT);
    sqlite3_free(json);
  } else if (rc == 1) {
    sqlite3_result_null(ctx);
  } else {
    sqlite3_result_error(ctx, err ? err : "moltarc_find: internal error", -1);
    sqlite3_free(err);
  }
}

static void x_moltarc_seal(sqlite3_context *ctx, int argc, sqlite3_value **argv) {
  const char *hotdb, *outdir, *table;
  char *json = 0, *err = 0;
  int rc;
  if (argc < 2 || argc > 3) {
    sqlite3_result_error(ctx, "moltarc_seal(hotDb, outDir[, table]): wrong arity", -1);
    return;
  }
  hotdb = (const char *)sqlite3_value_text(argv[0]);
  outdir = (const char *)sqlite3_value_text(argv[1]);
  table = argc == 3 ? (const char *)sqlite3_value_text(argv[2]) : "log";
  if (!hotdb || !outdir || !table) { sqlite3_result_null(ctx); return; }
  /* Seal second, only because it is trivially safe (see header). Errors
   * propagate as SQL errors: a failed seal must never look like a row. */
  rc = moltarc_chunk_seal(hotdb, outdir, table, &json, &err);
  if (rc == 0) {
    sqlite3_result_text(ctx, json, -1, SQLITE_TRANSIENT);
    sqlite3_free(json);
  } else {
    sqlite3_result_error(ctx, err ? err : "moltarc_seal: internal error", -1);
    sqlite3_free(err);
  }
}

#ifdef _WIN32
__declspec(dllexport)
#endif
int sqlite3_moltarc_init(sqlite3 *db, char **pzErr, const sqlite3_api_routines *pApi) {
  int rc;
  SQLITE_EXTENSION_INIT2(pApi);
  (void)pzErr;
  rc = sqlite3_create_function(db, "moltarc_find", 2, SQLITE_UTF8 | SQLITE_DETERMINISTIC,
                               0, x_moltarc_find, 0, 0);
  if (rc == SQLITE_OK)
    rc = sqlite3_create_function(db, "moltarc_seal", -1, SQLITE_UTF8,
                                 0, x_moltarc_seal, 0, 0);
  return rc;
}

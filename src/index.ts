// molt v0.1 — tiered SQLite archive: hot WAL -> warm chunks -> cold relay + manifest.
export { seal, readHotRows, readSqliteRows, isSqliteFile, normRow, chunkName, TARGET_BYTES, MIN_BYTES, MAX_BYTES } from './seal.js';
export type { SealOpts, SealResult } from './seal.js';
export { buildManifest, saveManifestAtomic, loadManifest, rebuildFromFilenames, buildBloom, bloomCheck } from './manifest.js';
export type { ChunkEntry, Manifest } from './manifest.js';
export { ship, planShipment, sendChunked, readRelayIndex, laneOf } from './ship.js';
export type { ShipOpts, ShipResult, RelayIndex } from './ship.js';
export { findTrx, candidates, buildSparseIndex } from './find.js';
export type { FindOpts, FindResult, SparseEntry } from './find.js';
export { verifyChunk, verifyAll, quarantine, repairByHash } from './verify.js';
export type { VerifyItem, VerifyResult } from './verify.js';
export { encodeChunk, decodeChunk, encodeHeader, decodeHeader, crc32c, sha256hex, fnv1a32, DICT_FLAG } from './chunk.js';
export { trainTableDict, saveDictAtomic, loadDictFor, dictFile, dictHex, DICT_MAX_BYTES, DICT_TRAIN_ROWS } from './dict.js';

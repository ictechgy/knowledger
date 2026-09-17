#!/usr/bin/env node
/** Fabric 어댑터 읽기 경로의 대규모 성능 측정.

로컬 시뮬레이션 저널(ledger_transactions)을 그대로 합성 Fabric 블록으로
변환해 SqliteFabricProjection에 재생한 뒤, FabricApplicationLedger 위에서
performance-smoke와 같은 전체 페이지 읽기 workload를 측정한다. 블록은 실제
protobuf·해시 체인·프로젝터 검증을 거치지만 네트워크 커밋 증명은 아니며,
수치는 Fabric SLA가 아니라 어댑터 읽기 경로의 측정값이다. */
import { cpus } from 'node:os';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LocalLedger, verifyJournalDb } from '../packages/storage/local-ledger.ts';
import { PrivateStore } from '../packages/storage/private-store.ts';
import { KnowledgerService } from '../apps/api/service.ts';
import { BOOTSTRAP_ACTOR, CHANNEL_ID, demoDefinition, demoFixtures } from '../examples/order-workflow/config.ts';
import { seedDemo } from '../examples/order-workflow/application.ts';
import { browseAll, directoryBytes, generateSyntheticDocument, latency, marker } from './performance-smoke.ts';
import type { LatencyMetric, PerformanceSmokeOptions } from './performance-smoke.ts';

const requireFabric = createRequire(new URL('../packages/fabric/package.json', import.meta.url));
let protos: any;
let Timestamp: any;
// Fabric 모듈들은 fabric-protos를 모듈 레벨에서 요구하므로 import도 의존성 확인 이후로 미룬다.
let SqliteFabricProjection: typeof import('../packages/fabric/sqlite-projection.ts').SqliteFabricProjection;
let fabricBlockHeaderHash: typeof import('../packages/fabric/block-projector.ts').fabricBlockHeaderHash;
let FabricApplicationLedger: typeof import('../packages/fabric/application-ledger.ts').FabricApplicationLedger;
let canonicalize: typeof import('../packages/domain/index.ts').canonicalize;
let fabricDepsReady: Promise<void> | undefined;
/** 선택적 Fabric 의존성을 첫 사용 시점에 불러온다 — 모듈 import만으로 프로세스를 종료하지 않는다.
단일 프로미스로 원자화해 동시 호출이 부분 초기화를 보지 않게 하고, 실패 시 재시도가 가능하다. */
function ensureFabricDeps(): Promise<void> {
  fabricDepsReady ??= (async () => {
    let loadedProtos: any;
    let loadedTimestamp: any;
    try {
      loadedProtos = await import(requireFabric.resolve('@hyperledger/fabric-protos'));
      loadedTimestamp = requireFabric('google-protobuf/google/protobuf/timestamp_pb.js').Timestamp;
    } catch (cause) {
      throw new Error('performance-fabric requires the optional packages/fabric dependencies (npm ci --prefix packages/fabric)', { cause });
    }
    const projectionModule = await import('../packages/fabric/sqlite-projection.ts');
    const projectorModule = await import('../packages/fabric/block-projector.ts');
    const ledgerModule = await import('../packages/fabric/application-ledger.ts');
    const domainModule = await import('../packages/domain/index.ts');
    protos = loadedProtos;
    Timestamp = loadedTimestamp;
    SqliteFabricProjection = projectionModule.SqliteFabricProjection;
    fabricBlockHeaderHash = projectorModule.fabricBlockHeaderHash;
    FabricApplicationLedger = ledgerModule.FabricApplicationLedger;
    canonicalize = domainModule.canonicalize;
  })();
  fabricDepsReady.catch(() => { fabricDepsReady = undefined; });
  return fabricDepsReady;
}

const MAX_TX_PER_BLOCK = 500;
const DEFAULT_TX_PER_BLOCK = 50;

interface FabricSmokeOptions extends PerformanceSmokeOptions { txPerBlock?: number; journalPath?: string }

export interface FabricSmokeResult {
  schema_version: 1;
  mode: 'fabric-adapter-synthetic';
  environment: { node: string; platform: string; arch: string; cpu_count: number };
  dataset: { documents_requested: number; body_bytes: number; samples: number; slot_groups: number; journal_transactions: number; fabric_blocks: number; tx_per_block: number; marker: string; read_workload: 'all_pages_summary' };
  metrics: {
    ingest_total_ms: number;
    ingest_per_block_ms: number;
    search: LatencyMetric;
    overview: LatencyMetric;
    replay_restart_ms: number;
    database_bytes: number;
  };
  functional_assertions: {
    documents_generated: number;
    documents_retrieved: number;
    search_matches: number;
    replay_documents_retrieved: number;
    replay_search_matches: number;
  };
  assessment: { functional_pass: true; performance: 'measurement_only'; fabric_sla_proven: false; note: string };
}

function digest(value: Uint8Array): Uint8Array { return createHash('sha256').update(value).digest(); }

/** 단일 트랜잭션의 다중 쓰기를 담은 ENDORSER_TRANSACTION 엔벌로프를 만든다. */
function transaction(txId: string, timestampIso: string, writes: [string, unknown][]): Uint8Array {
  const { common, ledger, peer } = protos;
  const channelHeader = new common.ChannelHeader();
  channelHeader.setType(common.HeaderType.ENDORSER_TRANSACTION);
  channelHeader.setChannelId(CHANNEL_ID);
  channelHeader.setTxId(txId);
  const timestamp = new Timestamp();
  const millis = Date.parse(timestampIso);
  timestamp.setSeconds(Math.floor(millis / 1000));
  timestamp.setNanos((millis % 1000) * 1_000_000);
  channelHeader.setTimestamp(timestamp);
  const header = new common.Header();
  header.setChannelHeader(channelHeader.serializeBinary());
  const kv = new ledger.rwset.kvrwset.KVRWSet();
  for (const [key, value] of writes) {
    const write = new ledger.rwset.kvrwset.KVWrite();
    write.setKey(key);
    write.setValue(Buffer.from(canonicalize(value)));
    kv.getWritesList().push(write);
  }
  const namespace = new ledger.rwset.NsReadWriteSet();
  namespace.setNamespace('kcl');
  namespace.setRwset(kv.serializeBinary());
  const rwset = new ledger.rwset.TxReadWriteSet();
  rwset.getNsRwsetList().push(namespace);
  const id = new peer.ChaincodeID();
  id.setName('kcl');
  id.setVersion('0.1.0');
  const action = new peer.ChaincodeAction();
  action.setChaincodeId(id);
  action.setResults(rwset.serializeBinary());
  const response = new peer.ProposalResponsePayload();
  response.setExtension$(action.serializeBinary());
  const endorsed = new peer.ChaincodeEndorsedAction();
  endorsed.setProposalResponsePayload(response.serializeBinary());
  const payload = new peer.ChaincodeActionPayload();
  payload.setAction(endorsed);
  const actionEntry = new peer.TransactionAction();
  actionEntry.setPayload(payload.serializeBinary());
  const tx = new peer.Transaction();
  tx.getActionsList().push(actionEntry);
  const body = new common.Payload();
  body.setHeader(header);
  body.setData(tx.serializeBinary());
  const envelope = new common.Envelope();
  envelope.setPayload(body.serializeBinary());
  return envelope.serializeBinary();
}

/** 검증 필터가 전부 VALID인 블록을 만들고 헤더 해시를 함께 돌려준다. */
function blockBytes(number: number, entries: Uint8Array[], previousHashHex: string): { bytes: Uint8Array; hash: string } {
  const { common } = protos;
  const data = new common.BlockData();
  data.setDataList(entries);
  const header = new common.BlockHeader();
  header.setNumber(number);
  header.setPreviousHash(previousHashHex ? Buffer.from(previousHashHex, 'hex') : new Uint8Array());
  header.setDataHash(digest(Buffer.concat(entries.map(entry => Buffer.from(entry)))));
  const metadata = new common.BlockMetadata();
  metadata.setMetadataList([new Uint8Array(), new Uint8Array(), Uint8Array.from(entries.map(() => 0))]);
  const block = new common.Block();
  block.setHeader(header);
  block.setData(data);
  block.setMetadata(metadata);
  return { bytes: block.serializeBinary(), hash: fabricBlockHeaderHash(header) };
}

/** 이미 열린 저널 스냅샷을 순서대로 읽어 합성 블록을 만들어 projection에 재생한다. */
function ingestJournal(journal: DatabaseSync, projection: { applyBlock(block: Uint8Array): void }, txPerBlock: number): { transactions: number; blocks: number; tipHash: string; applyMs: number } {
  const rows = journal.prepare('SELECT record_json FROM ledger_transactions ORDER BY sequence').iterate() as Iterable<any>;
  let pending: Uint8Array[] = [];
  let blockNumber = 0;
  let previousHash = '';
  let transactions = 0;
  let applyMs = 0;
  const flush = () => {
    if (!pending.length) return;
    const built = blockBytes(blockNumber++, pending, previousHash);
    const started = performance.now();
    projection.applyBlock(built.bytes);
    applyMs += performance.now() - started;
    previousHash = built.hash;
    pending = [];
  };
  for (const row of rows) {
    const event = JSON.parse(row.record_json);
    pending.push(transaction(event.checkpoint.transaction_id, event.timestamp, event.writes));
    transactions++;
    if (pending.length >= txPerBlock) flush();
  }
  flush();
  return { transactions, blocks: blockNumber, tipHash: previousHash, applyMs };
}

function boundedInteger(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} is outside the allowed range`);
  return value;
}

export async function runFabricPerformance(input: FabricSmokeOptions): Promise<FabricSmokeResult> {
  await ensureFabricDeps();
  if (!isAbsolute(input.dataDir)) throw new Error('dataDir must be absolute');
  const dataDir = resolve(input.dataDir);
  const options = {
    documents: boundedInteger(input.documents ?? 8, 'documents', 1, 100_000),
    samples: boundedInteger(input.samples ?? 3, 'samples', 1, 1_000),
    bodyBytes: boundedInteger(input.bodyBytes ?? 1024, 'bodyBytes', 1, 256 * 1024),
    slotGroups: boundedInteger(input.slotGroups ?? 1, 'slotGroups', 1, 256),
    txPerBlock: boundedInteger(input.txPerBlock ?? DEFAULT_TX_PER_BLOCK, 'txPerBlock', 1, MAX_TX_PER_BLOCK),
  };
  const journalSource = input.journalPath ? resolve(input.journalPath) : join(dataDir, 'local', 'shared-ledger.sqlite');
  // --journal은 신뢰 입력이 아니다 — 디렉터리를 만들기 전에 존재를 확인한다.
  if (input.journalPath && !existsSync(journalSource)) throw new Error(`--journal path does not exist: ${journalSource}`);
  if (existsSync(dataDir)) {
    if (readdirSync(dataDir).length !== 0) throw new Error('dataDir must be a new or empty directory');
  } else mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const localDir = join(dataDir, 'local');
  const fabricDir = join(dataDir, 'fabric');
  mkdirSync(localDir, { recursive: true, mode: 0o700 });
  mkdirSync(fabricDir, { recursive: true, mode: 0o700 });
  const localLedgerPath = join(localDir, 'shared-ledger.sqlite');
  const projectionPath = join(fabricDir, 'fabric-projection.sqlite');

  // 1) 동일 생성 절차로 로컬 저널을 만든다. --journal이면 기존 저널을 재사용한다.
  const definition = demoDefinition();
  if (!input.journalPath) {
    const localLedger = new LocalLedger(localLedgerPath, CHANNEL_ID);
    let localVault: PrivateStore | undefined;
    try {
      localVault = new PrivateStore(join(localDir, 'private-local.sqlite'));
      const localService = new KnowledgerService(localLedger, localVault, definition);
      await localService.initialize();
      await seedDemo(localService);
      for (let index = 0; index < options.documents; index += 1) await generateSyntheticDocument(localService, index, options);
    } finally {
      try { localVault?.close(); } catch { /* 첫 실패를 보존한다 */ }
      try { localLedger.close(); } catch { /* 첫 실패를 보존한다 */ }
    }
  }

  // 2) 저널 이벤트를 합성 블록으로 변환해 projection에 재생한다.
  //    이 지점부터 예외 경로에서도 projection·서비스 자원을 닫아야 한다.
  let projection = new SqliteFabricProjection(projectionPath, { channel_id: CHANNEL_ID, chaincode_name: 'kcl', chaincode_version: '0.1.0', public_genesis: demoFixtures().config });
  let opened: { ledger: InstanceType<typeof FabricApplicationLedger>; vault: PrivateStore; service: KnowledgerService } | undefined;
  let journalDb: DatabaseSync | undefined;
  try {
    // --journal은 검증과 재생을 같은 읽기 트랜잭션 스냅샷에 묶는다 — 검증 사이에
    // 파일이 바뀌어 섞이지 않는다. 자체 생성 저널은 LocalLedger 생성자가 검증했다.
    // read-only 오픈은 WAL 미체크포인트 데이터가 있고 SHM이 없는 저널에서 실패할 수 있다 —
    // 그 경우 명확한 안내를 낸다(immutable로 우회하면 미체크포인트 트랜잭션을 조용히 잃는다).
    try {
      journalDb = new DatabaseSync(journalSource, { readOnly: true });
    } catch (error) {
      throw new Error(`cannot open journal read-only (checkpoint the journal by closing its writer first): ${journalSource}`, { cause: error });
    }
    journalDb.exec('BEGIN');
    if (input.journalPath) verifyJournalDb(journalDb, CHANNEL_ID);
    const ingest = ingestJournal(journalDb, projection, options.txPerBlock);
    journalDb.exec('COMMIT');
    journalDb.close();
    journalDb = undefined;

    // 3) Fabric 어댑터 위에서 동일한 전체 페이지 읽기 workload를 측정한다.
    const source = {
      async getTip() { return { height: ingest.blocks, block_hash: ingest.tipHash }; },
      async getBlock(): Promise<Uint8Array> { throw new Error('synthetic benchmark keeps the projection at the tip'); },
    };
    const openService = async () => {
      // 읽기 전용 측정이므로 쓰기 transport는 호출되지 않는 스텁이다.
      const routes = [{ actor: { ...BOOTSTRAP_ACTOR }, transport: {
        execute: async () => { throw new Error('synthetic benchmark does not submit commands'); },
        recoverPending: async () => [],
      } }];
      const ledger = new FabricApplicationLedger({ projection, source, routes });
      let vault: PrivateStore | undefined;
      try {
        await ledger.refresh();
        vault = new PrivateStore(join(fabricDir, 'private-fabric.sqlite'));
        const service = new KnowledgerService(ledger, vault, definition);
        await service.initialize();
        return { ledger, vault, service };
      } catch (error) {
        // 초기화 중간 실패 시 확보한 핸들을 그대로 두지 않는다 — ledger.close()가 projection까지 닫는다.
        try { vault?.close(); } catch { /* 첫 실패를 보존한다 */ }
        try { await ledger.close(); } catch { /* 첫 실패를 보존한다 */ }
        throw error;
      }
    };
    opened = await openService();
    const searchTimes: number[] = [];
    const overviewTimes: number[] = [];
    let measuredSearchMatches = 0;
    let overview = await browseAll(opened.service);
    const generated = overview.filter((item: any) => item.payload.document_id.startsWith('doc-performance-'));
    if (generated.length !== options.documents) {
      throw new Error(input.journalPath
        ? `--journal has ${generated.length} generated documents but --documents=${options.documents}`
        : `generated document count mismatch: expected ${options.documents}, got ${generated.length}`);
    }
    for (let sample = 0; sample < options.samples; sample += 1) {
      let started = performance.now();
      const search = await browseAll(opened.service, true);
      searchTimes.push(performance.now() - started);
      if (search.length !== options.documents) throw new Error('search result count mismatch');
      measuredSearchMatches = search.length;
      started = performance.now();
      overview = await browseAll(opened.service);
      overviewTimes.push(performance.now() - started);
      if (overview.filter((item: any) => item.payload.document_id.startsWith('doc-performance-')).length !== options.documents) throw new Error('overview result count mismatch');
    }
    const databaseBytesBeforeReplay = directoryBytes(fabricDir);
    // ledger.close()가 projection까지 닫으므로 재오픈 전 기존 핸들을 명시적으로 닫는다.
    await opened.ledger.close();
    opened.vault.close();
    opened = undefined;
    // projection 재오픈은 저장된 raw 블록에서 파생 상태를 다시 재생한다.
    const replayStarted = performance.now();
    projection = new SqliteFabricProjection(projectionPath, { channel_id: CHANNEL_ID, chaincode_name: 'kcl', chaincode_version: '0.1.0', public_genesis: demoFixtures().config });
    opened = await openService();
    const replayRestartMs = performance.now() - replayStarted;
    const replayOverview = await browseAll(opened.service);
    const replaySearch = await browseAll(opened.service, true);
    const replayDocuments = replayOverview.filter((item: any) => item.payload.document_id.startsWith('doc-performance-')).length;
    if (replayDocuments !== options.documents || replaySearch.length !== options.documents) throw new Error('replay result count mismatch');
    return {
      schema_version: 1,
      mode: 'fabric-adapter-synthetic',
      environment: { node: process.version, platform: process.platform, arch: process.arch, cpu_count: cpus().length },
      dataset: { documents_requested: options.documents, body_bytes: options.bodyBytes, samples: options.samples, slot_groups: options.slotGroups, journal_transactions: ingest.transactions, fabric_blocks: ingest.blocks, tx_per_block: options.txPerBlock, marker, read_workload: 'all_pages_summary' },
      metrics: { ingest_total_ms: ingest.applyMs, ingest_per_block_ms: ingest.blocks ? ingest.applyMs / ingest.blocks : 0, search: latency(searchTimes), overview: latency(overviewTimes), replay_restart_ms: replayRestartMs, database_bytes: databaseBytesBeforeReplay },
      functional_assertions: {
        documents_generated: generated.length,
        documents_retrieved: overview.filter((item: any) => item.payload.document_id.startsWith('doc-performance-')).length,
        search_matches: measuredSearchMatches,
        replay_documents_retrieved: replayDocuments,
        replay_search_matches: replaySearch.length,
      },
      assessment: { functional_pass: true, performance: 'measurement_only', fabric_sla_proven: false, note: 'Synthetic journal replay through the real block projector and adapter; not a network commit proof.' },
    };
  } finally {
    try { journalDb?.close(); } catch { /* 첫 실패를 보존한다 */ }
    try { await opened?.ledger.close(); } catch { /* 첫 실패를 보존한다 */ }
    try { opened?.vault.close(); } catch { /* 첫 실패를 보존한다 */ }
    // ledger.close()는 projection을 함께 닫는다 — 서비스를 열기 전에 실패한 경로를 위해 idempotent close를 호출한다.
    try { projection.close(); } catch { /* 첫 실패를 보존한다 */ }
  }
}

function parseCli(args: string[]): { options: FabricSmokeOptions; out?: string; ownedData: boolean } {
  const known = new Set(['--data', '--documents', '--samples', '--body-bytes', '--slot-groups', '--tx-per-block', '--journal', '--out']);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!known.has(name) || !value || value.startsWith('--') || values.has(name)) throw new Error('invalid option');
    values.set(name, value);
  }
  const data = values.has('--data') ? resolve(values.get('--data')!) : undefined;
  const out = values.has('--out') ? resolve(values.get('--out')!) : undefined;
  if (!data) mkdirSync(resolve('.data'), { recursive: true, mode: 0o700 });
  const ownedData = !data;
  const dataDir = data ?? mkdtempSync(join(resolve('.data'), 'performance-fabric-'));
  const number = (name: string) => {
    const value = values.get(name);
    return value === undefined ? undefined : Number(value);
  };
  return { options: { dataDir, documents: number('--documents'), samples: number('--samples'), bodyBytes: number('--body-bytes'), slotGroups: number('--slot-groups'), txPerBlock: number('--tx-per-block'), journalPath: values.get('--journal') }, out, ownedData };
}

function isMain(): boolean {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMain()) {
  let dataDir: string | undefined;
  let ownedData = false;
  try {
    const parsed = parseCli(process.argv.slice(2));
    dataDir = parsed.options.dataDir;
    ownedData = parsed.ownedData;
    const result = await runFabricPerformance(parsed.options);
    const output = JSON.stringify(result, null, 2);
    if (parsed.out) { mkdirSync(resolve(parsed.out, '..'), { recursive: true, mode: 0o700 }); writeFileSync(parsed.out, `${output}\n`, { mode: 0o600 }); }
    process.stdout.write(`${output}\n`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    process.stderr.write(`performance-fabric failed: ${detail}\n`);
    process.exitCode = 1;
  } finally {
    if (ownedData && dataDir) rmSync(dataDir, { recursive: true, force: true });
  }
}

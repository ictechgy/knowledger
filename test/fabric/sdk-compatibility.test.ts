import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { connectOfficialFabricGateway } from '../../packages/fabric/gateway.ts';

const require = createRequire(new URL('../../packages/fabric/package.json', import.meta.url));
let installed = false;
try { require.resolve('@hyperledger/fabric-gateway'); installed = true; }
catch (error) {
  const missing = error as NodeJS.ErrnoException;
  if (missing.code !== 'MODULE_NOT_FOUND' || !missing.message.startsWith("Cannot find module '@hyperledger/fabric-gateway'")) throw error;
}

test('real Gateway SDK times out an unresponsive peer status call and can retry it', { skip: !installed }, async () => {
  const grpc = require('@grpc/grpc-js');
  const { gateway: proto } = require('@hyperledger/fabric-protos');
  const server = new grpc.Server();
  let respond = false;
  server.addService(proto.GatewayService, {
    commitStatus(_call: unknown, callback: (error: unknown, value: unknown) => void) {
      if (respond) {
        const result = new proto.CommitStatusResponse();
        result.setResult(0);
        result.setBlockNumber(7);
        callback(null, result);
      }
    },
  });
  const port = await new Promise<number>((resolve, reject) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err: Error, port: number) => err ? reject(err) : resolve(port)));
  const rpc = new grpc.Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
  const client = await connectOfficialFabricGateway({
    client: rpc, channel_id: 'kcl-demo', chaincode_name: 'kcl',
    credentials: { msp_id: 'SalesMSP', certificate: Buffer.from('synthetic-test-identity'), signer: digest => digest },
    timeouts_ms: { commit_status: 100 },
  });
  const request = new proto.CommitStatusRequest();
  request.setChannelId('kcl-demo');
  request.setTransactionId('tx-unresponsive');
  const signed = new proto.SignedCommitStatusRequest();
  signed.setRequest(request.serializeBinary());
  const bytes = signed.serializeBinary();
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const safety = new Promise<never>((_, reject) => { watchdog = setTimeout(() => reject(new Error('Gateway status never reached its deadline')), 2000); });
    await assert.rejects(Promise.race([client.getStatus('tx-unresponsive', bytes), safety]), (error: any) => error.code === grpc.status.DEADLINE_EXCEEDED);
    respond = true;
    const status = await client.getStatus('tx-unresponsive', bytes);
    assert.equal(status.status, 'VALID');
    assert.equal(status.block_number, 7);
  } finally {
    clearTimeout(watchdog);
    client.close?.(); rpc.close(); server.forceShutdown();
  }
});

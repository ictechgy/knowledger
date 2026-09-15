import genesis from "./genesis.json" with { type: "json" };
import { bootstrap, execute } from "../../packages/domain/index.ts";
import { FabricChaincode } from "../../packages/fabric/chaincode.ts";
import { startFabricChaincode } from "../../packages/fabric/chaincode-loader.ts";

await startFabricChaincode((responses, identity_decoder) => new FabricChaincode(
  { bootstrap, execute },
  {
    channel_id: genesis.channel_id,
    public_genesis: genesis,
    bootstrap_identity: { msp_id: "FulfillmentMSP", actor_id: "person-fulfillment-owner", actor_kind: "human" },
    registered_identities: genesis.identities.map(({ org_id, actor_id, kind }) => ({ msp_id: org_id, actor_id, actor_kind: kind })),
    identity_decoder,
    responses,
  },
));

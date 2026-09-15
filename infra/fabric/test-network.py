#!/usr/bin/env python3
"""Disposable, loopback-only Fabric integration network; never a production setup.

prepare writes public configuration only. up creates and uses fresh test keys;
obtain the repository-required credential approval before running that command.
Existing generated identities are never replaced. stop preserves all volumes.
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
STATE = ROOT / ".data/fabric-smoke"
TOOLS = ROOT / ".tools/fabric-2.5.16"
COMPOSE = ROOT / ".tools/docker-compose"
ORGS = [("sales", "SalesMSP", 17051), ("fulfillment", "FulfillmentMSP", 18051), ("settlement", "SettlementMSP", 19051)]
CHANNEL = "kcl-demo"
IMAGES = {
    "peer": "hyperledger/fabric-peer@sha256:09ee75042de9983bfde31ca88a5bf033386351f10a990e4c48264ee50172dee0",
    "orderer": "hyperledger/fabric-orderer@sha256:e322c57331d37e0a35ffae3cb3d3265a0e852211c0f801f2514cc15b964ffc93",
    "nodeenv": "hyperledger/fabric-nodeenv@sha256:17e2d447ca0de5b4e3f6950a1c9b24ecfdeecdd90e111e11d771970d35159bf1",
}


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def run(args, *, env=None, timeout=180):
    # Commands may refer to test key paths, but no key/certificate contents or
    # credential-bearing command arguments are printed by this harness.
    result = subprocess.run([str(a) for a in args], cwd=ROOT, env=env, text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f"{Path(str(args[0])).name} failed ({result.returncode}):\n{result.stderr[-5000:]}")
    return result.stdout


def compose(*args):
    return run([COMPOSE, "--context", "colima", "-p", "kcl-fabric-smoke", "-f", STATE / "compose.json", *args], timeout=300)


def check_tools():
    version = run(["node", "--version"]).strip()
    if int(version.lstrip("v").split(".")[0]) < 24:
        raise RuntimeError("Use Node 24 or later in PATH before generating test identities")
    if "v2.5.16" not in run([TOOLS / "bin/peer", "version"]):
        raise RuntimeError("The harness requires the pinned Fabric 2.5.16 CLI")
    run([COMPOSE, "version"])
    run(["openssl", "version"])
    run(["docker", "--context", "colima", "info", "--format", "{{.ServerVersion}}"])


def implicit(rule):
    return {"Type": "ImplicitMeta", "Rule": rule}


def policies():
    return {"Readers": implicit("ANY Readers"), "Writers": implicit("ANY Writers"), "Admins": implicit("MAJORITY Admins")}


def organization(name, msp, directory, orderer=False):
    value = {"Name": msp, "ID": msp, "MSPDir": str(directory / "msp"), "Policies": {
        key: {"Type": "Signature", "Rule": f"OR('{msp}.{role}')"}
        for key, role in [("Readers", "member"), ("Writers", "member"), ("Admins", "admin"), ("Endorsement", "peer")]
    }}
    if orderer:
        value["OrdererEndpoints"] = [f"orderer{i}.kcl.test:7050" for i in range(3)]
    else:
        value["AnchorPeers"] = [{"Host": f"peer0.{name}.kcl.test", "Port": 7051}]
    return value


def prepare():
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    crypto = STATE / "crypto"
    write_json(STATE / "crypto-config.yaml", {
        "OrdererOrgs": [{"Name": "Orderer", "Domain": "kcl.test", "EnableNodeOUs": True,
                         "Specs": [{"Hostname": f"orderer{i}", "SANS": ["localhost", "127.0.0.1"]} for i in range(3)]}],
        "PeerOrgs": [{"Name": msp, "Domain": f"{name}.kcl.test", "EnableNodeOUs": True,
                      "Template": {"Count": 1, "SANS": ["localhost", "127.0.0.1"]}, "Users": {"Count": 1}}
                     for name, msp, _ in ORGS],
    })
    orgs = [organization(name, msp, crypto / "peerOrganizations" / f"{name}.kcl.test") for name, msp, _ in ORGS]
    orderer_org = organization("orderer", "OrdererMSP", crypto / "ordererOrganizations/kcl.test", True)
    profile = {"Policies": policies(), "Capabilities": {"V2_0": True},
               "Orderer": {"OrdererType": "etcdraft", "BatchTimeout": "1s",
                           "BatchSize": {"MaxMessageCount": 10, "AbsoluteMaxBytes": "10 MB", "PreferredMaxBytes": "2 MB"},
                           "EtcdRaft": {"Consenters": []}, "Organizations": [orderer_org],
                           "Policies": {**policies(), "BlockValidation": implicit("ANY Writers")}, "Capabilities": {"V2_0": True}},
               "Application": {"Organizations": orgs, "Policies": {**policies(), "LifecycleEndorsement": implicit("MAJORITY Endorsement"),
                               "Endorsement": implicit("MAJORITY Endorsement")}, "Capabilities": {"V2_5": True}}}
    services, volumes = {}, {}
    for i in range(3):
        host = f"orderer{i}.kcl.test"
        base = crypto / "ordererOrganizations/kcl.test/orderers" / host
        cert = str(base / "tls/server.crt")
        profile["Orderer"]["EtcdRaft"]["Consenters"].append({"Host": host, "Port": 7050, "ClientTLSCert": cert, "ServerTLSCert": cert})
        volume = f"orderer{i}-ledger"
        volumes[volume] = {}
        services[host] = {"image": IMAGES["orderer"], "hostname": host,
            "environment": {"FABRIC_LOGGING_SPEC": "WARN", "ORDERER_GENERAL_LISTENADDRESS": "0.0.0.0", "ORDERER_GENERAL_LISTENPORT": "7050",
                "ORDERER_GENERAL_LOCALMSPID": "OrdererMSP", "ORDERER_GENERAL_LOCALMSPDIR": "/var/hyperledger/orderer/msp",
                "ORDERER_GENERAL_BOOTSTRAPMETHOD": "none", "ORDERER_CHANNELPARTICIPATION_ENABLED": "true",
                "ORDERER_GENERAL_TLS_ENABLED": "true", "ORDERER_GENERAL_TLS_PRIVATEKEY": "/var/hyperledger/orderer/tls/server.key",
                "ORDERER_GENERAL_TLS_CERTIFICATE": "/var/hyperledger/orderer/tls/server.crt", "ORDERER_GENERAL_TLS_ROOTCAS": "[/var/hyperledger/orderer/tls/ca.crt]",
                "ORDERER_GENERAL_CLUSTER_CLIENTCERTIFICATE": "/var/hyperledger/orderer/tls/server.crt", "ORDERER_GENERAL_CLUSTER_CLIENTPRIVATEKEY": "/var/hyperledger/orderer/tls/server.key",
                "ORDERER_GENERAL_CLUSTER_ROOTCAS": "[/var/hyperledger/orderer/tls/ca.crt]",
                "ORDERER_ADMIN_LISTENADDRESS": "0.0.0.0:7053", "ORDERER_ADMIN_TLS_ENABLED": "true",
                "ORDERER_ADMIN_TLS_CERTIFICATE": "/var/hyperledger/orderer/tls/server.crt", "ORDERER_ADMIN_TLS_PRIVATEKEY": "/var/hyperledger/orderer/tls/server.key",
                "ORDERER_ADMIN_TLS_CLIENTROOTCAS": "[/var/hyperledger/orderer/tls/ca.crt]"},
            "ports": [f"127.0.0.1:{17050+i*1000}:7050", f"127.0.0.1:{17053+i*1000}:7053"],
            "volumes": [f"{base}/msp:/var/hyperledger/orderer/msp:ro", f"{base}/tls:/var/hyperledger/orderer/tls:ro", f"{volume}:/var/hyperledger/production/orderer"]}
    for name, msp, port in ORGS:
        host = f"peer0.{name}.kcl.test"
        base = crypto / "peerOrganizations" / f"{name}.kcl.test" / "peers" / host
        volume = f"{name}-ledger"
        volumes[volume] = {}
        services[host] = {"image": IMAGES["peer"], "hostname": host,
            "environment": {"FABRIC_LOGGING_SPEC": "WARN", "CORE_PEER_ID": host, "CORE_PEER_ADDRESS": f"{host}:7051",
                "CORE_PEER_LISTENADDRESS": "0.0.0.0:7051", "CORE_PEER_CHAINCODEADDRESS": f"{host}:7052", "CORE_PEER_CHAINCODELISTENADDRESS": "0.0.0.0:7052",
                "CORE_PEER_LOCALMSPID": msp, "CORE_PEER_MSPCONFIGPATH": "/etc/hyperledger/fabric/msp",
                "CORE_PEER_GOSSIP_BOOTSTRAP": f"{host}:7051", "CORE_PEER_GOSSIP_EXTERNALENDPOINT": f"{host}:7051",
                "CORE_PEER_TLS_ENABLED": "true", "CORE_PEER_TLS_CERT_FILE": "/etc/hyperledger/fabric/tls/server.crt",
                "CORE_PEER_TLS_KEY_FILE": "/etc/hyperledger/fabric/tls/server.key", "CORE_PEER_TLS_ROOTCERT_FILE": "/etc/hyperledger/fabric/tls/ca.crt",
                "CORE_VM_ENDPOINT": "unix:///host/var/run/docker.sock", "CORE_VM_DOCKER_HOSTCONFIG_NETWORKMODE": "kcl-fabric-smoke",
                "CORE_CHAINCODE_NODE_RUNTIME": IMAGES["nodeenv"], "CORE_CHAINCODE_EXECUTETIMEOUT": "30s"},
            "ports": [f"127.0.0.1:{port}:7051"],
            "volumes": [f"{base}/msp:/etc/hyperledger/fabric/msp:ro", f"{base}/tls:/etc/hyperledger/fabric/tls:ro",
                        "/var/run/docker.sock:/host/var/run/docker.sock", f"{volume}:/var/hyperledger/production"]}
    write_json(STATE / "configtx.yaml", {"Profiles": {"KclSmoke": profile}})
    write_json(STATE / "compose.json", {"services": services, "volumes": volumes, "networks": {"default": {"name": "kcl-fabric-smoke"}}})
    write_json(STATE / "versions.json", {"fabric": "2.5.16", "shim": "2.5.8", "gateway": "1.12.1", "images": IMAGES})
    print("Prepared public configuration: 3 peers, 3 Raft orderers, loopback ports 17050–19053. No identities generated.", flush=True)


def generate_identities():
    crypto = STATE / "crypto"
    if crypto.exists():
        raise RuntimeError("Test identity directory already exists; use deploy to resume. Identities will not be replaced.")
    run([TOOLS / "bin/cryptogen", "generate", "--config", STATE / "crypto-config.yaml", "--output", crypto])
    issue_client_certificates()
    print("Generated disposable test MSPs with certified KCL human actor attributes.", flush=True)


def issue_client_certificates():
    crypto = STATE / "crypto"
    for name, _, _ in ORGS:
        domain = f"{name}.kcl.test"
        base = crypto / "peerOrganizations" / domain
        msp = base / "users" / f"User1@{domain}" / "msp"
        # Test-only issuance using cryptogen's disposable CA. Preserve the
        # generated client key and add the same certified attributes as Fabric CA.
        attrs = json.dumps({"attrs": {"kcl.actor_id": f"person-{name}-owner", "kcl.actor_kind": "human"}}, separators=(",", ":"))
        extension = STATE / f"{name}-client.ext"
        # Match cryptogen's enrollment certificate: digitalSignature without a
        # TLS-only EKU restriction. Fabric MSP's X.509 validation rejects a
        # clientAuth-only signing certificate.
        extension.write_text("basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n1.2.3.4.5.6.7.8.1=DER:" + ":".join(f"{b:02X}" for b in attrs.encode()) + "\n")
        key = next((msp / "keystore").glob("*_sk"))
        csr = STATE / f"{name}-client.csr"
        run(["openssl", "req", "-new", "-key", key, "-subj", f"/C=US/O={domain}/OU=client/CN=User1@{domain}", "-out", csr])
        run(["openssl", "x509", "-req", "-in", csr, "-CA", next((base / "ca").glob("*.pem")), "-CAkey", next((base / "ca").glob("*_sk")),
             "-set_serial", "0x" + secrets.token_hex(16),
             "-days", "7", "-extfile", extension, "-out", msp / "signcerts" / f"User1@{domain}-cert.pem"])


def peer_env(org, user="Admin"):
    name, msp, port = org
    domain = f"{name}.kcl.test"
    base = STATE / "crypto/peerOrganizations" / domain
    return {**os.environ, "FABRIC_CFG_PATH": str(TOOLS / "config"), "FABRIC_LOGGING_SPEC": "WARN",
            "CORE_PEER_LOCALMSPID": msp, "CORE_PEER_MSPCONFIGPATH": str(base / "users" / f"{user}@{domain}" / "msp"),
            "CORE_PEER_ADDRESS": f"localhost:{port}", "CORE_PEER_TLS_ENABLED": "true",
            "CORE_PEER_TLS_ROOTCERT_FILE": str(base / "peers" / f"peer0.{domain}" / "tls/ca.crt")}


def peer(org, *args, user="Admin"):
    return run([TOOLS / "bin/peer", *args], env=peer_env(org, user), timeout=300)


def orderer_flags():
    return ["-o", "localhost:17050", "--ordererTLSHostnameOverride", "orderer0.kcl.test", "--tls", "--cafile",
            str(STATE / "crypto/ordererOrganizations/kcl.test/orderers/orderer0.kcl.test/tls/ca.crt")]


def peer_flags():
    flags = []
    for org in ORGS:
        env = peer_env(org)
        flags += ["--peerAddresses", env["CORE_PEER_ADDRESS"], "--tlsRootCertFiles", env["CORE_PEER_TLS_ROOTCERT_FILE"]]
    return flags


def deploy(upgrade=False):
    # All calls below use only this harness's generated credentials.
    check_tools()
    block = STATE / "channel.block"
    if not block.exists():
        run([TOOLS / "bin/configtxgen", "-configPath", STATE, "-profile", "KclSmoke", "-channelID", CHANNEL, "-outputBlock", block])
    compose("up", "-d")
    for i in range(3):
        tls = STATE / f"crypto/ordererOrganizations/kcl.test/orderers/orderer{i}.kcl.test/tls"
        admin = ["--channelID", CHANNEL, "-o", f"localhost:{17053+i*1000}", "--no-status",
                 "--ca-file", tls / "ca.crt", "--client-cert", tls / "server.crt", "--client-key", tls / "server.key"]
        for attempt in range(20):
            try:
                result = json.loads(run([TOOLS / "bin/osnadmin", "channel", "list", *admin]))
                if result.get("name") != CHANNEL:
                    result = json.loads(run([TOOLS / "bin/osnadmin", "channel", "join", *admin, "--config-block", block]))
                if result.get("name") != CHANNEL or result.get("status") != "active":
                    raise RuntimeError("Orderer channel is not active")
                break
            except RuntimeError:
                if attempt == 19:
                    raise
                time.sleep(1)
    for org in ORGS:
        for attempt in range(30):
            try:
                channels = peer(org, "channel", "list")
                if CHANNEL not in channels.splitlines():
                    peer(org, "channel", "join", "-b", block)
                break
            except RuntimeError:
                if attempt == 29:
                    raise
                time.sleep(1)
    print("All three peers joined kcl-demo.", flush=True)
    run(["node", ROOT / "infra/fabric/build.mjs"])
    run(["npm", "ci", "--prefix", ROOT / "infra/fabric/dist", "--ignore-scripts", "--no-audit", "--no-fund"])
    package = STATE / "kcl.tar.gz"
    peer(ORGS[0], "lifecycle", "chaincode", "package", package, "--path", ROOT / "infra/fabric/dist", "--lang", "node", "--label", "kcl_0.1.0")
    package_id = peer(ORGS[0], "lifecycle", "chaincode", "calculatepackageid", package).strip()
    committed = json.loads(peer(ORGS[0], "lifecycle", "chaincode", "querycommitted", "--channelID", CHANNEL, "--output", "json"))
    existing = next((item for item in committed.get("chaincode_definitions", []) if item["name"] == "kcl"), None)
    # Keep the original channel endorsement policy and plugins when replacing
    # test package bytes. Logical version/genesis/Init state stay at v0.1.0.
    expected_policy = "EiAvQ2hhbm5lbC9BcHBsaWNhdGlvbi9FbmRvcnNlbWVudA=="
    if existing and (existing["version"] != "0.1.0" or not existing.get("init_required") or existing.get("endorsement_plugin") != "escc" or existing.get("validation_plugin") != "vscc" or existing.get("validation_parameter") != expected_policy or existing.get("collections") != {}):
        raise RuntimeError("An incompatible KCL definition is already committed; review it before changing lifecycle state")
    if upgrade and not existing:
        raise RuntimeError("Deploy KCL before upgrading its package")
    sequence = existing["sequence"] + (1 if upgrade else 0) if existing else 1
    definition = ["--channelID", CHANNEL, "--name", "kcl", "--version", "0.1.0", "--sequence", str(sequence), "--init-required"]
    for org in ORGS:
        installed = json.loads(peer(org, "lifecycle", "chaincode", "queryinstalled", "--output", "json"))
        if not any(item["package_id"] == package_id for item in installed.get("installed_chaincodes", [])):
            peer(org, "lifecycle", "chaincode", "install", package)
        if existing and not upgrade:
            approved = json.loads(peer(org, "lifecycle", "chaincode", "queryapproved", "--channelID", CHANNEL, "--name", "kcl", "--sequence", str(sequence), "--output", "json"))
            if approved.get("source", {}).get("Type", {}).get("LocalPackage", {}).get("package_id") != package_id:
                raise RuntimeError("Committed definition uses a different package; deployment will not silently replace it")
            for field in ("sequence", "version", "endorsement_plugin", "validation_plugin", "validation_parameter", "collections", "init_required"):
                if approved.get(field) != existing.get(field):
                    raise RuntimeError("Organization approval differs from the committed definition")
        else:
            peer(org, "lifecycle", "chaincode", "approveformyorg", *definition, "--package-id", package_id, *orderer_flags())
    if not existing or upgrade:
        ready = json.loads(peer(ORGS[0], "lifecycle", "chaincode", "checkcommitreadiness", *definition, "--output", "json"))
        if not all(ready["approvals"].get(msp) for _, msp, _ in ORGS):
            raise RuntimeError("Not all organizations approved the chaincode definition")
        peer(ORGS[0], "lifecycle", "chaincode", "commit", *definition, *orderer_flags(), *peer_flags())
    # Query the committed peer state rather than treating a local marker file as
    # proof of initialization. This also covers a crash after Init committed.
    initialized = True
    try:
        peer(ORGS[1], "chaincode", "query", "-C", CHANNEL, "-n", "kcl", "-c", json.dumps({"Args": ["GetCommand", ORGS[1][1], "deployment-probe"]}), user="User1")
    except RuntimeError as error:
        if "has not been initialized for this version" not in str(error):
            raise
        initialized = False
    if not initialized:
        peer(ORGS[1], "chaincode", "invoke", "-C", CHANNEL, "-n", "kcl", "--isInit", "-c", '{"Args":["Init"]}',
             "--waitForEvent", "--waitForEventTimeout", "60s", *orderer_flags(), *peer_flags(), user="User1")
    for org in ORGS:
        peer(org, "chaincode", "query", "-C", CHANNEL, "-n", "kcl", "-c", json.dumps({"Args": ["GetCommand", org[1], "deployment-probe"]}), user="User1")
    write_json(STATE / "deployment.json", {"channel": CHANNEL, "chaincode": "kcl", "package_id": package_id, "sequence": sequence, "organizations": [msp for _, msp, _ in ORGS]})
    print("Verified deployed lifecycle and authenticated queries on all peers." if initialized else "Founder Init committed VALID; authenticated queries verified on all peers.", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["prepare", "up", "deploy", "upgrade", "stop"])
    args = parser.parse_args()
    os.umask(0o077)
    if args.action == "prepare":
        prepare()
    elif args.action == "up":
        check_tools()
        prepare()
        generate_identities()
        deploy()
    elif args.action == "deploy":
        deploy()
    elif args.action == "upgrade":
        deploy(upgrade=True)
    else:
        print(compose("stop"))


if __name__ == "__main__":
    main()

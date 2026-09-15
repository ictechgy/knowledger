import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProjectTemplate } from '../../packages/config/template.ts';
import { validateProjectConfiguration, loadProjectConfiguration, applicationDefinition, configurationAuthorityDigest } from '../../packages/config/project.ts';

test('configuration accepts two and four arbitrary organizations and repeated actor names across organizations', () => {
  for (const orgs of [['OrionMSP', 'VegaMSP'], ['ResearchMSP', 'ReviewMSP', 'DeliveryMSP', 'AuditMSP']]) {
    const configured = validateProjectConfiguration(createProjectTemplate(orgs, 'custom-workspace'));
    const definition = applicationDefinition(configured);
    assert.equal(definition.personas.length, orgs.length);
    assert.equal(definition.demo, false);
    assert.deepEqual(definition.personas.map(actor => actor.org_id), orgs);
    assert.equal(new Set(definition.personas.map(actor => actor.actor_id)).size, 1);
    assert.equal(definition.workspace.id, 'custom-workspace');
  }
});

test('configuration rejects mismatched policies, actors, channel, metadata and ambiguous subject bindings', () => {
  const mutations = [
    (config: any) => { config.ledger.channel_id = 'another-channel'; },
    (config: any) => { config.organizations.push(config.organizations[0]); },
    (config: any) => { config.identities[0].org_id = 'UnknownMSP'; },
    (config: any) => { config.bootstrap_actor.actor_id = 'missing-actor'; },
    (config: any) => { config.workspace.contexts = []; },
    (config: any) => { config.genesis.policies[0].membership_epoch = 2; },
    (config: any) => { config.authentication = { mode:'oidc', issuer:'http://untrusted.invalid', client_id:'client', bindings:[] }; },
    (config: any) => { config.authentication = { mode:'local-development', client_secret:'must-not-be-accepted' }; },
    (config: any) => { config.fabric = { chaincode_name:'kcl', chaincode_version:'1', identities:[] }; },
  ];
  for (const mutate of mutations) {
    const config = createProjectTemplate(); mutate(config);
    assert.throws(() => validateProjectConfiguration(config));
  }
  const config: any = createProjectTemplate();
  config.authentication = { mode:'oidc', issuer:'https://issuer.example', client_id:'public-client', bindings:config.identities.map((actor: any) => ({subject:'same-subject',org_id:actor.org_id,actor_id:actor.actor_id})) };
  assert.throws(() => validateProjectConfiguration(config));
});

test('authority digest binds identities and policy but permits display label changes', () => {
  const before = validateProjectConfiguration(createProjectTemplate());
  const after = structuredClone(before); after.workspace.label = 'Renamed workspace'; after.organizations[0].label = 'Renamed organization';
  assert.equal(configurationAuthorityDigest(before), configurationAuthorityDigest(validateProjectConfiguration(after)));
  after.genesis.role_binding_version = 2; after.genesis.policies[0].role_binding_version = 2;
  assert.notEqual(configurationAuthorityDigest(before), configurationAuthorityDigest(validateProjectConfiguration(after)));
});

test('configuration loader rejects duplicate JSON and resolves only declared connection paths', t => {
  const directory = mkdtempSync(join(tmpdir(), 'kcl-config-')); t.after(() => rmSync(directory, {recursive:true, force:true}));
  const path = join(directory, 'project.json');
  writeFileSync(path, '{"version":1,"version":1}');
  assert.throws(() => loadProjectConfiguration(path));
  writeFileSync(path, JSON.stringify(createProjectTemplate()));
  const loaded = loadProjectConfiguration(path);
  assert.equal(loaded.workspace.id, 'knowledge');
  assert.equal(Object.isFrozen(loaded), true);
  assert.equal(Object.isFrozen(loaded.genesis.identities), true);
});

test('Fabric configuration validates OIDC routes and resolves references without reading credentials',t=>{
  const directory=mkdtempSync(join(tmpdir(),'kcl-fabric-config-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const config:any=createProjectTemplate(['OrionMSP','VegaMSP']);
  config.ledger.mode='fabric';
  config.authentication={mode:'oidc',issuer:'https://issuer.example',client_id:'kcl-public-client',bindings:config.identities.map((actor:any,index:number)=>({subject:`subject-${index}`,org_id:actor.org_id,actor_id:actor.actor_id}))};
  config.server={public_origin:'https://knowledge.example'};
  config.fabric={chaincode_name:'kcl',chaincode_version:'0.1.0',identities:config.identities.map((actor:any)=>({org_id:actor.org_id,actor_id:actor.actor_id,certificate_path:'cert.pem',tls_ca_path:'tls-ca.pem',peer_endpoint:'127.0.0.1:7051',peer_host_alias:'peer.organization.example',key_id:'organization-key',signer_socket_path:'signer.sock'}))};
  const path=join(directory,'project.json');writeFileSync(path,JSON.stringify(config));
  const loaded=loadProjectConfiguration(path);
  assert.equal(loaded.fabric!.identities[0].certificate_path,join(directory,'cert.pem'));
  assert.equal(loaded.fabric!.identities[0].signer_socket_path,join(directory,'signer.sock'));
  config.fabric.identities[0].peer_endpoint='user:secret@peer.example:7051';assert.throws(()=>validateProjectConfiguration(config));
});

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createConfiguredApp } from './configured-runtime.ts';
import { loadProjectConfiguration } from '../../packages/config/project.ts';

const args=process.argv.slice(2);
const help='Usage: npm start -- --config FILE [--data DIRECTORY] [--port 4317] [--organization ORG_ID]\nCreate a configuration: npm run config:init\nOrder-workflow example: npm run demo:web';
if(args.includes('--help')) console.log(help);
else if(args.includes('--demo')) {
  if(args.includes('--config')) { console.error('Select either --config or --demo.');process.exitCode=1; }
  else await import('../../examples/order-workflow/main.ts');
} else {
  let app:Awaited<ReturnType<typeof createConfiguredApp>>|undefined;
  try {
    const values=new Map<string,string>();
    for(let index=0;index<args.length;index+=2){
      const key=args[index],value=args[index+1];
      if(!['--config','--data','--port','--organization'].includes(key)||values.has(key)||!value||value.startsWith('--')) throw new Error('Invalid command line');
      values.set(key,value);
    }
    const configPath=resolve(values.get('--config')??'knowledger.config.json');
    if(!existsSync(configPath)) throw new Error('Configuration missing');
    const configuration=loadProjectConfiguration(configPath);
    const port=Number(values.get('--port')??4317);
    if(!Number.isInteger(port)||port<1||port>65535) throw new Error('Invalid port');
    const organization=values.get('--organization');
    const dataDir=resolve(values.get('--data')??`.data/workspaces/${configuration.workspace.id}/${organization??'local'}`);
    app=await createConfiguredApp(configuration,{dataDir,port,organization});
    const origin=await app.listen(port);
    console.log(`Knowledger: ${origin}`);
    console.log(configuration.ledger.mode==='fabric'?'Configured Fabric · authenticated organization · verified peer blocks':'Configured local simulation · development account switching · empty initial workspace');
    let stopping=false;
    for(const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,async()=>{if(stopping)return;stopping=true;await app?.close();});
  } catch {
    await app?.close();
    console.error(`Knowledger could not start. Check the configuration, selected organization, data binding, and connection.\n${help}`);
    process.exitCode=1;
  }
}

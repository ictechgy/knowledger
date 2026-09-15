import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { createProjectTemplate } from '../packages/config/template.ts';
import { validateProjectConfiguration } from '../packages/config/project.ts';

try {
  const args=process.argv.slice(2);const organizations:string[]=[];
  let output='kcl.config.json';let workspace='knowledge';const seen=new Set<string>();
  for(let index=0;index<args.length;index+=2){
    const key=args[index],value=args[index+1];
    if(!['--output','--workspace','--organization'].includes(key)||!value||value.startsWith('--')||(key!=='--organization'&&seen.has(key))) throw new Error('Invalid arguments');
    seen.add(key);
    if(key==='--output')output=value;else if(key==='--workspace')workspace=value;else organizations.push(value);
  }
  const config=validateProjectConfiguration(createProjectTemplate(organizations.length?organizations:undefined,workspace));
  writeFileSync(resolve(output),JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log('Created project configuration. Review the organization labels, identities and approval policy, then run npm start.');
} catch {
  console.error('Cannot create configuration. The output must not exist. Usage: npm run config:init -- [--output FILE] [--workspace ID] [--organization ORG_ID ...]');process.exitCode=1;
}

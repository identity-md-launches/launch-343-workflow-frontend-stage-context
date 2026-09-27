import { createServer } from 'vite';
import { writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const root=resolve(import.meta.dirname,'..');
const server=await createServer({root,configFile:resolve(root,'vite.config.ts'),optimizeDeps:{noDiscovery:true,include:[]},server:{host:'127.0.0.1',port:0}});
try {
  await server.listen();
  const base=server.resolvedUrls.local[0];
  const response=await fetch(base+'imd-deployment.json');
  const manifest=await response.json();
  assert.deepEqual(manifest,JSON.parse(await readFile(resolve(root,'../dist/imd-deployment.json'))));
  for(const c of manifest.contracts){
    const r=await fetch(base+c.abiPath);assert.equal(r.status,200);
    assert.deepEqual(await r.json(),JSON.parse(await readFile(resolve(root,'../dist',c.abiPath))));
  }
  const result={result:'PASS',mode:'Foreground Vite dev middleware probe; dependency discovery disabled for this focused test',manifest:'exact production manifest',abis:manifest.contracts.length};
  await writeFile(resolve(root,'../docs/evidence/dev-server.json'),JSON.stringify(result,null,2)+'\n');console.log(result);
} finally {await server.close();}

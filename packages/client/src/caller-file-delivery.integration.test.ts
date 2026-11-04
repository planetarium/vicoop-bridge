import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CallerFileDeliveryConfig, createCallerFileDelivery } from './caller-file-delivery.js';
import { runDockerCommand } from './docker-command.js';
import type { UpFrame } from '@vicoop-bridge/protocol';

const image = process.env.VICOOP_FILE_TEST_IMAGE;
test('real Docker trusted reader confines paths and task budgets to each caller', {skip: !image, timeout:60000}, async () => {
  const names = [0,1].map(()=>`vicoop-file-test-${randomUUID()}`);
  const docker = async (args: string[]) => {
    const result=await runDockerCommand(args);assert.equal(result.exitCode,0,result.stderr);return result.stdout;
  };
  try {
    for (let i=0;i<names.length;i++) {
      await docker(['run','--detach','--name',names[i],'--network','none','--user','1000:1000','--entrypoint','/bin/sleep',image!,'infinity']);
      await docker(['exec',names[i],'/usr/local/bin/node','-e',`
        const fs=require('fs');fs.mkdirSync('/workspace/output');
        fs.writeFileSync('/workspace/private','secret');
        fs.writeFileSync('/workspace/output/한글.png',Buffer.from([137,80,78,71,${i}]));
        fs.writeFileSync('/workspace/output/audio.wav',Buffer.from([82,73,70,70,${i}]));
        fs.writeFileSync('/workspace/output/large',Buffer.alloc(2048));
        fs.symlinkSync('/workspace/private','/workspace/output/symlink');
        fs.symlinkSync('/workspace','/workspace/output/directory');
        fs.linkSync('/workspace/private','/workspace/output/hardlink');
      `]);
    }
    const config=CallerFileDeliveryConfig.parse({allowedRoots:['/workspace/output'],maxBytes:1024,maxTotalBytes:10,maxFiles:2});
    const signal=new AbortController().signal,frames:UpFrame[]=[];
    await Promise.all(names.map(async (name,i)=>{
      const delivery=createCallerFileDelivery(name,`task-${i}`,f=>frames.push(f),signal,config);
      for(const path of ['/workspace/private','/workspace/output/symlink','/workspace/output/directory/private','/workspace/output/hardlink','/workspace/output/large'])
        await assert.rejects(delivery.send({path},signal),path);
      await delivery.send({path:'/workspace/output/한글.png'},signal);
      await delivery.send({path:'/workspace/output/audio.wav'},signal);
      await assert.rejects(delivery.send({path:'/workspace/output/audio.wav'},signal),/count/);
      const next=createCallerFileDelivery(name,`next-${i}`,f=>frames.push(f),signal,config);
      await next.send({path:'/workspace/output/한글.png'},signal);
      const aggregate=createCallerFileDelivery(name,`agg-${i}`,f=>frames.push(f),signal,{...config,maxTotalBytes:6});
      await aggregate.send({path:'/workspace/output/한글.png'},signal);
      await assert.rejects(aggregate.send({path:'/workspace/output/audio.wav'},signal),/too-large/);
    }));
    for(const f of frames){
      if(f.type!=='task.artifact')throw Error('unexpected frame');
      const part=f.artifact.parts[0];if(part.kind!=='file')throw Error('unexpected part');
      const bytes=Buffer.from(part.file.bytes!,'base64');
      assert.equal(bytes.at(-1),Number(f.taskId.split('-').at(-1)));
    }
    assert.equal(frames.length,8);
  } finally { for(const name of names) await runDockerCommand(['rm','--force',name]); }
});

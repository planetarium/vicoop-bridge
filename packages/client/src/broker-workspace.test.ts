import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, symlinkSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {assertBrokerWorkspace} from './execution-runtime-boundary.js';

test('workspace rejects credential ancestors, descendants and symlink aliases while permitting separate projects', () => {
  const root=mkdtempSync(join(tmpdir(),'broker-workspace-'));
  try {
    const home=join(root,'home'), custom=join(root,'custom-auth');
    mkdirSync(join(home,'.codex'),{recursive:true});mkdirSync(custom);
    const env={CODEX_HOME:custom};
    for(const path of [root,home,join(home,'.codex'),join(home,'.codex','missing'),custom]) {
      assert.throws(()=>assertBrokerWorkspace(path,env,home),/overlaps/);
    }
    if(process.platform!=='win32') {
      symlinkSync(home,join(root,'alias'));
      assert.throws(()=>assertBrokerWorkspace(join(root,'alias'),env,home),/overlaps/);
    }
    assert.doesNotThrow(()=>assertBrokerWorkspace(join(home,'project'),env,home));
    assert.doesNotThrow(()=>assertBrokerWorkspace(join(root,'custom-auth-other'),env,home));
  } finally {rmSync(root,{recursive:true,force:true});}
});

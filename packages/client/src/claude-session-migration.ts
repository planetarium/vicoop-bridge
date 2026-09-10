// Trusted one-shot maintenance code, run in a networkless helper, never in the
// workload. Only conversations and todos cross from the detached legacy volume.
// No settings, login JSON, caches, environment snapshots or symlinks are copied.
export const CLAUDE_SESSION_MIGRATION = String.raw`
const fs = require('node:fs'), path = require('node:path');
const source = process.argv[1] || '/legacy';
const target = process.argv[2] || '/sessions/config';
let copied = 0;
function directory(p) {
  if (fs.existsSync(p)) {
    const s = fs.lstatSync(p);
    if (!s.isDirectory() || s.isSymbolicLink()) throw Error('Unsafe migration destination');
  } else fs.mkdirSync(p, {recursive:false,mode:0o700});
}
function copy(src, dst, extension) {
  const st = fs.lstatSync(src);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    directory(dst);
    for (const name of fs.readdirSync(src)) copy(path.join(src,name),path.join(dst,name),extension);
  } else if (st.isFile() && src.endsWith(extension)) {
    // Exclusive create prevents overwriting current state or following links.
    try { fs.copyFileSync(src,dst,fs.constants.COPYFILE_EXCL); copied++; }
    catch(e) { if(e.code !== 'EEXIST') throw e; }
  }
}
directory(target);
for (const [name,extension] of [['projects','.jsonl'],['todos','.json']]) {
  const src = path.join(source,name);
  if (fs.existsSync(src)) copy(src,path.join(target,name),extension);
}
console.log(JSON.stringify({copied}));
`;

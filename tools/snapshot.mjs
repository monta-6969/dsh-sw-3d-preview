// tools/snapshot.mjs —— 版本化前的落盘体检：把 client.js / index.js 的字节数、mtime、sha256 追加进 snapshots.jsonl。
// 用法：node tools/snapshot.mjs   （每次跑追加一行，最后在命令行打印一条摘要）
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const targets = ['client.js', 'index.js'];
const files = targets.map((name) => {
  const full = path.join(root, name);
  const bytes = readFileSync(full);
  const st = statSync(full);
  return { name, bytes: bytes.length, mtime: st.mtime.toISOString(), sha256: createHash('sha256').update(bytes).digest('hex') };
});
const record = { at: new Date().toISOString(), files };
appendFileSync(path.join(root, 'snapshots.jsonl'), JSON.stringify(record) + '\n', 'utf8');
console.log(`[snapshot] ${record.at} ` + files.map((f) => `${f.name}=${f.bytes}B sha256=${f.sha256.slice(0, 12)} mtime=${f.mtime}`).join(' · '));

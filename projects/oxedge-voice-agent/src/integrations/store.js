import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Every finished call is appended to data/leads.jsonl, so nothing is lost even with no CRM connected. */
export function createStore(config) {
  const file = join(config.dataDir, 'leads.jsonl');
  return {
    file,
    async append(record) {
      await mkdir(config.dataDir, { recursive: true });
      await appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
    },
    async recent(limit = 50) {
      let text = '';
      try {
        text = await readFile(file, 'utf8');
      } catch (err) {
        if (err.code === 'ENOENT') return [];
        throw err;
      }
      return text.trim().split('\n').filter(Boolean).slice(-limit).map((line) => JSON.parse(line)).reverse();
    },
  };
}

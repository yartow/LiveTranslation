// Stand-in for server/python/mlx_worker.py in tests/unit/mlx-whisper.test.ts: same
// JSON-lines protocol, one request at a time. The request `path` scripts the behaviour:
//   delay:<ms>:<label>  answer after <ms>
//   flaky:<ms>:<label>  the FIRST request with this exact path takes <ms>, later ones are instant
import { createInterface } from 'node:readline';

const seen = new Set();
let chain = Promise.resolve();
console.log(JSON.stringify({ type: 'ready' }));
createInterface({ input: process.stdin }).on('line', (line) => {
  chain = chain.then(async () => {
    const req = JSON.parse(line);
    const [kind, ms] = String(req.path).split(':');
    let delay = Number(ms) || 0;
    if (kind === 'flaky') {
      if (seen.has(req.path)) delay = 5;
      seen.add(req.path);
    }
    await new Promise((r) => setTimeout(r, delay));
    console.log(JSON.stringify({ id: req.id, text: `ok:${req.path}` }));
  });
});

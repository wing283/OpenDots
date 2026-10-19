import { createServer } from 'node:http';
import { realpath, stat } from 'node:fs/promises';
import { readEvidenceDetails, readEvidenceIndex, type EvidenceSource } from './stage-evidence.js';

const host = '127.0.0.1';
const firstRoot = await realpath(process.argv[2] ?? '');
const secondArgument = process.argv[3];
const hasSecondRoot = Boolean(secondArgument && !/^\d+$/.test(secondArgument));
const rawPort = hasSecondRoot ? process.argv[4] : secondArgument;
const roots = [firstRoot, ...(hasSecondRoot ? [await realpath(secondArgument!)] : [])];
const sources: EvidenceSource[] = roots.map((path, index) => ({
  id: index === 0 ? 'run07' : 'sol',
  name: index === 0 ? 'run07-final-rss-review · local stage logs' : 'supervisor-parallel-repair-20261019 · SOL evidence',
  path,
  kind: index === 0 ? 'saved-stage-logs' : 'sol-capacity',
}));
for (const source of sources) {
  if (!(await stat(source.path)).isDirectory()) throw new Error('Evidence root must be a directory.');
}
const port = Number(rawPort ?? 58370);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error('Invalid port.');

const page = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Supervisor 保存済み証跡</title>
<style>
body{font:14px system-ui,sans-serif;margin:0;background:#101820;color:#e8eef2}main{max-width:1200px;margin:auto;padding:24px}header,.metrics{display:flex;gap:16px;align-items:center;flex-wrap:wrap}h1{font-size:22px;margin:0}header p{color:#a9bac6}button,select{font:inherit;padding:7px;background:#1d2b36;color:inherit;border:1px solid #536979;border-radius:4px}section{margin-top:20px;padding:16px;background:#17232c;border:1px solid #344550;border-radius:8px}.metrics{justify-content:space-between}.metrics b{display:block;margin-top:4px}table{width:100%;border-collapse:collapse;margin-top:12px}th,td{text-align:left;padding:8px;border-bottom:1px solid #344550;vertical-align:top}code{overflow-wrap:anywhere}.warning{color:#f3ca79}#logs{max-height:360px;overflow:auto;white-space:pre-wrap;font:12px ui-monospace,monospace}.status{color:#a9bac6}
</style><main><header><div><h1>Supervisor — 保存済み証跡</h1><p>ローカル保存記録の表示専用。APIはGETのみです。</p></div><label>Run / Stage <select id="run" aria-label="保存済みrun"></select></label><button id="refresh">更新</button></header><p id="status" class="status" role="status">読み込み中…</p><section id="summary" class="metrics"></section><section><h2>出典と採取時刻</h2><pre id="provenance"></pre></section><section><h2>Task</h2><div id="tasks"></div></section><section><h2>追記ログ・警告</h2><pre id="logs"></pre><div id="warnings" class="warning"></div></section></main>
<script>
const el=id=>document.getElementById(id), run=el('run'); let index;
async function get(path){const r=await fetch(path,{cache:'no-store'});if(!r.ok)throw Error('HTTP '+r.status);return r.json()}
function add(parent,tag,text){const n=document.createElement(tag);n.textContent=text??'—';parent.append(n);return n}
function metric(label,value){const n=document.createElement('span');add(n,'small',label);add(n,'b',value);el('summary').append(n)}
async function detail(){if(!run.value)return;const d=await get('/api/evidence/runs/'+encodeURIComponent(run.value));el('summary').replaceChildren();
el('provenance').textContent=['Source: '+d.sourceName,'Evidence root: '+d.sourcePath,'Stage path: '+d.evidencePath,'Run ID: '+(d.runId||'source record does not declare one'),'Stage ID: '+d.stageId,'Collected at: '+(d.collectedAt||'timestamp unavailable')].join('\\n');
const table=document.createElement('table'),head=table.insertRow();
if(d.kind==='sol-capacity'){metric('状態',d.status);metric('成功 / 失敗',d.succeededCount+' / '+d.failedCount);metric('Task数',d.taskCount);metric('設定slot数',d.configuredSlots);metric('同時job観測',d.maxSimultaneousActiveJobsVerified?d.maxSimultaneousActiveJobs:'未検証');metric('slot証跡',d.slotEventsComplete?'complete':'incomplete');metric('stage_passed',d.stagePassed?'true':'false');for(const title of ['Task UUID','状態','終了code','停止理由','観測同時job数','slot取得/解放'])add(head,'th',title);for(const t of d.tasks){const row=table.insertRow();for(const v of [t.taskId,t.status,t.runnerExitCode,t.stopReason,t.maxObservedConcurrentJobs,(t.slotAcquired??'—')+'/'+(t.slotReleased??'—')])add(row,'td',v)}}
else{metric('状態',d.allTasksTerminal?'全task終了':'進行中');metric('進捗',d.progress.terminalTasks+'/'+d.taskCount+' tasks · '+d.progress.completedBatches+' batches');metric('成功 / 失敗',d.progress.successfulBatches+' / '+d.progress.failedBatches);metric('同時job数',d.concurrency.status==='measured'?d.concurrency.value:'不明');const m=d.hostMemory, gib=v=>v===null?'不明':(v/1073741824).toFixed(2);metric('RAM 使用 / 空き · sample '+(m?.at||'時刻不明')+' · ファイル '+(m?.receivedAt||'時刻不明')+(m?.stale?' · STALE':''),m?gib(m.usedBytes)+' / '+gib(m.availableBytes)+' GiB':'不明');metric('証拠更新',d.collectedAt||d.updatedAt||'時刻不明');for(const title of ['Task','状態','Batch','成功/失敗','終了code','停止理由','最終更新'])add(head,'th',title);for(const t of d.tasks){const row=table.insertRow();for(const v of [t.taskId,t.status+(t.stale?' · STALE':''),t.completedBatches+(t.batchLimit===null?'':'/'+t.batchLimit),t.successfulBatches+'/'+t.failedBatches,t.runnerExitCode,t.stopReason,t.updatedAt])add(row,'td',v)}}
el('tasks').replaceChildren(table);el('logs').textContent=(d.logs??[]).map(x=>(x.at||'時刻不明')+' ['+x.source+'] '+x.message).join('\\n');el('warnings').textContent=(d.warnings??[]).join('\\n')+(d.concurrency?.reason?'\\n同時job数: '+d.concurrency.reason:'');el('status').textContent=d.sourceName+' · '+d.stageId+' · 採取 '+(d.collectedAt||'時刻不明')+' · API観測 '+d.observedAt+(d.stale?' · STALE':'')}
async function refresh(){try{index=await get('/api/evidence/runs');const current=run.value;run.replaceChildren();for(const [i,s] of index.stages.entries()){const o=document.createElement('option');o.value=s.key;o.textContent=(i===0?'最新 · ':'')+s.sourceName+' · '+s.stageId+' · '+(s.collectedAt||'時刻不明')+' · '+s.succeededCount+'/'+s.taskCount+' pass';run.append(o)}if(index.stages.some(s=>s.key===current))run.value=current;else if(index.stages[0])run.value=index.stages[0].key;await detail();if(!index.stages.length)el('status').textContent='保存済みrunがありません · API観測 '+index.observedAt}catch(e){el('status').textContent='証跡の読取りに失敗: '+e.message}}
run.addEventListener('change',()=>void detail().catch(e=>el('status').textContent='証拠の読取りに失敗: '+e.message));el('refresh').addEventListener('click',()=>void refresh());void refresh();setInterval(()=>void refresh(),5000);
</script>`;

const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  if (req.method !== 'GET') {
    res
      .writeHead(405, {
        Allow: 'GET',
        'Content-Type': 'text/plain; charset=utf-8',
      })
      .end('GET only');
    return;
  }
  const path = new URL(req.url ?? '/', `http://${host}:${port}`).pathname;
  try {
    if (path === '/') {
      res
        .writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(page);
      return;
    }
    if (path === '/api/evidence/runs') {
      res
        .writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      .end(JSON.stringify(await readEvidenceIndex(sources)));
      return;
    }
    if (path.startsWith('/api/evidence/runs/')) {
      let key: string;
      try {
        key = decodeURIComponent(path.slice('/api/evidence/runs/'.length));
      } catch {
        res.writeHead(400).end();
        return;
      }
      const detail = await readEvidenceDetails(sources, key);
      res
        .writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        .end(JSON.stringify(detail));
      return;
    }
    res.writeHead(404).end();
  } catch (error) {
    const invalid = error instanceof Error && /^Invalid (?:evidence|SOL evidence)/.test(error.message);
    res
      .writeHead(invalid ? 400 : 503, {
        'Content-Type': 'application/json; charset=utf-8',
      })
      .end(
        JSON.stringify({
          error: invalid
            ? 'Invalid evidence stage.'
            : 'Saved evidence is unavailable.',
        }),
      );
  }
});
server.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
server.listen(port, host, () =>
  console.log(
    JSON.stringify({
      url: `http://${host}:${port}/`,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      evidenceRoots: sources.map((source) => ({ id: source.id, name: source.name, path: source.path })),
      readOnly: true,
    }),
  ),
);

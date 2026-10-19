import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  readEvidenceDetails,
  readEvidenceIndex,
  readStageDetails,
  readStageIndex,
} from '../scripts/model-activity-preview/stage-evidence';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);

it('discovers saved stages, ignores a partial JSONL row, marks concurrency unknown, and caps logs at 200', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stage-evidence-'));
  roots.push(root);
  const stage = join(root, 'capacity-stage24-20261019');
  const task = join(stage, 'task-a');
  const diagnostics = join(task, 'diagnostics', 'batch-a');
  await mkdir(diagnostics, { recursive: true });
  await writeFile(
    join(task, 'soak-start.json'),
    JSON.stringify({ run_id: 'run-a', started_utc: '2026-10-19T10:00:00Z' }),
  );
  await writeFile(
    join(task, 'progress.json'),
    JSON.stringify({
      run_id: 'run-a',
      updated_utc: '2026-10-19T10:00:03Z',
      completed_batches: 1,
      batch_limit: 2,
    }),
  );
  await writeFile(
    join(task, 'resource-samples.jsonl'),
    `${JSON.stringify({ utc: '2026-10-19T10:00:02Z', system_used_bytes: 30, system_available_bytes: 70 })}\n{"partial":`,
  );
  await Promise.all(
    Array.from({ length: 205 }, (_, index) =>
      writeFile(
        join(diagnostics, `${String(index).padStart(4, '0')}.json`),
        JSON.stringify({
          event: 'worker_slot_acquired',
          job_id: `job-${index}`,
          wall_time_ns: index + 1,
        }),
      ),
    ),
  );

  const index = await readStageIndex(root);
  const detail = await readStageDetails(root, 'capacity-stage24-20261019');
  expect(index.stages[0].stage).toBe('capacity-stage24-20261019');
  expect(detail.concurrency).toMatchObject({ status: 'unknown', value: null });
  expect(detail.hostMemory).toMatchObject({
    usedBytes: 30,
    availableBytes: 70,
  });
  expect(detail.hostMemory?.at).toBe('2026-10-19T10:00:02.000Z');
  expect(detail.hostMemory?.receivedAt).toBeTruthy();
  expect(detail.hostMemory?.stale).toBe(true);
  expect(detail.staleAfterMs).toBe(10_000);
  expect(detail.tasks[0].status).toBe('RUNNING');
  expect(detail.logs).toHaveLength(200);
  expect(detail.warnings).toContain(
    'task-a: resource-samples.jsonl: incomplete JSONL line omitted',
  );
  await expect(readStageDetails(root, '../outside')).rejects.toThrow(
    'Invalid evidence stage.',
  );
});

it('keeps local and SOL evidence roots separate and exposes SOL provenance and per-task outcomes', async () => {
  const localRoot = await mkdtemp(join(tmpdir(), 'stage-evidence-local-'));
  const solRoot = await mkdtemp(join(tmpdir(), 'stage-evidence-sol-'));
  roots.push(localRoot, solRoot);
  const localStage = join(localRoot, 'capacity-stage24-20261019');
  const localTask = join(localStage, 'task-a');
  const solStageName = 'capacity-sol-120-018c6283-07bb-4c97-8787-10a3071ec02f';
  const solStage = join(solRoot, solStageName);
  await mkdir(localTask, { recursive: true });
  await mkdir(solStage, { recursive: true });
  await writeFile(
    join(localTask, 'progress.json'),
    JSON.stringify({
      run_id: 'local-run',
      updated_utc: '2026-10-19T10:00:00Z',
    }),
  );
  await writeFile(
    join(solStage, 'stage-start.json'),
    JSON.stringify({
      stage_id: '018c6283-07bb-4c97-8787-10a3071ec02f',
      runner_count: 2,
    }),
  );
  await writeFile(
    join(solStage, 'stage-results.json'),
    JSON.stringify({
      stage_id: '018c6283-07bb-4c97-8787-10a3071ec02f',
      task_count: 2,
      runner_success_count: 1,
      configured_slots: 120,
      stage_passed: false,
      slot_events_complete: false,
      tasks: [
        { task_uuid: 'task-pass', runner_exit_code: 0, stop_reason: 'done' },
        {
          task_uuid: 'task-fail',
          runner_exit_code: 2,
          stop_reason: 'runner_failed',
        },
      ],
    }),
  );

  const sources = [
    {
      id: 'local',
      name: 'local stage logs',
      path: localRoot,
      kind: 'saved-stage-logs' as const,
    },
    {
      id: 'sol',
      name: 'SOL evidence',
      path: solRoot,
      kind: 'sol-capacity' as const,
    },
  ];
  const index = await readEvidenceIndex(sources);
  expect(index.stages).toHaveLength(2);
  expect(new Set(index.stages.map((stage) => stage.key)).size).toBe(2);
  expect(index.stages.map((stage) => stage.sourceName).sort()).toEqual([
    'SOL evidence',
    'local stage logs',
  ]);

  const detail = await readEvidenceDetails(sources, `sol:${solStageName}`);
  expect(detail).toMatchObject({
    sourceName: 'SOL evidence',
    sourcePath: solRoot,
    evidencePath: solStage,
    stageId: solStageName,
    runId: null,
    taskCount: 2,
    succeededCount: 1,
    failedCount: 1,
    configuredSlots: 120,
    stagePassed: false,
  });
  expect(detail.tasks.map((task) => task.status)).toEqual(['PASS', 'FAIL']);
  await expect(readEvidenceDetails(sources, 'sol:../outside')).rejects.toThrow(
    'Invalid evidence run.',
  );
});

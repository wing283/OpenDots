import { spawnSync } from 'node:child_process';
import {
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  stat,
} from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

type Row = Record<string, unknown>;
export type EvidenceSource = {
  id: string;
  name: string;
  path: string;
  kind: 'saved-stage-logs' | 'sol-capacity';
};
const stagePattern = /^capacity-stage\d+-\d{8}$/;
const solStagePattern = /^capacity-sol-\d+-[0-9a-f-]{36}$/i;
const maxLogEvents = 200;
const staleAfterMs = 10_000;

function row(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Row)
    : {};
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function time(value: unknown): string | null {
  const candidate = text(value);
  return candidate && Number.isFinite(Date.parse(candidate))
    ? new Date(candidate).toISOString()
    : null;
}

async function jsonFile(path: string, warnings: string[]): Promise<Row | null> {
  try {
    if (!(await lstat(path)).isFile()) throw new Error('Not a regular file.');
    return row(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      warnings.push(`${path.split(sep).at(-1)}: unreadable or incomplete JSON`);
    return null;
  }
}

async function tail(
  path: string,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!(await lstat(path)).isFile()) throw new Error('Not a regular file.');
  const file = await open(path, 'r');
  try {
    const size = (await file.stat()).size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    await file.read(buffer, 0, buffer.length, start);
    let content = buffer.toString('utf8');
    if (start > 0)
      content = content.slice(Math.max(0, content.indexOf('\n') + 1));
    return { text: content, truncated: start > 0 };
  } finally {
    await file.close();
  }
}

async function jsonl(path: string, warnings: string[]): Promise<Row[]> {
  try {
    const result = await tail(path, 256 * 1024);
    if (result.truncated)
      warnings.push(`${path.split(sep).at(-1)}: older lines omitted`);
    const rows: Row[] = [];
    for (const line of result.text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        rows.push(row(JSON.parse(line)));
      } catch {
        warnings.push(
          `${path.split(sep).at(-1)}: incomplete JSONL line omitted`,
        );
      }
    }
    return rows;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      warnings.push(`${path.split(sep).at(-1)}: unreadable`);
    return [];
  }
}

async function taskRecord(path: string, now: number) {
  const warnings: string[] = [];
  const [start, progress, result, failure, runnerExit, samples] =
    await Promise.all([
      jsonFile(join(path, 'soak-start.json'), warnings),
      jsonFile(join(path, 'progress.json'), warnings),
      jsonFile(join(path, 'soak-results.json'), warnings),
      jsonFile(join(path, 'failure.json'), warnings),
      jsonFile(join(path, 'runner-exit.json'), warnings),
      jsonl(join(path, 'resource-samples.jsonl'), warnings),
    ]);
  const exitCode = number(result?.runner_exit_code ?? runnerExit?.exit_code);
  const diagnosticStatus = text(result?.diagnostic_status);
  const terminal =
    exitCode !== null ||
    ['PASS', 'FAIL'].includes(diagnosticStatus ?? '') ||
    !!failure;
  const status =
    diagnosticStatus ??
    (failure
      ? 'FAIL'
      : exitCode !== null
        ? exitCode === 0
          ? 'EXITED'
          : 'FAIL'
        : progress
          ? 'RUNNING'
          : 'STARTING');
  const startTime = time(
    start?.started_utc ?? progress?.started_utc ?? result?.started_utc,
  );
  const sample = samples
    .map((item) => ({ item, at: time(item.utc ?? item.observed_utc) }))
    .filter((item): item is { item: Row; at: string } => item.at !== null)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  let sampleReceivedAt: string | null = null;
  if (sample) {
    try {
      sampleReceivedAt = new Date(
        (await stat(join(path, 'resource-samples.jsonl'))).mtimeMs,
      ).toISOString();
    } catch {
      /* sample file may disappear during scan */
    }
  }
  const updatedAt =
    [
      time(progress?.updated_utc),
      time(result?.ended_utc),
      time(runnerExit?.ended_utc),
      sample?.at ?? null,
    ]
      .filter((item): item is string => item !== null)
      .sort()
      .at(-1) ?? startTime;
  let mtime: string | null = null;
  try {
    mtime = new Date((await stat(path)).mtimeMs).toISOString();
  } catch {
    /* task may disappear during scan */
  }
  const lastUpdatedAt = updatedAt ?? mtime;
  const stale =
    !terminal &&
    lastUpdatedAt !== null &&
    now - Date.parse(lastUpdatedAt) > staleAfterMs;
  return {
    taskId: path.split(sep).at(-1) ?? path,
    runId: text(result?.run_id ?? progress?.run_id ?? start?.run_id),
    status,
    terminal,
    stale,
    startedAt: startTime,
    updatedAt: lastUpdatedAt,
    runnerExitCode: exitCode,
    stopReason: text(
      result?.stop_reason ?? progress?.stop_reason ?? failure?.stop_reason,
    ),
    completedBatches:
      number(progress?.completed_batches ?? result?.completed_batches) ?? 0,
    batchLimit: number(progress?.batch_limit ?? result?.max_batches),
    successfulBatches:
      number(progress?.successful_batches ?? result?.successful_batches) ?? 0,
    failedBatches:
      number(progress?.failed_batches ?? result?.failed_batches) ?? 0,
    maxObservedConcurrentJobs: number(result?.max_observed_concurrent_jobs),
    concurrencyMeasurementComplete:
      result?.job_concurrency_measurement_complete === true,
    memory: sample
      ? {
          at: sample.at,
          receivedAt: sampleReceivedAt,
          stale: now - Date.parse(sample.at) > staleAfterMs,
          usedBytes: number(sample.item.system_used_bytes),
          availableBytes: number(sample.item.system_available_bytes),
        }
      : null,
    samples,
    warnings,
  };
}

export async function readStageIndex(evidenceRoot: string) {
  const root = resolve(evidenceRoot);
  const entries = await readdir(root, { withFileTypes: true });
  const stages = [];
  for (const entry of entries.filter(
    (item) => item.isDirectory() && stagePattern.test(item.name),
  )) {
    const stagePath = join(root, entry.name);
    const children = await readdir(stagePath, { withFileTypes: true }).catch(
      () => [],
    );
    const tasks = await Promise.all(
      children
        .filter((item) => item.isDirectory())
        .map((item) => taskRecord(join(stagePath, item.name), Date.now())),
    );
    const starts = tasks
      .map((item) => item.startedAt)
      .filter((item): item is string => item !== null)
      .sort();
    const updates = tasks
      .map((item) => item.updatedAt)
      .filter((item): item is string => item !== null)
      .sort();
    stages.push({
      stage: entry.name,
      startedAt: starts[0] ?? null,
      updatedAt: updates.at(-1) ?? null,
      taskCount: tasks.length,
      terminalCount: tasks.filter((item) => item.terminal).length,
      succeededCount: tasks.filter((item) => item.status === 'PASS').length,
      failedCount: tasks.filter(
        (item) => item.status === 'FAIL' || item.status === 'FAILED',
      ).length,
    });
  }
  return {
    source: 'saved-local-stage-logs',
    observedAt: new Date().toISOString(),
    stages: stages.sort((a, b) =>
      (b.startedAt ?? '').localeCompare(a.startedAt ?? ''),
    ),
  };
}

async function stageLogs(stagePath: string, taskPaths: string[]) {
  const events: Array<{
    at: string | null;
    source: string;
    message: string;
    mono?: number;
  }> = [];
  for (const taskPath of taskPaths) {
    const taskId = taskPath.split(sep).at(-1) ?? '';
    const diagnostics = join(taskPath, 'diagnostics');
    const batches = await readdir(diagnostics, { withFileTypes: true }).catch(
      () => [],
    );
    const files: string[] = [];
    for (const batch of batches.filter((item) => item.isDirectory())) {
      const entries = await readdir(join(diagnostics, batch.name), {
        withFileTypes: true,
      }).catch(() => []);
      files.push(
        ...entries
          .filter((item) => item.isFile() && item.name.endsWith('.json'))
          .map((item) => join(diagnostics, batch.name, item.name)),
      );
    }
    for (const file of files.sort().slice(-maxLogEvents)) {
      try {
        const data = row(JSON.parse(await readFile(file, 'utf8')));
        const wall = number(data.wall_time_ns);
        events.push({
          at:
            time(data.observed_utc ?? data.utc) ??
            (wall ? new Date(wall / 1_000_000).toISOString() : null),
          source: taskId,
          mono: number(data.monotonic_ns) ?? undefined,
          message: [
            text(data.event) ?? 'event',
            text(data.job_id),
            text(data.stage),
            number(data.exit_code) === null ? null : `exit=${data.exit_code}`,
          ]
            .filter(Boolean)
            .join(' · '),
        });
      } catch {
        events.push({
          at: null,
          source: taskId,
          message: 'diagnostic JSON incomplete/unreadable',
        });
      }
    }
    for (const name of [
      'identity-observations.jsonl',
      'rss-measurement-events.jsonl',
    ]) {
      const warnings: string[] = [];
      for (const item of await jsonl(join(taskPath, name), warnings)) {
        const detail = row(item.detail);
        events.push({
          at: time(item.observed_utc ?? item.utc),
          source: taskId,
          message: [
            text(item.event_name ?? item.event ?? item.stage ?? item.outcome) ??
              name,
            text(item.job_id ?? detail.job_id),
            text(item.outcome ?? detail.outcome),
          ]
            .filter(Boolean)
            .join(' · '),
        });
      }
      for (const warning of warnings)
        events.push({ at: null, source: taskId, message: warning });
    }
    const logs = await readdir(join(taskPath, 'logs'), {
      withFileTypes: true,
    }).catch(() => []);
    for (const log of logs.filter((item) => item.isFile())) {
      try {
        const { text: content, truncated } = await tail(
          join(taskPath, 'logs', log.name),
          64 * 1024,
        );
        const modified = new Date(
          (await stat(join(taskPath, 'logs', log.name))).mtimeMs,
        ).toISOString();
        for (const line of content
          .split(/\r?\n/)
          .filter(Boolean)
          .slice(-maxLogEvents))
          events.push({
            at: modified,
            source: taskId,
            message: `${log.name}: ${line.slice(0, 500)}`,
          });
        if (truncated)
          events.push({
            at: modified,
            source: taskId,
            message: `${log.name}: older log lines omitted`,
          });
      } catch {
        events.push({
          at: null,
          source: taskId,
          message: `${log.name}: unreadable`,
        });
      }
    }
  }
  return events
    .sort(
      (a, b) =>
        Date.parse(a.at ?? '') - Date.parse(b.at ?? '') ||
        (a.mono ?? 0) - (b.mono ?? 0),
    )
    .slice(-maxLogEvents);
}

export async function readStageDetails(
  evidenceRoot: string,
  stage: string,
  aggregatorPath?: string,
) {
  if (!stagePattern.test(stage)) throw new Error('Invalid evidence stage.');
  const root = await realpath(resolve(evidenceRoot));
  const stagePath = await realpath(resolve(root, stage));
  if (!stagePath.startsWith(`${root}${sep}`))
    throw new Error('Invalid evidence stage.');
  const children = await readdir(stagePath, { withFileTypes: true });
  const taskPaths = children
    .filter((item) => item.isDirectory())
    .map((item) => join(stagePath, item.name));
  const tasks = await Promise.all(
    taskPaths.map((path) => taskRecord(path, Date.now())),
  );
  const warnings = tasks.flatMap((task) =>
    task.warnings.map((message) => `${task.taskId}: ${message}`),
  );
  const latestSamples = tasks
    .flatMap((task) =>
      task.samples.map((sample) => ({
        at: time(sample.utc ?? sample.observed_utc),
        receivedAt:
          task.memory?.at === time(sample.utc ?? sample.observed_utc)
            ? task.memory.receivedAt
            : null,
        stale:
          task.memory?.at === time(sample.utc ?? sample.observed_utc)
            ? task.memory.stale
            : true,
        usedBytes: number(sample.system_used_bytes),
        availableBytes: number(sample.system_available_bytes),
      })),
    )
    .filter((sample) => sample.at !== null)
    .sort((a, b) => Date.parse(b.at!) - Date.parse(a.at!));
  let concurrency: {
    status: 'measured' | 'unknown';
    value: number | null;
    observedLowerBound: number | null;
    reason: string | null;
  } = {
    status: 'unknown',
    value: null,
    observedLowerBound: null,
    reason: aggregatorPath
      ? 'slot event evidence is incomplete'
      : 'aggregator unavailable',
  };
  if (aggregatorPath) {
    const result = spawnSync('python', [aggregatorPath, stagePath], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000,
      maxBuffer: 2 * 1024 * 1024,
    });
    try {
      const aggregate = row(JSON.parse(result.stdout));
      const peak = number(aggregate.max_simultaneous_active_jobs);
      const complete = aggregate.slot_events_complete === true;
      concurrency = {
        status: complete ? 'measured' : 'unknown',
        value: complete ? peak : null,
        observedLowerBound: peak,
        reason: complete
          ? null
          : `incomplete slot events (${number(aggregate.unmatched_slot_start_count) ?? 0} unmatched starts)`,
      };
    } catch {
      concurrency.reason = result.error
        ? 'aggregator failed to start'
        : 'aggregator output unavailable';
    }
  }
  return {
    stage,
    source: 'saved-local-stage-logs',
    observedAt: new Date().toISOString(),
    allTasksTerminal: tasks.length > 0 && tasks.every((task) => task.terminal),
    taskCount: tasks.length,
    progress: {
      completedBatches: tasks.reduce(
        (total, task) => total + task.completedBatches,
        0,
      ),
      successfulBatches: tasks.reduce(
        (total, task) => total + task.successfulBatches,
        0,
      ),
      failedBatches: tasks.reduce(
        (total, task) => total + task.failedBatches,
        0,
      ),
      terminalTasks: tasks.filter((task) => task.terminal).length,
    },
    concurrency,
    hostMemory: latestSamples[0] ?? null,
    staleAfterMs,
    updatedAt:
      tasks
        .map((task) => task.updatedAt)
        .filter((item): item is string => item !== null)
        .sort()
        .at(-1) ?? null,
    stale: tasks.some((task) => task.stale),
    tasks: tasks.map(
      ({ samples: _samples, warnings: _warnings, ...task }) => task,
    ),
    logs: await stageLogs(stagePath, taskPaths),
    warnings,
  };
}

export async function readEvidenceIndex(sources: EvidenceSource[]) {
  const stages: Row[] = [];
  const sourceRows: Row[] = [];
  for (const source of sources) {
    try {
      const root = await realpath(resolve(source.path));
      sourceRows.push({
        id: source.id,
        name: source.name,
        path: root,
        kind: source.kind,
      });
      const entries = await readdir(root, { withFileTypes: true });
      const legacyIndex =
        source.kind === 'saved-stage-logs' ? await readStageIndex(root) : null;
      for (const entry of entries.filter((item) => item.isDirectory())) {
        const stagePath = join(root, entry.name);
        if (
          source.kind === 'saved-stage-logs' &&
          stagePattern.test(entry.name)
        ) {
          const stage = legacyIndex?.stages.find(
            (item) => item.stage === entry.name,
          );
          if (!stage) continue;
          stages.push({
            key: `${source.id}:${entry.name}`,
            sourceId: source.id,
            sourceName: source.name,
            sourcePath: root,
            evidencePath: stagePath,
            stageId: entry.name,
            runId: null,
            kind: source.kind,
            startedAt: stage.startedAt,
            collectedAt:
              stage.updatedAt ??
              new Date((await stat(stagePath)).mtimeMs).toISOString(),
            updatedAt: stage.updatedAt,
            taskCount: stage.taskCount,
            terminalCount: stage.terminalCount,
            succeededCount: stage.succeededCount,
            failedCount: stage.failedCount,
            stagePassed: null,
          });
          continue;
        }
        if (source.kind !== 'sol-capacity' || !solStagePattern.test(entry.name))
          continue;
        const warnings: string[] = [];
        const [result, start] = await Promise.all([
          jsonFile(join(stagePath, 'stage-results.json'), warnings),
          jsonFile(join(stagePath, 'stage-start.json'), warnings),
        ]);
        const stageUuid = /^capacity-sol-\d+-([0-9a-f-]{36})$/i.exec(
          entry.name,
        )?.[1];
        if (
          !result ||
          warnings.length ||
          !stageUuid ||
          text(result.stage_id) !== stageUuid
        )
          continue;
        const tasks = Array.isArray(result.tasks) ? result.tasks.map(row) : [];
        const taskCount = number(result.task_count) ?? tasks.length;
        const succeededCount =
          number(result.runner_success_count) ??
          tasks.filter((task) => number(task.runner_exit_code) === 0).length;
        const collectedAt = new Date(
          (await stat(join(stagePath, 'stage-results.json'))).mtimeMs,
        ).toISOString();
        stages.push({
          key: `${source.id}:${entry.name}`,
          sourceId: source.id,
          sourceName: source.name,
          sourcePath: root,
          evidencePath: stagePath,
          stageId: entry.name,
          runId: text(result.run_id) ?? text(start?.run_id),
          kind: source.kind,
          startedAt: time(start?.started_utc),
          collectedAt,
          updatedAt: collectedAt,
          taskCount,
          terminalCount: tasks.length,
          succeededCount,
          failedCount: Math.max(0, taskCount - succeededCount),
          stagePassed: result.stage_passed === true,
        });
      }
    } catch {
      sourceRows.push({
        id: source.id,
        name: source.name,
        path: source.path,
        kind: source.kind,
        error: 'unavailable',
      });
    }
  }
  stages.sort((a, b) =>
    String(b.collectedAt).localeCompare(String(a.collectedAt)),
  );
  return {
    source: 'saved-local-evidence',
    observedAt: new Date().toISOString(),
    sources: sourceRows,
    stages,
  };
}

export async function readEvidenceDetails(
  sources: EvidenceSource[],
  key: string,
) {
  const separator = key.indexOf(':');
  if (separator < 1) throw new Error('Invalid evidence run.');
  const source = sources.find((item) => item.id === key.slice(0, separator));
  const stageId = key.slice(separator + 1);
  if (!source) throw new Error('Invalid evidence run.');
  if (
    source.kind === 'saved-stage-logs'
      ? !stagePattern.test(stageId)
      : !solStagePattern.test(stageId)
  ) {
    throw new Error('Invalid evidence run.');
  }
  const root = await realpath(resolve(source.path));
  const stagePath = await realpath(resolve(root, stageId));
  if (!stagePath.startsWith(`${root}${sep}`))
    throw new Error('Invalid evidence run.');

  if (source.kind === 'saved-stage-logs') {
    const detail = await readStageDetails(root, stageId);
    const stage = (await readEvidenceIndex([source])).stages.find(
      (item) => item.stageId === stageId,
    );
    return {
      ...detail,
      key,
      kind: source.kind,
      sourceName: source.name,
      sourcePath: root,
      evidencePath: stagePath,
      stageId,
      runId: null,
      collectedAt: stage?.collectedAt ?? detail.updatedAt,
    };
  }

  if (source.kind !== 'sol-capacity' || !solStagePattern.test(stageId))
    throw new Error('Invalid evidence run.');
  const warnings: string[] = [];
  const [result, start] = await Promise.all([
    jsonFile(join(stagePath, 'stage-results.json'), warnings),
    jsonFile(join(stagePath, 'stage-start.json'), warnings),
  ]);
  const stageUuid = /^capacity-sol-\d+-([0-9a-f-]{36})$/i.exec(stageId)?.[1];
  if (
    !result ||
    warnings.length ||
    !stageUuid ||
    text(result.stage_id) !== stageUuid
  ) {
    throw new Error('Invalid SOL evidence stage.');
  }
  const tasks = Array.isArray(result.tasks) ? result.tasks.map(row) : [];
  const taskCount = number(result.task_count) ?? tasks.length;
  const succeededCount =
    number(result.runner_success_count) ??
    tasks.filter((task) => number(task.runner_exit_code) === 0).length;
  const collectedAt = new Date(
    (await stat(join(stagePath, 'stage-results.json'))).mtimeMs,
  ).toISOString();
  return {
    key,
    kind: source.kind,
    sourceName: source.name,
    sourcePath: root,
    evidencePath: stagePath,
    stage: stageId,
    stageId,
    runId: text(result.run_id) ?? text(start?.run_id),
    startedAt: time(start?.started_utc),
    collectedAt,
    observedAt: new Date().toISOString(),
    status: result.stage_passed === true ? 'PASS' : 'NOT PASSED',
    taskCount,
    succeededCount,
    failedCount: Math.max(0, taskCount - succeededCount),
    configuredSlots: number(result.configured_slots),
    maxSimultaneousActiveJobs: number(result.max_simultaneous_active_jobs),
    maxSimultaneousActiveJobsVerified:
      result.max_simultaneous_active_jobs_verified === true,
    slotEventsComplete: result.slot_events_complete === true,
    stagePassed: result.stage_passed === true,
    stopReason: text(result.stop_reason),
    tasks: tasks.map((task) => ({
      taskId: text(task.task_uuid),
      status: number(task.runner_exit_code) === 0 ? 'PASS' : 'FAIL',
      runnerExitCode: number(task.runner_exit_code),
      stopReason: text(task.stop_reason),
      maxObservedConcurrentJobs: number(
        task.reported_max_observed_concurrent_jobs,
      ),
      slotAcquired: number(task.slot_acquired),
      slotReleased: number(task.slot_released),
    })),
    logs: [],
    warnings: [],
  };
}

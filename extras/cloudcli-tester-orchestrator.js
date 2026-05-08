#!/usr/bin/env node
/**
 * cloudcli-tester-orchestrator.js
 *
 * External orchestrator for the Tester Pipeline.
 * Monitors tester run state and manages session lifecycle:
 * - Starts new sessions when previous ones end
 * - Handles deploy execution and wait
 * - Respects pipeline completion/failure flags
 *
 * Usage:
 *   node cloudcli-tester-orchestrator.js --tester-id <id> --project <path>
 *   node cloudcli-tester-orchestrator.js --tester-id <id> --project <path> --poll 300
 *   node cloudcli-tester-orchestrator.js --tester-id <id> --project <path> --deploy-wait 120
 *
 * Environment:
 *   CLOUDCLI_URL       - Base URL of the CloudCLI server (default: http://localhost:3001)
 *   CLOUDCLI_TOKEN     - Auth token for API calls
 *   TESTER_DEPLOY_CMD  - Deploy command override
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const TESTER_RUNS_DIR = '.cloudcli/tester-runs';
const DEFAULT_POLL_SECONDS = 300;
const DEFAULT_DEPLOY_WAIT_SECONDS = 120;
const MAX_CONSECUTIVE_ERRORS = 5;

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[orchestrator ${ts}] ${msg}`);
}

function logError(msg) {
  const ts = new Date().toISOString();
  console.error(`[orchestrator ${ts}] ERROR: ${msg}`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--tester-id' && argv[i + 1]) args.testerId = argv[++i];
    else if (arg === '--project' && argv[i + 1]) args.projectPath = argv[++i];
    else if (arg === '--poll' && argv[i + 1]) args.pollSeconds = parseInt(argv[++i], 10);
    else if (arg === '--deploy-wait' && argv[i + 1]) args.deployWaitSeconds = parseInt(argv[++i], 10);
    else if (arg === '--deploy-cmd' && argv[i + 1]) args.deployCommand = argv[++i];
  }
  return args;
}

const sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

async function readState(projectPath, testerId) {
  const safeName = testerId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
  const statePath = path.join(projectPath, TESTER_RUNS_DIR, `${safeName}.json`);
  const raw = await fs.readFile(statePath, 'utf8');
  return JSON.parse(raw);
}

async function writeState(projectPath, testerId, state) {
  const safeName = testerId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200);
  const statePath = path.join(projectPath, TESTER_RUNS_DIR, `${safeName}.json`);
  const tmpPath = `${statePath}.tmp.${Date.now()}`;
  await fs.writeFile(tmpPath, JSON.stringify(state, null, 2) + '\n', 'utf8');
  await fs.rename(tmpPath, statePath);
}

async function callApi(endpoint, method = 'GET', body = null) {
  const baseUrl = process.env.CLOUDCLI_URL || 'http://localhost:3001';
  const token = process.env.CLOUDCLI_TOKEN;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const response = await fetch(`${baseUrl}/api/tester${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
  });

  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

function runDeploy(deployCommand, projectPath) {
  return new Promise((resolve, reject) => {
    execFile('sh', ['-lc', deployCommand], {
      cwd: projectPath,
      timeout: 600000,
      maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`Deploy failed: ${stderr || err.message}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

function getDeployCommand(state, cliOverride) {
  if (cliOverride) return cliOverride;
  if (state.config?.orchestrator?.deployCommand) return state.config.orchestrator.deployCommand;
  if (process.env.TESTER_DEPLOY_CMD) return process.env.TESTER_DEPLOY_CMD;
  return null;
}

async function orchestratorLoop({ testerId, projectPath, pollSeconds, deployWaitSeconds, deployCommand }) {
  let consecutiveErrors = 0;

  log(`Starting orchestrator for tester ${testerId}`);
  log(`Project: ${projectPath}`);
  log(`Poll interval: ${pollSeconds}s`);
  log(`Deploy wait: ${deployWaitSeconds}s`);

  while (true) {
    let state;
    try {
      state = await readState(projectPath, testerId);
      consecutiveErrors = 0;
    } catch (err) {
      consecutiveErrors++;
      logError(`Cannot read state (attempt ${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${err.message}`);
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        logError('Too many consecutive errors reading state. Exiting.');
        process.exit(1);
      }
      await sleep(pollSeconds);
      continue;
    }

    const maxSessions = state.config?.maxSessionsPerRun || 10;
    if (state.sessionCount >= maxSessions) {
      log(`Max sessions reached (${maxSessions}). Marking as failed.`);
      state.status = 'failed';
      state.errorMessage = `Max session limit reached (${maxSessions})`;
      await writeState(projectPath, testerId, state);
      process.exit(0);
    }

    switch (state.status) {
      case 'completed': {
        log('Pipeline completed successfully.');
        log(`Summary: ${state.sessionSummary || 'No summary'}`);
        log(`Metrics: bugs found=${state.metrics?.totalBugsFound || 0}, fixed=${state.metrics?.bugsFixed || 0}, sessions=${state.metrics?.sessionsUsed || 0}`);
        process.exit(0);
        break;
      }

      case 'failed': {
        logError(`Pipeline failed: ${state.errorMessage || state.sessionSummary || 'Unknown error'}`);
        process.exit(1);
        break;
      }

      case 'waiting_deploy': {
        const cmd = getDeployCommand(state, deployCommand);
        if (!cmd) {
          log('Deploy requested but no deploy command configured. Waiting for manual deploy...');
          log('Set TESTER_DEPLOY_CMD env var or config.orchestrator.deployCommand to automate.');
          await sleep(pollSeconds);
          continue;
        }

        log(`Deploy requested. Running: ${cmd}`);
        try {
          await runDeploy(cmd, projectPath);
          log(`Deploy completed. Waiting ${deployWaitSeconds}s for settle...`);

          state.deployedAt = new Date().toISOString();
          state.needsDeploy = false;
          state.metrics = state.metrics || {};
          state.metrics.deploysTriggered = (state.metrics.deploysTriggered || 0) + 1;
          await writeState(projectPath, testerId, state);

          await sleep(deployWaitSeconds);
        } catch (err) {
          logError(`Deploy failed: ${err.message}`);
          state.status = 'failed';
          state.errorMessage = `Deploy failed: ${err.message}`;
          await writeState(projectPath, testerId, state);
          process.exit(1);
        }

        log('Starting continuation session after deploy...');
        try {
          const result = await callApi(`/runs/${testerId}/continue`, 'POST', { projectPath });
          log(`Continue API response: ${JSON.stringify(result)}`);
        } catch (err) {
          logError(`Failed to start continuation session: ${err.message}`);
        }
        break;
      }

      case 'waiting_process': {
        log(`Waiting for process. Will check again in ${pollSeconds}s.`);
        await sleep(pollSeconds);

        log('Starting continuation session...');
        try {
          const result = await callApi(`/runs/${testerId}/continue`, 'POST', { projectPath });
          log(`Continue API response: ${JSON.stringify(result)}`);
        } catch (err) {
          logError(`Failed to start continuation session: ${err.message}`);
        }
        break;
      }

      case 'running': {
        if (!state.currentSessionId) {
          log('Status is running but no active session. Starting continuation...');
          try {
            const result = await callApi(`/runs/${testerId}/continue`, 'POST', { projectPath });
            log(`Continue API response: ${JSON.stringify(result)}`);
          } catch (err) {
            logError(`Failed to start continuation session: ${err.message}`);
          }
        } else {
          log(`Session ${state.currentSessionId} is active. Waiting...`);
        }
        break;
      }

      case 'paused': {
        log('Pipeline is paused. Waiting for manual resume...');
        break;
      }

      default: {
        log(`Unknown status: ${state.status}. Waiting...`);
        break;
      }
    }

    await sleep(pollSeconds);
  }
}

// ---- Main ----

const args = parseArgs(process.argv);

if (!args.testerId) {
  console.error('Usage: cloudcli-tester-orchestrator.js --tester-id <id> --project <path>');
  process.exit(1);
}

orchestratorLoop({
  testerId: args.testerId,
  projectPath: args.projectPath || process.cwd(),
  pollSeconds: args.pollSeconds || DEFAULT_POLL_SECONDS,
  deployWaitSeconds: args.deployWaitSeconds || DEFAULT_DEPLOY_WAIT_SECONDS,
  deployCommand: args.deployCommand || null,
}).catch((err) => {
  logError(`Orchestrator crashed: ${err.message}`);
  process.exit(1);
});

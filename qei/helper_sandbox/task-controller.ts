// ============================================================================
// MCP-ACP Bridge Server — Task Controller
// ============================================================================
// Orchestrates multi-step autonomous reasoning by decomposing tasks into
// sub-tasks and executing them sequentially with iteration and duration
// safeguards.

import type { ACPClient, ACPPromptParams } from './acp-client.js';
import { TaskIterationLimitError, TaskDurationLimitError } from './errors.js';
import type {
  TaskDefinition,
  TaskResult,
  SubTaskResult,
  TaskState,
} from './types.js';

// ----------------------------------------------------------------------------
// Public interfaces
// ----------------------------------------------------------------------------

export interface TaskControllerOptions {
  maxIterations: number;   // default: 10
  maxDurationMs: number;   // default: 300000 (5 min)
}

export interface TaskController {
  executeTask(task: TaskDefinition, sessionId: string): Promise<TaskResult>;
  abortTask(taskId: string): void;
}

// ----------------------------------------------------------------------------
// Decision evaluation
// ----------------------------------------------------------------------------

export type Decision = 'continue' | 'complete' | 'retry' | 'abort';

/**
 * Evaluates the ACP response content to decide the next action.
 * Simple heuristic — can be overridden by callers later.
 */
export function evaluateDecision(responseContent: string): Decision {
  const upper = responseContent.toUpperCase();
  if (upper.includes('DONE') || upper.includes('COMPLETE')) return 'complete';
  if (upper.includes('ERROR') || upper.includes('ABORT')) return 'abort';
  if (upper.includes('RETRY')) return 'retry';
  return 'continue';
}

// ----------------------------------------------------------------------------
// Sub-task decomposition
// ----------------------------------------------------------------------------

/**
 * Decomposes a task into an initial prompt for the first sub-task.
 * Subsequent prompts are derived from the previous response (continuation).
 */
function buildInitialPrompt(task: TaskDefinition): ACPPromptParams {
  return {
    messages: [
      { role: 'user', content: task.prompt },
    ],
    ...(task.context !== undefined && { context: task.context }),
  };
}

function buildContinuationPrompt(
  task: TaskDefinition,
  previousResponse: string,
  iteration: number,
): ACPPromptParams {
  return {
    messages: [
      { role: 'user', content: task.prompt },
      { role: 'assistant', content: previousResponse },
      { role: 'user', content: `Continue with step ${iteration}. Previous response has been noted.` },
    ],
  };
}

// ----------------------------------------------------------------------------
// Factory
// ----------------------------------------------------------------------------

const DEFAULT_OPTIONS: TaskControllerOptions = {
  maxIterations: 10,
  maxDurationMs: 300_000,
};

export function createTaskController(
  acpClient: ACPClient,
  options: Partial<TaskControllerOptions> = {},
): TaskController {
  const opts: TaskControllerOptions = { ...DEFAULT_OPTIONS, ...options };
  const activeTasks = new Map<string, TaskState>();

  async function executeTask(
    task: TaskDefinition,
    sessionId: string,
  ): Promise<TaskResult> {
    const abortController = new AbortController();
    const startedAt = Date.now();

    const state: TaskState = {
      taskId: task.taskId,
      sessionId,
      status: 'running',
      iteration: 0,
      startedAt,
      subResults: [],
      abortController,
    };

    activeTasks.set(task.taskId, state);

    // Hard timeout via setTimeout — converges on the same abort logic
    const hardTimeout = setTimeout(() => {
      abortController.abort(new TaskDurationLimitError(
        `Task ${task.taskId} exceeded maximum duration of ${opts.maxDurationMs}ms`,
      ));
    }, opts.maxDurationMs);

    try {
      return await runIterationLoop(task, sessionId, state, opts, acpClient);
    } finally {
      clearTimeout(hardTimeout);
      activeTasks.delete(task.taskId);
    }
  }

  function abortTask(taskId: string): void {
    const state = activeTasks.get(taskId);
    if (state) {
      state.abortController.abort(new Error(`Task ${taskId} aborted by user`));
    }
  }

  return { executeTask, abortTask };
}

// ----------------------------------------------------------------------------
// Core iteration loop
// ----------------------------------------------------------------------------

async function runIterationLoop(
  task: TaskDefinition,
  sessionId: string,
  state: TaskState,
  opts: TaskControllerOptions,
  acpClient: ACPClient,
): Promise<TaskResult> {
  let lastResponse = '';

  while (true) {
    // --- Check abort signal ---
    if (state.abortController.signal.aborted) {
      return buildResult(task.taskId, state, resolveAbortStatus(state));
    }

    // --- Iteration limit check (before each iteration) ---
    if (state.iteration >= opts.maxIterations) {
      state.status = 'aborted_iteration_limit';
      return buildResult(task.taskId, state);
    }

    // --- Duration check (Date.now() per iteration) ---
    const elapsed = Date.now() - state.startedAt;
    if (elapsed >= opts.maxDurationMs) {
      state.status = 'aborted_timeout';
      return buildResult(task.taskId, state);
    }

    // --- Build prompt for this iteration ---
    const prompt = state.iteration === 0
      ? buildInitialPrompt(task)
      : buildContinuationPrompt(task, lastResponse, state.iteration + 1);

    // --- Execute sub-task via ACP_Client ---
    state.iteration++;
    let response: string;

    try {
      // Check abort before the async call
      if (state.abortController.signal.aborted) {
        return buildResult(task.taskId, state, resolveAbortStatus(state));
      }

      const result = await acpClient.sessionPrompt(sessionId, prompt);
      response = result.content;
    } catch (err: unknown) {
      // If aborted during the call, return abort result
      if (state.abortController.signal.aborted) {
        return buildResult(task.taskId, state, resolveAbortStatus(state));
      }

      // Unexpected error — record and abort
      const errorMessage = err instanceof Error ? err.message : String(err);
      const subResult: SubTaskResult = {
        iteration: state.iteration,
        prompt: prompt.messages.map(m => m.content).join('\n'),
        response: `Error: ${errorMessage}`,
        decision: 'abort',
      };
      state.subResults.push(subResult);
      state.status = 'aborted_error';
      return buildResult(task.taskId, state);
    }

    // --- Evaluate decision ---
    const decision = evaluateDecision(response);
    const subResult: SubTaskResult = {
      iteration: state.iteration,
      prompt: prompt.messages.map(m => m.content).join('\n'),
      response,
      decision,
    };
    state.subResults.push(subResult);
    lastResponse = response;

    // --- Act on decision ---
    switch (decision) {
      case 'complete':
        state.status = 'completed';
        return buildResult(task.taskId, state, 'completed', response);

      case 'abort':
        state.status = 'aborted_error';
        return buildResult(task.taskId, state);

      case 'retry':
        // Retry doesn't advance — decrement iteration so the next loop
        // re-attempts the same step (but still counts toward maxIterations
        // since we already incremented above)
        break;

      case 'continue':
        // Continue to next iteration
        break;
    }
  }
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function resolveAbortStatus(state: TaskState): TaskResult['status'] {
  const reason = state.abortController.signal.reason;
  if (reason instanceof TaskDurationLimitError) return 'aborted_timeout';
  if (reason instanceof TaskIterationLimitError) return 'aborted_iteration_limit';
  return 'aborted_error';
}

function buildResult(
  taskId: string,
  state: TaskState,
  statusOverride?: TaskResult['status'],
  finalResult?: string,
): TaskResult {
  const status = statusOverride ?? state.status;
  return {
    taskId,
    status: status === 'running' ? 'aborted_error' : status,
    iterations: state.subResults.length,
    durationMs: Date.now() - state.startedAt,
    subResults: state.subResults,
    ...(finalResult !== undefined && { finalResult }),
  };
}

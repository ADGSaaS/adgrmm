-- A new kind of agent task: run the checks now, instead of waiting for their schedule.
ALTER TYPE "agent_task_type" ADD VALUE IF NOT EXISTS 'run_checks';

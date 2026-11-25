// backend/src/workflows/workflows.bus.ts
//
// How the places where things happen (an alert opens, a computer enrolls, a ticket is made) tell the workflow engine without depending on it.
// Firing never throws and never waits: a broken rule must not break raising an alert or creating a ticket.
import { EventEmitter } from "node:events";
import type { Trigger } from "./workflows.core";

export type WorkflowEvent = { trigger: Trigger; alertId?: string; deviceId?: string; ticketId?: string; source?: string; reason?: string };

export const workflowBus = new EventEmitter();
workflowBus.setMaxListeners(20);

export function fireWorkflow(event: WorkflowEvent): void {
    try { setImmediate(() => { try { workflowBus.emit("event", event); } catch { /* never breaks the caller */ } }); } catch { /* nothing */ }
}

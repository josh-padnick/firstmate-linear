export type TaskSignal = "working" | "needs-decision" | "blocked" | "failed" | "done" | "resolved";

export type TaskState = {
  task: string;
  role: "primary" | "support";
  signal: TaskSignal;
};

export type ReducedState = "working" | "needs-decision" | "blocked" | "failed" | "done";

export function reduceTaskState(tasks: TaskState[]): ReducedState {
  const primary = tasks.filter((task) => task.role === "primary");
  if (primary.some((task) => task.signal === "failed")) return "failed";
  if (primary.some((task) => task.signal === "blocked")) return "blocked";
  if (primary.some((task) => task.signal === "needs-decision")) return "needs-decision";
  if (primary.length > 0 && primary.every((task) => task.signal === "done")) return "done";
  return "working";
}

export function foldSignals(events: Array<{ task: string; role: "primary" | "support"; signal: TaskSignal; key?: string }>): TaskState[] {
  const base = new Map<string, TaskState>();
  const gates = new Map<string, TaskState>();
  for (const event of events) {
    if (event.signal === "resolved") {
      gates.delete(`${event.task}\0${event.key ?? "default"}`);
    } else if (["needs-decision", "blocked", "failed"].includes(event.signal)) {
      gates.set(`${event.task}\0${event.key ?? "default"}`, event);
    } else {
      base.set(event.task, event);
    }
  }
  return [...base.values(), ...gates.values()];
}

export type OperationalState = "starting" | "reconciling" | "ready" | "degraded";

export class RuntimeHealth {
  private state: OperationalState = "starting";

  constructor(private readonly criticalFailure: () => boolean = () => false) {}

  set(state: OperationalState): void {
    this.state = state;
  }

  snapshot(): { status: OperationalState } {
    return { status: this.criticalFailure() ? "degraded" : this.state };
  }
}

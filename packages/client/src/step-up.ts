/**
 * One "confirm it's you" at a time (SEC-17).
 *
 * Several requests can be refused with `step_up_required` at once — two
 * panels on one screen, or a queue draining while somebody opens a
 * document. They must share one prompt and all carry on when it is
 * answered. Until 0.4.3 the web app held one prompt in a single slot, so a
 * second request replaced the first's, and the first waited for ever.
 */
export interface StepUpRequest {
  action: string;
  message: string;
}

export class StepUpCoordinator {
  private pending: Promise<boolean> | null = null;

  /** `ask` shows the prompt and resolves true when the person confirms. */
  constructor(private readonly ask: (req: StepUpRequest) => Promise<boolean>) {}

  /** Resolves when the prompt is answered; everybody asking shares one. */
  confirm(req: StepUpRequest): Promise<boolean> {
    this.pending ??= this.ask(req)
      .catch(() => false)
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  get asking(): boolean {
    return this.pending !== null;
  }
}

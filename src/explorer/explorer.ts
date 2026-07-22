/**
 * Coverage-guided, epsilon-greedy element chooser. Prefers controls it hasn't
 * exercised in the current state; with probability epsilon it picks uniformly
 * at random to escape traps (modals that reopen, etc.). Every choice flows
 * through the seeded {@link Rng} so a seed reproduces the run.
 */
import type { Rng } from '../core/rng';
import type { ElementDescriptor, FormDescriptor } from '../core/types';

export class Explorer {
  private seenStates = new Set<string>();
  /** `${stateHash}:${fp}` pairs already exercised. */
  private exercised = new Set<string>();
  /** Create-surfaces (by fpKey) successfully completed. */
  private completedForms = new Set<string>();
  /** Attempts per create-surface fpKey. */
  private formAttempts = new Map<string, number>();

  constructor(
    private rng: Rng,
    private epsilon = 0.15,
  ) {}

  /** Pick an un-completed create-surface still under its attempt cap. */
  chooseForm(forms: readonly FormDescriptor[], maxAttempts: number): FormDescriptor | undefined {
    const eligible = forms.filter(
      (f) =>
        !this.completedForms.has(f.fpKey) && (this.formAttempts.get(f.fpKey) ?? 0) < maxAttempts,
    );
    if (eligible.length === 0) return undefined;
    const sorted = [...eligible].sort((a, b) => a.fpKey.localeCompare(b.fpKey));
    return this.rng.pick(sorted);
  }

  recordFormAttempt(fpKey: string): void {
    this.formAttempts.set(fpKey, (this.formAttempts.get(fpKey) ?? 0) + 1);
  }

  markFormCompleted(fpKey: string): void {
    this.completedForms.add(fpKey);
  }

  isNewState(stateHash: string): boolean {
    return !this.seenStates.has(stateHash);
  }

  markState(stateHash: string): void {
    this.seenStates.add(stateHash);
  }

  get statesDiscovered(): number {
    return this.seenStates.size;
  }

  /**
   * Choose an element to act on. Returns undefined only if `elements` is empty.
   * Sorting by fingerprint first guarantees deterministic indexing.
   */
  choose(stateHash: string, elements: readonly ElementDescriptor[]): ElementDescriptor | undefined {
    if (elements.length === 0) return undefined;
    const sorted = [...elements].sort((a, b) => a.fp.localeCompare(b.fp));
    const unseen = sorted.filter((e) => !this.exercised.has(`${stateHash}:${e.fp}`));

    const chosen =
      unseen.length > 0 && !this.rng.bool(this.epsilon)
        ? this.rng.pick(unseen) // coverage-guided
        : this.rng.pick(sorted); // random-walk escape

    this.exercised.add(`${stateHash}:${chosen.fp}`);
    return chosen;
  }
}

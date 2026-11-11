/**
 * The run's verdict in words, shared by every report so the HTML page, the
 * GitHub summary and JUnit agree on what happened and why.
 */
import { isFailingFinding } from '../baseline';
import { EXIT, type RunResult, type RunStop } from '../core/types';

export interface Verdict {
  state: 'passed' | 'failed' | 'error';
  label: 'PASSED' | 'FAILED' | 'ERROR';
  /** One sentence saying why, without a trailing full stop. */
  detail: string;
  /** Findings that count against the fail threshold. */
  failing: number;
}

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** The stop reason, with the pages the crawl had found but not reached. */
export function stopSummary(stop: RunStop): string {
  return stop.pagesQueued > 0
    ? `${stop.reason}, ${plural(stop.pagesQueued, 'page')} still queued`
    : stop.reason;
}

export function verdictOf(result: RunResult): Verdict {
  const { failOn } = result.config;
  const failOnNew = result.config.failOnNew ?? false;
  const failing = result.findings.filter((finding) =>
    isFailingFinding(finding, failOn, failOnNew),
  ).length;
  const stop = result.run.stop;
  const scope = failOnNew ? 'new finding' : 'finding';
  const failingText = `${plural(failing, scope)} at or above ${failOn}`;

  if (result.run.exitCode === EXIT.ERROR) {
    return {
      state: 'error',
      label: 'ERROR',
      detail: stop
        ? `Partial results: ${stop.reason}`
        : 'Partial results: the run was interrupted or hit a tool error',
      failing,
    };
  }
  if (result.run.exitCode === EXIT.CLEAN) {
    return {
      state: 'passed',
      label: 'PASSED',
      detail: failOnNew
        ? `No new findings at or above ${failOn}`
        : `No findings at or above ${failOn}`,
      failing,
    };
  }
  // Exit 1 is a failing finding, a run that stopped early, or both.
  const stoppedEarly = result.run.complete === false;
  const early = `Stopped early: ${stop ? stop.reason : 'the run did not complete'}`;
  return {
    state: 'failed',
    label: 'FAILED',
    detail: !stoppedEarly
      ? `${failingText[0]!.toUpperCase()}${failingText.slice(1)}`
      : failing > 0
        ? `${early}. ${failingText[0]!.toUpperCase()}${failingText.slice(1)}`
        : early,
    failing,
  };
}

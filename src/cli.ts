#!/usr/bin/env node
import { runCli } from './cli-program';
import { logger } from './core/logger';
import { EXIT } from './core/types';

runCli().catch((err) => {
  logger.error((err as Error).message);
  process.exit(EXIT.ERROR);
});

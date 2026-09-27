/** Single source of truth for the version: read from package.json at runtime so
 *  it can never drift. package.json is always included in the published tarball,
 *  and `../package.json` resolves correctly from both src (tests) and dist. */
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const requireFromHere = createRequire(import.meta.url);
const pkg = requireFromHere('../package.json') as { version: string };

export const version: string = pkg.version;

/** Directory of the running buttonmash package (where its package.json is). */
export const packageRoot: string = dirname(requireFromHere.resolve('../package.json'));

/** Single source of truth for the version: read from package.json at runtime so
 *  it can never drift. package.json is always included in the published tarball,
 *  and `../package.json` resolves correctly from both src (tests) and dist. */
import { createRequire } from 'node:module';

const requireFromHere = createRequire(import.meta.url);
const pkg = requireFromHere('../package.json') as { version: string };

export const version: string = pkg.version;

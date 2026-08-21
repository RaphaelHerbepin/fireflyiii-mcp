/**
 * Minimal extractor for the `paths:` section of the vendored Firefly III OpenAPI spec.
 *
 * Deliberately not a YAML parser. The spec is 784 kB of uniformly indented YAML and all we need from
 * it is the (method, path, operationId) triple, which sits at three fixed indentation levels. Adding a
 * YAML dependency to read three fields would be out of proportion for a repository that carries two
 * runtime dependencies on purpose.
 *
 * The trade-off is that this code is blind to anything reindented or reformatted upstream — so callers
 * MUST assert the fingerprint (see EXPECTED_OPERATIONS / EXPECTED_PATHS). Without that assertion the
 * failure mode is a parser that quietly reads zero operations and a coverage report that claims
 * everything is covered.
 */

export type HttpMethod = 'get' | 'put' | 'post' | 'delete' | 'patch' | 'head' | 'options';

export interface SpecOperation {
  method: HttpMethod;
  /** Path as written in the spec, including the `/v1` prefix — e.g. `/v1/accounts/{id}`. */
  path: string;
  operationId: string;
}

/** Fingerprint of spec 6.5.5. A mismatch means the file changed shape, not that coverage changed. */
export const EXPECTED_OPERATIONS = 230;
export const EXPECTED_PATHS = 164;

const PATH_RE = /^ {2}(\/\S*):\s*$/;
const METHOD_RE = /^ {4}(get|put|post|delete|patch|head|options):\s*$/;
const OPERATION_ID_RE = /^ {6}operationId:\s*(\S+)\s*$/;

export class SpecParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpecParseError';
  }
}

/**
 * Extracts every operation from the spec's `paths:` section.
 *
 * Scanning stops at the next top-level key (a line starting in column 0), so `components:` and the
 * schema definitions below it are never mistaken for paths.
 */
export function parseSpecOperations(yaml: string): SpecOperation[] {
  const operations: SpecOperation[] = [];
  let inPaths = false;
  let path = '';
  let method: HttpMethod | '' = '';

  for (const line of yaml.split('\n')) {
    if (!inPaths) {
      if (/^paths:\s*$/.test(line)) inPaths = true;
      continue;
    }
    // A non-indented, non-empty line ends the paths section.
    if (/^\S/.test(line)) break;

    const pathMatch = PATH_RE.exec(line);
    if (pathMatch) {
      path = pathMatch[1];
      method = '';
      continue;
    }
    const methodMatch = METHOD_RE.exec(line);
    if (methodMatch) {
      method = methodMatch[1] as HttpMethod;
      continue;
    }
    const idMatch = OPERATION_ID_RE.exec(line);
    if (idMatch && path && method) {
      operations.push({ method, path, operationId: idMatch[1] });
      // Guard against a second operationId under the same method key.
      method = '';
    }
  }

  return operations;
}

/**
 * Parses and asserts the fingerprint. Use this rather than {@link parseSpecOperations} anywhere a
 * wrong answer would be worse than no answer — which is everywhere in CI.
 */
export function parseSpecOperationsChecked(yaml: string): SpecOperation[] {
  const operations = parseSpecOperations(yaml);
  const paths = new Set(operations.map((o) => o.path));

  if (operations.length !== EXPECTED_OPERATIONS || paths.size !== EXPECTED_PATHS) {
    throw new SpecParseError(
      `Spec fingerprint mismatch: parsed ${operations.length} operations across ${paths.size} paths, ` +
        `expected ${EXPECTED_OPERATIONS} across ${EXPECTED_PATHS}. Either the vendored spec changed ` +
        `(check spec/README.md's SHA-256) or its formatting no longer matches this parser. Do not ` +
        `relax this check to unblock a build: a coverage report from a misparsed spec is worse than none.`,
    );
  }

  const duplicates = operations.map((o) => o.operationId).filter((id, i, all) => all.indexOf(id) !== i);
  if (duplicates.length > 0) {
    throw new SpecParseError(`Duplicate operationIds in spec: ${[...new Set(duplicates)].join(', ')}`);
  }

  return operations;
}

/** `/v1/accounts/{id}` → `/accounts/{p}` — the form tool code uses, with the client's `/api/v1` prefix
 *  stripped and every path parameter normalised so template literals can be compared against it. */
export function toClientRoute(path: string): string {
  return path.replace(/^\/v1/, '').replace(/\{[^}]+\}/g, '{p}');
}

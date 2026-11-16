import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Deploy-config gate: the production image is built and run with ONE stable
 * Server Actions key.
 *
 * WHY THIS EXISTS. Next bakes NEXT_SERVER_ACTIONS_ENCRYPTION_KEY into
 * `next build` (the server-reference manifest; the same value salts every
 * action id) and, with none set, mints a fresh random key per build. Until
 * 2026-10-31 nothing set it, so every deploy invalidated the forms that were
 * open during it: the add-facility form, the club application and every desk
 * form in the club office posted to an action id the new build did not know
 * (404 with x-nextjs-action-not-found), and the member's answers were gone.
 * No unit test could see it — the defect lived between the build and the
 * manifest — so this test pins the three places that have to agree:
 *
 *   1. the Dockerfile mounts the key as a BuildKit SECRET for `next build`
 *      (a build arg would land in the image history);
 *   2. deploy.yml derives it from AUTH_SECRET, hands it to every build that
 *      uses the Dockerfile, and renders the same value into the runtime .env;
 *   3. compose gives the web service that runtime value.
 */

const REPO_ROOT = join(__dirname, '..', '..', '..');
const read = (...parts: string[]) => readFileSync(join(REPO_ROOT, ...parts), 'utf8');

const SECRET_ID = 'next_server_actions_key';
const LABEL = 'pops/server-actions/v1';

describe('the Server Actions key is stable across deploys', () => {
  it('the Dockerfile builds the web app with the key mounted as a BuildKit secret', () => {
    const dockerfile = read('Dockerfile');
    const run =
      /RUN --mount=type=secret,id=next_server_actions_key \\\n([\s\S]*?)pnpm --filter @sportkarta\/web build/.exec(
        dockerfile,
      );
    if (!run) throw new Error('the web build RUN must mount the secret');
    // Exported only when the file is present and non-empty, so a local build
    // without the secret keeps Next's per-build key instead of an empty one.
    expect(run[1]).toMatch(/\[ -s \/run\/secrets\/next_server_actions_key \]/);
    expect(run[1]).toMatch(
      /export NEXT_SERVER_ACTIONS_ENCRYPTION_KEY="\$\(cat \/run\/secrets\/next_server_actions_key\)"/,
    );
    expect(dockerfile).not.toMatch(/ARG NEXT_SERVER_ACTIONS_ENCRYPTION_KEY/);
  });

  it('deploy.yml derives the key from AUTH_SECRET and hands it to every Dockerfile build', () => {
    const deploy = read('.github', 'workflows', 'deploy.yml');
    // The build job writes the derived key to a file...
    expect(deploy).toMatch(
      new RegExp(
        `printf '%s' '${LABEL}' \\| openssl dgst -sha256 -hmac "\\$AUTH_SECRET" -binary \\| base64 -w0 > "\\$RUNNER_TEMP/${SECRET_ID}"`,
      ),
    );
    // ...and every build that uses the Dockerfile (web, worker, migrate — they
    // share the build stage) receives it as a secret file, never a build arg.
    for (const target of ['web', 'worker', 'migrate']) {
      const step = new RegExp(
        `context: \\.\\n\\s+target: ${target}\\n\\s+push: true\\n\\s+secret-files: \\|\\n\\s+${SECRET_ID}=\\$\\{\\{ runner\\.temp \\}\\}/${SECRET_ID}`,
      );
      expect(deploy, `${target} build must receive the secret file`).toMatch(step);
    }
    expect(deploy).not.toMatch(/build-args:[\s\S]{0,200}NEXT_SERVER_ACTIONS_ENCRYPTION_KEY/);
    // The runtime value is the SAME derivation, written into the VPS .env.
    expect(deploy).toMatch(
      new RegExp(
        `actions_key=\\$\\(printf '%s' '${LABEL}' \\| openssl dgst -sha256 -hmac "\\$AUTH_SECRET" -binary \\| base64 -w0\\)`,
      ),
    );
    expect(deploy).toMatch(/printf "NEXT_SERVER_ACTIONS_ENCRYPTION_KEY='%s'\\n" "\$actions_key"/);
  });

  it('compose hands the runtime key to the web service', () => {
    const compose = read('deploy', 'compose.prod.yml');
    const web = /^ {2}web:\n([\s\S]*?)^ {2}worker:/m.exec(compose);
    if (!web) throw new Error('compose.prod.yml must declare a web service before the worker');
    expect(web[1]).toMatch(
      /^\s+NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: \$\{NEXT_SERVER_ACTIONS_ENCRYPTION_KEY:-\}$/m,
    );
  });

  it('.env.example documents the key and its format', () => {
    const example = read('.env.example');
    expect(example).toMatch(/^# NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=$/m);
    expect(example).toMatch(/openssl rand -base64 32/);
  });
});

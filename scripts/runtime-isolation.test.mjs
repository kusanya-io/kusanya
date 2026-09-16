import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { posix } from 'node:path';
import { test } from 'node:test';

// A source-level regression tripwire, not a security boundary. This checks the
// package identities and literal execution/configuration paths below; it does
// not execute installs, resolve arbitrary shell code, or follow import graphs.
// The denied inventory is the probe package and its direct dependencies; common
// transitive libraries shared with normal tooling are not categorically banned.
const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const readJson = (path) => JSON.parse(read(path));
const dependencyFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];
const runtime = readJson('scripts/runtime/package.json');
const runtimeLock = readJson('scripts/runtime/package-lock.json');
const runtimeNames = new Set([
  runtime.name,
  ...dependencyFields.flatMap((field) => Object.keys(runtime[field] ?? {})),
]);
const baseline = {
  manifests: {
    'package.json': readJson('package.json'),
    'service/package.json': readJson('service/package.json'),
  },
  locks: {
    'package-lock.json': readJson('package-lock.json'),
    'service/package-lock.json': readJson('service/package-lock.json'),
  },
  workflows: Object.fromEntries(
    readdirSync(new URL('../.github/workflows/', import.meta.url))
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => [name, read(`.github/workflows/${name}`)]),
  ),
  dockerfile: read('service/Dockerfile'),
  dockerignore: read('service/.dockerignore'),
};

function normalized(value) {
  return value.replaceAll('\\', '/');
}

function runtimeReference(value, directory = '.') {
  if (typeof value !== 'string') return false;
  const text = normalized(value);
  const tokens = text.split(/[^a-zA-Z0-9@_./-]+/);
  for (const name of runtimeNames) {
    if (
      tokens.some(
        (token) =>
          token === name ||
          token.startsWith(`${name}@`) ||
          token === `node_modules/${name}` ||
          token.endsWith(`/node_modules/${name}`) ||
          token.includes(`/node_modules/${name}/`) ||
          token.includes(`/${name}/-/`),
      )
    ) {
      return true;
    }
  }
  // npm aliases retain the real package after npm:, and local/workspace links
  // retain their path even when the dependency has an unrelated alias name.
  const local = text.replace(/^(?:file:|link:|workspace:)/, '');
  const resolved = posix.normalize(posix.join(directory, local));
  return (
    /(?:^|\/)scripts\/runtime(?:\/|$)/.test(resolved) ||
    /(?:^|[\s'"=])(?:\.\.?\/)*scripts\/runtime(?:[\s/'";]|$)/.test(text)
  );
}

function inspectPackage(value, label, directory, problems) {
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    if (runtimeReference(key, directory)) problems.push(`${label}: ${key}`);
    if (typeof entry === 'string' && runtimeReference(entry, directory)) {
      problems.push(`${label}.${key}: ${entry}`);
    } else if (entry && typeof entry === 'object') {
      inspectPackage(entry, `${label}.${key}`, directory, problems);
    }
  }
}

function activeLines(source) {
  return source.split(/\r?\n/).filter((line) => !/^\s*#/.test(line));
}

function isolationProblems(input) {
  const problems = [];
  for (const [path, manifest] of Object.entries(input.manifests)) {
    const directory = posix.dirname(path);
    inspectPackage(manifest, path, directory, problems);
    const workspaces = Array.isArray(manifest.workspaces)
      ? manifest.workspaces
      : (manifest.workspaces?.packages ?? []);
    const runtimePath = posix.relative(directory, 'scripts/runtime');
    if (
      workspaces.some(
        (pattern) =>
          typeof pattern === 'string' &&
          posix.matchesGlob(
            runtimePath,
            normalized(pattern).replace(/^\.\//, ''),
          ),
      )
    ) {
      problems.push(`${path}: workspace includes scripts/runtime`);
    }
  }
  for (const [path, lock] of Object.entries(input.locks)) {
    if (lock.lockfileVersion !== 3 || !lock.packages?.['']) {
      problems.push(`${path}: review changed lockfile structure`);
    }
    inspectPackage(lock, path, posix.dirname(path), problems);
  }
  // Keep the normal root test discovery flat: the optional probe directory must
  // not become part of a recursive Node test run via a widened test command.
  if (
    input.manifests['package.json'].scripts?.test !==
    'node --test scripts/*.test.mjs'
  ) {
    problems.push('package.json: review changed root test discovery');
  }
  for (const [name, source] of Object.entries(input.workflows)) {
    for (const line of activeLines(source)) {
      if (runtimeReference(line)) problems.push(`${name}: runtime tooling`);
      if (/\bdocker\s+(?:build\b|buildx\s+build\b)/.test(line)) {
        if (!/\s(?:\.\/)?service\s*$/.test(line)) {
          problems.push(`${name}: review Docker build context outside service`);
        }
      }
    }
  }
  if (
    !activeLines(input.workflows['ci.yml'] ?? '')
      .join('\n')
      .includes('run: node --test scripts/*.test.mjs')
  ) {
    problems.push('ci.yml: root isolation test discovery missing');
  }
  const copySources = new Set([
    'package.json package-lock.json ./',
    'tsconfig.json eslint.config.js ./',
    'src ./src',
    'test ./test',
    '--from=build --chown=node:node /app/package.json ./',
    '--from=build --chown=node:node /app/node_modules ./node_modules',
    '--from=build --chown=node:node /app/dist/src ./dist/src',
  ]);
  for (const line of activeLines(input.dockerfile)) {
    if (runtimeReference(line)) problems.push('Dockerfile: runtime tooling');
    const copy = line.trim().match(/^(COPY|ADD)\s+(.+)$/i);
    if (copy && (copy[1] !== 'COPY' || !copySources.has(copy[2]))) {
      problems.push('Dockerfile: review broadened container copy sources');
    }
  }
  // The Dockerfile can copy only reviewed service sources above. Excluding
  // local node_modules/dist additionally keeps host-built artifacts out.
  const ignoreLines = activeLines(input.dockerignore)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const excluded of ['node_modules', 'dist']) {
    if (
      !ignoreLines.includes(excluded) ||
      ignoreLines.some(
        (line) =>
          line.startsWith('!') &&
          (line.slice(1).includes(excluded) || /[?*]/.test(line)),
      )
    ) {
      problems.push(`.dockerignore: review ${excluded} exclusion`);
    }
  }
  return problems;
}

test('optional runtime dependencies remain separate from normal package and execution paths', () => {
  assert.equal(runtime.private, true);
  assert.ok(runtimeNames.size > 1, 'runtime dependency inventory is nonempty');
  for (const field of dependencyFields) {
    assert.deepEqual(runtime[field], runtimeLock.packages[''][field]);
  }
  assert.deepEqual(isolationProblems(baseline), []);
});

test('unrelated aliases and workspaces are allowed and comments are not executable paths', () => {
  const fixture = structuredClone(baseline);
  fixture.manifests['package.json'].dependencies = {
    ordinary: 'npm:ordinary-package@1.0.0',
    local: 'file:./unrelated-package',
  };
  fixture.manifests['package.json'].workspaces = ['packages/*'];
  fixture.workflows['ci.yml'] += '\n# Optional probes: scripts/runtime\n';
  fixture.dockerfile += '\n# Do not install enketo-core here.\n';
  assert.deepEqual(isolationProblems(fixture), []);
});

function rejectsMutation(label, mutate, expected) {
  test(label, () => {
    // Mutations are in-memory clones: no installs, subprocesses, or fixture
    // writes can alter the package trees being checked by the positive case.
    const fixture = structuredClone(baseline);
    mutate(fixture);
    assert.ok(
      isolationProblems(fixture).some((problem) => expected.test(problem)),
      `tripwire did not catch ${label}`,
    );
  });
}

for (const path of Object.keys(baseline.manifests)) {
  const localRuntime = path.startsWith('service/')
    ? '../scripts/runtime'
    : 'scripts/runtime';
  for (const field of dependencyFields) {
    for (const name of runtimeNames) {
      rejectsMutation(
        `${path} rejects ${name} in ${field}`,
        (input) => {
          input.manifests[path][field] = {
            ...input.manifests[path][field],
            [name]: '0.0.0-synthetic',
          };
        },
        /package\.json/,
      );
    }
  }
  for (const spec of [
    'npm:enketo-core@9.0.1',
    `file:${localRuntime}`,
    `link:${localRuntime}`,
    'workspace:@kusanya/client-runtime-probes@*',
  ]) {
    rejectsMutation(
      `${path} rejects aliased runtime dependency ${spec}`,
      (input) => {
        input.manifests[path].dependencies = { innocent: spec };
      },
      /package\.json/,
    );
  }
  rejectsMutation(
    `${path} rejects workspace glob enrolling runtime`,
    (input) => {
      input.manifests[path].workspaces = {
        packages: [path.startsWith('service/') ? '../scripts/*' : 'scripts/*'],
      };
    },
    /workspace includes/,
  );
  rejectsMutation(
    `${path} rejects lifecycle runtime installation`,
    (input) => {
      input.manifests[path].scripts.postinstall =
        `npm --prefix ${localRuntime} ci`;
    },
    /scripts\.postinstall/,
  );
  for (const script of ['build', 'test']) {
    rejectsMutation(
      `${path} rejects runtime probe execution from ${script}`,
      (input) => {
        input.manifests[path].scripts[script] =
          `node ${localRuntime}/check-enketo.mjs`;
      },
      new RegExp(`scripts\\.${script}`),
    );
  }
}

for (const path of Object.keys(baseline.locks)) {
  const localRuntime = path.startsWith('service/')
    ? '../scripts/runtime'
    : 'scripts/runtime';
  for (const [key, entry] of [
    ['node_modules/enketo-core', { version: '0.0.0-synthetic' }],
    ['node_modules/innocent', { name: 'playwright-core', version: '0.0.0' }],
    ['node_modules/innocent', { version: 'npm:esbuild@0.0.0' }],
    ['node_modules/innocent', { resolved: localRuntime, link: true }],
    [
      'node_modules/innocent',
      {
        resolved:
          'https://registry.npmjs.org/enketo-transformer/-/enketo-transformer-0.0.0.tgz',
      },
    ],
    [
      'node_modules/ordinary/node_modules/enketo-core',
      { version: '0.0.0-synthetic' },
    ],
  ]) {
    rejectsMutation(
      `${path} rejects lock entry ${key} ${JSON.stringify(entry)}`,
      (input) => {
        input.locks[path].packages[key] = entry;
      },
      /package-lock\.json/,
    );
  }
  rejectsMutation(
    `${path} rejects nested dependency alias`,
    (input) => {
      input.locks[path].packages['node_modules/innocent'] = {
        dependencies: { helper: 'npm:enketo-core@9.0.1' },
      };
    },
    /package-lock\.json/,
  );
}

rejectsMutation(
  'root test discovery cannot expand recursively into optional probes',
  (input) => {
    input.manifests['package.json'].scripts.test = 'node --test scripts';
  },
  /root test discovery/,
);
for (const command of [
  'npm --prefix scripts/runtime ci',
  'node scripts/runtime/check-javarosa.mjs',
  'npx playwright-core install',
]) {
  rejectsMutation(
    `CI rejects runtime command ${command}`,
    (input) => {
      input.workflows['ci.yml'] += `\n      - run: ${command}\n`;
    },
    /ci\.yml: runtime tooling/,
  );
}
rejectsMutation(
  'CI rejects a repository-wide Docker context',
  (input) => {
    input.workflows['ci.yml'] = input.workflows['ci.yml'].replaceAll(
      './service',
      '.',
    );
  },
  /Docker build context/,
);
rejectsMutation(
  'CI must still discover the root tripwire',
  (input) => {
    input.workflows['ci.yml'] = input.workflows['ci.yml'].replace(
      'run: node --test scripts/*.test.mjs',
      'run: node --test scripts/form-model.test.mjs',
    );
  },
  /test discovery missing/,
);
for (const instruction of [
  'RUN npm install enketo-core',
  'COPY . .',
  'COPY ../scripts/runtime ./runtime',
  'ADD https://example.invalid/probes.tar.gz /app/',
]) {
  rejectsMutation(
    `container rejects ${instruction}`,
    (input) => {
      input.dockerfile += `\n${instruction}\n`;
    },
    /Dockerfile:/,
  );
}
for (const mutate of [
  (input) => {
    input.dockerignore = input.dockerignore.replace('node_modules', '');
  },
  (input) => {
    input.dockerignore += '\n!node_modules/**\n';
  },
  (input) => {
    input.dockerignore += '\n!*\n';
  },
]) {
  rejectsMutation(
    'container rejects weakened artifact exclusions',
    mutate,
    /\.dockerignore:/,
  );
}

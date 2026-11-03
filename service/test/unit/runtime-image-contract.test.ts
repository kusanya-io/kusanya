import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const sha256 =
  '92756ea4aed195355a07e5572f025f0921a31282387a870ae63e1f5cdf37e0c3';
const release =
  'https://github.com/getodk/validate/releases/download/v1.20.0/ODK-Validate-v1.20.0.jar';
const serviceRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
);

void test('runtime image pins and proves the only shipped validator artifact', async () => {
  const [dockerfile, notice, runtimeFiles, main] = await Promise.all([
    readFile(resolve(serviceRoot, 'Dockerfile'), 'utf8'),
    readFile(
      resolve(serviceRoot, 'runtime/ODK-Validate-v1.20.0-NOTICES.md'),
      'utf8',
    ),
    readdir(resolve(serviceRoot, 'runtime')),
    readFile(resolve(serviceRoot, 'src/main.ts'), 'utf8'),
  ]);

  assert.match(
    dockerfile,
    new RegExp(
      `ADD --checksum=sha256:${sha256} ${release.replaceAll('.', '\\.')}`,
    ),
  );
  assert.equal(
    (dockerfile.match(/ODK-Validate-v1\.20\.0\.jar/g) ?? []).length,
    6,
  );
  assert.match(dockerfile, /openjdk-17-jre-headless/);
  assert.match(dockerfile, /ODK_VALIDATE_JAVA_EXECUTABLE=\/usr\/bin\/java/);
  assert.match(
    dockerfile,
    /ODK_VALIDATE_JAR_PATH=\/opt\/kusanya\/ODK-Validate-v1\.20\.0\.jar/,
  );
  assert.match(
    dockerfile,
    /\/usr\/bin\/java -Xmx256m -Djava\.awt\.headless=true[\s\S]*odk-validate-smoke\.xml >\/dev\/null 2>&1/,
  );
  assert.ok(
    dockerfile.indexOf('odk-validate-smoke.xml >/dev/null') <
      dockerfile.lastIndexOf('USER node'),
  );
  assert.doesNotMatch(dockerfile, /\b(?:curl|wget|mvn|gradle|javac)\b/);
  assert.deepEqual(runtimeFiles.sort(), [
    'ODK-Validate-v1.20.0-NOTICES.md',
    'odk-validate-smoke.xml',
  ]);

  assert.match(notice, new RegExp(sha256));
  for (const component of [
    'JavaRosa',
    'kXML2',
    'Joda-Time',
    'Jackson',
    'Apache Commons CSV',
    'Apache Commons IO',
    'Kotlin standard library',
    'Bouncy Castle',
    'SLF4J',
    'JetBrains annotations',
    'QDox',
    'Hamcrest',
  ])
    assert.match(notice, new RegExp(component));

  const startupCheck = main.indexOf(
    'await assertOdkValidateRuntime(validateXForm)',
  );
  assert.ok(startupCheck >= 0);
  assert.ok(startupCheck < main.indexOf('const pool = createPostgresPool'));
  assert.ok(startupCheck < main.indexOf('app.listen'));
});

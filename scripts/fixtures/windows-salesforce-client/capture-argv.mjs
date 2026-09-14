// Synthetic-only argument capture. No Salesforce modules, auth, files or network.
const args = process.argv.slice(2);
if (args[0] !== 'fixture-only') {
  process.stdout.write('{"status":1,"name":"SyntheticFixtureInputRejected"}');
  process.exitCode = 1;
} else {
  process.stdout.write(JSON.stringify({ status: 0, result: { args } }));
}

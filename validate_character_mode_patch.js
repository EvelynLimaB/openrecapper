const fs = require('fs');
const ts = require('typescript');

const files = [
  '/mnt/data/character-mode-service.ts',
];

let failed = false;
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const result = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      strict: true,
    },
    reportDiagnostics: true,
    fileName: file,
  });
  const syntactic = (result.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error);
  if (syntactic.length) {
    failed = true;
    console.error(file);
    for (const d of syntactic) console.error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
  } else {
    console.log(`PASS syntax: ${file}`);
  }
}

const ps = fs.readFileSync('/mnt/data/apply_dm_character_mode.ps1', 'utf8');
const starts = (ps.match(/@'/g) || []).length;
const ends = (ps.match(/'@/g) || []).length;
if (starts !== ends) {
  failed = true;
  console.error(`FAIL PowerShell here-string balance: starts=${starts} ends=${ends}`);
} else {
  console.log(`PASS PowerShell here-string balance: ${starts}`);
}
if (ps.includes('@"') || ps.includes('"@')) {
  failed = true;
  console.error('FAIL: interpolating PowerShell here-string delimiter remains');
} else {
  console.log('PASS: no double-quoted PowerShell here-strings');
}
for (const required of [
  'git switch -c $branch',
  'git diff --check',
  'npm test',
  'npm run build',
  'git push -u origin $branch',
  'gh pr create --base main --head ',
]) {
  if (!ps.includes(required)) {
    failed = true;
    console.error(`FAIL missing workflow step: ${required}`);
  }
}

if (!failed) {
  console.log('PASS patch workflow checks');
  process.exit(0);
}
process.exit(1);

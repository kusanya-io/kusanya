# Run from Bill's normal authenticated PowerShell session if sandbox vault access fails.
# Opens a draft only; CI and independent verification still gate readiness/merge.
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
$branch = git branch --show-current
if ($LASTEXITCODE -ne 0 -or $branch -ne 'phase-0/repository-scaffold') { throw 'Expected the Phase 0 branch.' }
$changes = git status --porcelain
if ($LASTEXITCODE -ne 0 -or $changes) { throw 'Commit or resolve working-tree changes before publishing.' }
gh auth switch --hostname github.com --user cobitechsolutions
if ($LASTEXITCODE -ne 0) { throw 'Sign in to GitHub as cobitechsolutions using gh auth login, then retry. Do not paste tokens.' }
$account = gh api user --jq .login
if ($LASTEXITCODE -ne 0 -or $account -ne 'cobitechsolutions') { throw 'GitHub must authenticate as cobitechsolutions.' }
$author = git log -1 --format='%an <%ae>'
if ($author -ne 'Bill Owiti <cobitechsolutions@gmail.com>') { throw 'Unexpected commit author; check repository identity.' }
git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push --set-upstream origin phase-0/repository-scaffold
if ($LASTEXITCODE -ne 0) { throw 'Push failed; no PR was created.' }
$existing = gh pr list --repo kusanya-io/kusanya --head phase-0/repository-scaffold --state open --json url | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Could not check for an existing PR.' }
if ($existing.Count -gt 0) { $existing | Select-Object -ExpandProperty url; exit 0 }
gh pr create --repo kusanya-io/kusanya --base main --head phase-0/repository-scaffold --draft --title 'Phase 0: repository scaffold and verification foundation (C11)' --body-file docs/reviews/phase-0-pr.md
if ($LASTEXITCODE -ne 0) { throw 'PR creation failed; branch remains pushed for retry.' }

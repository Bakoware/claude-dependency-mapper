# Installs the claude-dependency-mapper skill into your Claude Code skills directory
# (without using the plugin system). Run from inside the cloned/extracted repo:  ./install.ps1
$ErrorActionPreference = 'Stop'
$src  = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'skills\claude-dependency-mapper'
$dest = Join-Path $HOME '.claude\skills\claude-dependency-mapper'
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item (Join-Path $src 'SKILL.md')      $dest -Force
Copy-Item (Join-Path $src 'gen-graph.mjs') $dest -Force
Write-Host "Installed to: $dest"
Write-Host "Run /claude-dependency-mapper inside a project (start a new Claude Code session if one was open)."

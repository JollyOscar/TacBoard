param(
	[ValidateSet('setup', 'status', 'vars', 'deploy', 'health')]
	[string]$Action = 'setup',
	[string]$BaseUrl = ''
)

Set-Location "$PSScriptRoot"

function Run-RailwayCommand {
	param([string]$Command)
	Write-Host "> railway $Command" -ForegroundColor Cyan
	railway $Command
	if ($LASTEXITCODE -ne 0) {
		throw "Railway command failed: railway $Command"
	}
}

switch ($Action) {
	'setup' {
		Run-RailwayCommand 'login'
		Run-RailwayCommand 'link'
		Run-RailwayCommand 'status'
		Run-RailwayCommand 'variables'
	}
	'status' {
		Run-RailwayCommand 'status'
	}
	'vars' {
		Run-RailwayCommand 'variables'
	}
	'deploy' {
		Run-RailwayCommand 'up'
	}
	'health' {
		if (-not [string]::IsNullOrWhiteSpace($BaseUrl)) {
			$env:PUBLIC_BASE_URL = $BaseUrl
		}
		npm run railway:health
		if ($LASTEXITCODE -ne 0) {
			throw 'Railway health check failed'
		}
	}
}

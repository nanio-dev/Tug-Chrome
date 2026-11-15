$ErrorActionPreference = 'Stop'
$downloadCopy = $null

function Quote-CurlConfig([string] $Value) {
    if ($Value.IndexOfAny([char[]]"`r`n`0") -ge 0) {
        throw 'Invalid newline or NUL in FTP configuration.'
    }
    '"' + $Value.Replace('\', '\\').Replace('"', '\"') + '"'
}

function Get-Sha256([string] $Path) {
    # Use .NET directly so verification also works without Get-FileHash modules.
    $stream = [IO.File]::OpenRead($Path)
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try { [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '') }
    finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}

function Invoke-CurlConfig([string[]] $Options) {
    # Bypass PowerShell's native pipeline encoding, which can prepend a BOM.
    # .NET Framework also derives its stdin writer encoding from Console.InputEncoding.
    $originalInputEncoding = [Console]::InputEncoding
    [Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = (Get-Command curl.exe -ErrorAction Stop).Source
    $start.Arguments = '--config -'
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $start
    try {
        $null = $process.Start()
        $encoding = New-Object System.Text.UTF8Encoding($false)
        $bytes = $encoding.GetBytes(($Options -join "`n") + "`n")
        $inputStream = $process.StandardInput.BaseStream
        $inputStream.Write($bytes, 0, $bytes.Length)
        $inputStream.Close()
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) {
            throw "curl failed with exit code $($process.ExitCode). See the error above."
        }
    }
    finally {
        $process.Dispose()
        [Console]::InputEncoding = $originalInputEncoding
    }
}

try {
    Push-Location -LiteralPath $PSScriptRoot
    try {
        Get-Command curl.exe -ErrorAction Stop | Out-Null
        if (-not $env:NANIO_FTP_TUG_USER -or -not $env:NANIO_FTP_TUG_PASSWORD) {
            throw 'FTP credentials are missing. Run push.bat or set NANIO_FTP_TUG_USER and NANIO_FTP_TUG_PASSWORD.'
        }

        & $env:ComSpec /d /c 'call build.bat --no-pause'
        if ($LASTEXITCODE -ne 0) { throw 'Build failed. Nothing was uploaded.' }

        $agentPath = Join-Path $PSScriptRoot 'tug-agent.exe'
        if (-not (Test-Path -LiteralPath $agentPath -PathType Leaf) -or (Get-Item -LiteralPath $agentPath).Length -eq 0) {
            throw 'Build did not produce a nonempty tug-agent.exe. Nothing was uploaded.'
        }

        # Credentials go through stdin, never the curl command line or a config file.
        # STOR overwrites this one path. Only its downloads parent may be created.
        # No delete, mirror, or rename commands are sent.
        $config = @(
            'silent', 'show-error', 'fail',
            'connect-timeout = 15', 'max-time = 600',
            ('user = ' + (Quote-CurlConfig ($env:NANIO_FTP_TUG_USER + ':' + $env:NANIO_FTP_TUG_PASSWORD))),
            'url = "ftp://nanio.cc:21/downloads/tug-agent.exe"'
        )
        Write-Host '[Tug Agent] Overwriting downloads/tug-agent.exe ...'
        Invoke-CurlConfig ($config + 'ftp-create-dirs' + ('upload-file = ' + (Quote-CurlConfig $agentPath)))

        $downloadCopy = [IO.Path]::GetTempFileName()
        Write-Host '[Tug Agent] Reading back the uploaded file for SHA-256 verification ...'
        Invoke-CurlConfig ($config + ('output = ' + (Quote-CurlConfig $downloadCopy)))
        $localHash = Get-Sha256 $agentPath
        if ($localHash -ne (Get-Sha256 $downloadCopy)) {
            throw 'Uploaded file SHA-256 does not match the local executable.'
        }
        Write-Host '[OK] Published and SHA-256 verified: https://tug.nanio.cc/downloads/tug-agent.exe'
        Write-Host "SHA-256: $localHash"
    }
    finally { Pop-Location }
}
catch {
    [Console]::Error.WriteLine('[ERROR] ' + $_.Exception.Message)
    exit 1
}
finally {
    if ($downloadCopy -and (Test-Path -LiteralPath $downloadCopy)) {
        Remove-Item -LiteralPath $downloadCopy -Force
    }
}
exit 0

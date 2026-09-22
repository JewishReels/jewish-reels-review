param(
  [Parameter(Mandatory = $true)][string]$PackagePath,
  [Parameter(Mandatory = $true)][string]$CertificatePath
)

$ErrorActionPreference = 'Stop'
$PackagePath = [IO.Path]::GetFullPath($PackagePath)
$CertificatePath = [IO.Path]::GetFullPath($CertificatePath)
if (-not (Test-Path -LiteralPath $PackagePath -PathType Leaf)) { throw "MSIX package not found: $PackagePath" }
if (-not (Test-Path -LiteralPath $CertificatePath -PathType Leaf)) { throw "Signing certificate not found: $CertificatePath" }

$certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($CertificatePath)
if ($certificate.Subject -ne 'CN=Jewish Reels Local Development') {
  throw "Unexpected signing certificate subject: $($certificate.Subject)"
}
if (-not ($certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' -and $_.Format($false) -match 'Code Signing|1\.3\.6\.1\.5\.5\.7\.3\.3' })) {
  throw 'The supplied certificate is not limited to code-signing use.'
}
$packageSignature = Get-AuthenticodeSignature -LiteralPath $PackagePath
if (-not $packageSignature.SignerCertificate -or $packageSignature.SignerCertificate.Thumbprint -ne $certificate.Thumbprint) {
  throw 'The MSIX package was not signed by the supplied Jewish Reels certificate.'
}
$alreadyTrusted = Get-ChildItem -Path Cert:\LocalMachine\TrustedPeople |
  Where-Object Thumbprint -eq $certificate.Thumbprint |
  Select-Object -First 1
if (-not $alreadyTrusted) {
  Import-Certificate -FilePath $CertificatePath -CertStoreLocation Cert:\LocalMachine\TrustedPeople | Out-Null
}

$trustedSignature = Get-AuthenticodeSignature -LiteralPath $PackagePath
if ($trustedSignature.Status -ne 'Valid') {
  throw "The MSIX signature did not validate after installing the public certificate: $($trustedSignature.StatusMessage)"
}

Add-AppxPackage -Path $PackagePath -ForceApplicationShutdown
$startApp = Get-StartApps | Where-Object Name -eq 'Jewish Reels' | Select-Object -First 1
if (-not $startApp) { throw 'Jewish Reels was installed, but Windows did not publish its Start application identity.' }

$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop 'Jewish Reels.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:WINDIR 'explorer.exe'
$shortcut.Arguments = "shell:AppsFolder\$($startApp.AppID)"
$shortcut.WorkingDirectory = $env:WINDIR
$shortcut.Description = 'Launch the locally signed Jewish Reels app package'
$shortcut.Save()

Start-Process explorer.exe -ArgumentList "shell:AppsFolder\$($startApp.AppID)"
[pscustomobject]@{ AppId = $startApp.AppID; Shortcut = $shortcutPath; CertificateThumbprint = $certificate.Thumbprint }

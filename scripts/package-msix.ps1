param(
  [string]$AppDirectory,
  [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $sourceRoot 'package.json') -Raw | ConvertFrom-Json
$versionParts = ([string]$package.version).Split('.')
if ($versionParts.Count -ne 3 -or @($versionParts | Where-Object { $_ -notmatch '^\d+$' }).Count -ne 0) {
  throw "package.json version must contain exactly three numeric components."
}
$msixVersion = "$($versionParts[0]).$($versionParts[1]).$($versionParts[2]).0"
$workspaceRoot = Split-Path -Parent $sourceRoot
$defaultOutputs = Join-Path (Split-Path -Parent $workspaceRoot) 'outputs'
if (-not $AppDirectory) {
  $AppDirectory = Join-Path $defaultOutputs "Jewish Reels-$($package.version)-win32-x64"
}
if (-not $OutputDirectory) {
  $OutputDirectory = Join-Path $defaultOutputs 'local-msix'
}
$AppDirectory = [IO.Path]::GetFullPath($AppDirectory)
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$appExecutable = Join-Path $AppDirectory 'Jewish Reels.exe'
if (-not (Test-Path -LiteralPath $appExecutable -PathType Leaf)) {
  throw "Packaged application not found at $appExecutable. Run npm run package first."
}

$windowsKits = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
$makeAppx = Get-ChildItem -LiteralPath $windowsKits -Filter makeappx.exe -Recurse |
  Where-Object { $_.FullName -match '\\x64\\makeappx\.exe$' } |
  Sort-Object { [version]$_.Directory.Parent.Name } -Descending |
  Select-Object -First 1
$signTool = Get-ChildItem -LiteralPath $windowsKits -Filter signtool.exe -Recurse |
  Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
  Sort-Object { [version]$_.Directory.Parent.Name } -Descending |
  Select-Object -First 1
if (-not $makeAppx -or -not $signTool) {
  throw 'The Windows SDK MakeAppx and SignTool utilities are required.'
}

$certificateSubject = 'CN=Jewish Reels Local Development'
$certificate = Get-ChildItem -Path Cert:\CurrentUser\My |
  Where-Object {
    $_.Subject -eq $certificateSubject -and
    $_.HasPrivateKey -and
    $_.NotAfter -gt (Get-Date).AddDays(30) -and
    ($_.EnhancedKeyUsageList.ObjectId -contains '1.3.6.1.5.5.7.3.3')
  } |
  Sort-Object NotAfter -Descending |
  Select-Object -First 1
if (-not $certificate) {
  $certificate = New-SelfSignedCertificate `
    -Type Custom `
    -Subject $certificateSubject `
    -FriendlyName 'Jewish Reels local MSIX signing' `
    -CertStoreLocation 'Cert:\CurrentUser\My' `
    -KeyAlgorithm RSA `
    -KeyLength 3072 `
    -HashAlgorithm SHA256 `
    -KeyUsage DigitalSignature `
    -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3', '2.5.29.19={critical}{text}ca=0') `
    -NotAfter (Get-Date).AddYears(2)
}

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$certificatePath = Join-Path $OutputDirectory 'Jewish-Reels-local-signing.cer'
Export-Certificate -Cert $certificate -FilePath $certificatePath -Force | Out-Null
$msixPath = Join-Path $OutputDirectory "Jewish-Reels-$($package.version)-local.msix"
$manifestPath = Join-Path $AppDirectory 'AppxManifest.xml'
$assetsPath = Join-Path $AppDirectory 'Assets'
$addedAssets = -not (Test-Path -LiteralPath $assetsPath)
$addedManifest = -not (Test-Path -LiteralPath $manifestPath)
if (-not $addedManifest) {
  throw "Refusing to overwrite existing package manifest at $manifestPath."
}
if (-not $addedAssets) {
  throw "Refusing to overwrite existing package assets at $assetsPath."
}

$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:uap10="http://schemas.microsoft.com/appx/manifest/uap/windows10/10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap uap10 rescap">
  <Identity Name="JewishReels.ArchiveReview" Publisher="$certificateSubject" Version="$msixVersion" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>Jewish Reels</DisplayName>
    <PublisherDisplayName>Jewish Reels</PublisherDisplayName>
    <Description>Archive footage preparation and visual review</Description>
    <Logo>Assets\icon.png</Logo>
  </Properties>
  <Resources>
    <Resource Language="en-us" />
  </Resources>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.26200.0" />
  </Dependencies>
  <Capabilities>
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
  <Applications>
    <Application Id="JewishReels" Executable="Jewish Reels.exe" uap10:RuntimeBehavior="packagedClassicApp" uap10:TrustLevel="mediumIL">
      <uap:VisualElements DisplayName="Jewish Reels" Description="Archive footage preparation and visual review" Square150x150Logo="Assets\icon.png" Square44x44Logo="Assets\icon.png" BackgroundColor="transparent" />
    </Application>
  </Applications>
</Package>
"@

try {
  New-Item -ItemType Directory -Path $assetsPath -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $sourceRoot 'assets\icon.png') -Destination (Join-Path $assetsPath 'icon.png')
  [IO.File]::WriteAllText($manifestPath, $manifest, [Text.UTF8Encoding]::new($false))
  & $makeAppx.FullName pack /d $AppDirectory /p $msixPath /o
  if ($LASTEXITCODE -ne 0) { throw "MakeAppx failed with exit code $LASTEXITCODE." }
  & $signTool.FullName sign /fd SHA256 /sha1 $certificate.Thumbprint /s My $msixPath
  if ($LASTEXITCODE -ne 0) { throw "SignTool failed with exit code $LASTEXITCODE." }
  $embeddedSignature = Get-AuthenticodeSignature -LiteralPath $msixPath
  if (-not $embeddedSignature.SignerCertificate -or $embeddedSignature.SignerCertificate.Thumbprint -ne $certificate.Thumbprint) {
    throw 'The MSIX package does not contain the expected signing certificate.'
  }
}
finally {
  if ($addedManifest -and (Test-Path -LiteralPath $manifestPath)) { Remove-Item -LiteralPath $manifestPath -Force }
  if ($addedAssets -and (Test-Path -LiteralPath $assetsPath)) { Remove-Item -LiteralPath $assetsPath -Recurse -Force }
}

[pscustomobject]@{
  Package = $msixPath
  Certificate = $certificatePath
  CertificateThumbprint = $certificate.Thumbprint
  Publisher = $certificate.Subject
  Version = $msixVersion
}

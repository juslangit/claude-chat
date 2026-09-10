# Set up claude-chat on a Windows PC, so your iPhone can use Claude Code on it too.
#
# On that PC: install Tailscale (https://tailscale.com/download/windows) and sign in with the same
# account as your iPhone. Then open PowerShell and paste:
#
#   irm __HOME_URL__/setup/windows | iex
#
# claude-chat needs tmux, which only runs on Linux and Mac, so Claude Code runs inside WSL (Windows'
# built-in Linux). Your projects stay in a normal Windows folder — Desktop\project — so Unreal,
# Blender and other Windows apps open them directly. Safe to run again.

$ErrorActionPreference = "Stop"
$HomeUrl = "__HOME_URL__"   # your main Mac, filled in when this script is downloaded from it
function Step($t) { Write-Host "`n==> $t" -ForegroundColor Green }
function Say($t) { Write-Host "    $t" }

Step "Checking Tailscale"
$ts = "C:\Program Files\Tailscale\tailscale.exe"
if (-not (Test-Path $ts)) { Say "Install Tailscale, sign in with the same account as your iPhone, then run this again."; return }
try { Invoke-RestMethod "$HomeUrl/api/whoami" -TimeoutSec 10 | Out-Null }
catch { Say "Can't reach your main Mac at $HomeUrl. Is Tailscale signed in here, and is the Mac on?"; return }
Say "Main Mac found."

Step "WSL (Windows' built-in Linux)"
$distros = @((wsl.exe -l -q 2>$null) -replace "`0", "" | Where-Object { $_ -match "^Ubuntu" })
if ($distros.Count -eq 0) {
  Say "Installing Ubuntu. Windows asks for permission, then needs a restart."
  Start-Process wsl.exe -ArgumentList "--install -d Ubuntu" -Verb RunAs -Wait
  Say "Restart the PC. Ubuntu opens by itself and asks you to pick a Linux username and password."
  Say "After that, run this same command again."
  return
}
$distro = $distros[0].Trim()
Say "Using $distro."

Step "Project folder"
$desktop = [Environment]::GetFolderPath("Desktop")
# A Desktop kept in OneDrive would sync the code too, which breaks git — use your home folder then.
$projects = if ($desktop -match "OneDrive") { Join-Path $env:USERPROFILE "project" } else { Join-Path $desktop "project" }
New-Item -ItemType Directory -Force $projects | Out-Null
$wslProjects = (wsl.exe -d $distro -e wslpath -a ($projects -replace '\\', '/')).Trim()
Say "$projects  (Linux sees it as $wslProjects)"

Step "The Linux half: tools, Claude Code, your projects, claude-chat, Syncthing"
$work = Join-Path $env:TEMP "claude-chat-setup"
New-Item -ItemType Directory -Force $work | Out-Null
Invoke-WebRequest "$HomeUrl/setup/wsl" -OutFile "$work\wsl.sh" -UseBasicParsing
# The project list comes from the main Mac here on Windows, where Tailscale's names always work.
(Invoke-RestMethod "$HomeUrl/api/projects") | Where-Object { $_.remote } | ForEach-Object { "$($_.name) $($_.remote)" } |
  Set-Content "$work\projects.txt"
$wslWork = (wsl.exe -d $distro -e wslpath -a ($work -replace '\\', '/')).Trim()
wsl.exe -d $distro -e bash "$wslWork/wsl.sh" install "$wslProjects" "$wslWork" "$env:COMPUTERNAME"
if ($LASTEXITCODE -ne 0) { Say "The Linux half stopped with an error (see above). Fix it, then run this again."; return }

Step "Your Claude setup: instructions, settings, keys, memory tool, notes (Syncthing)"
$myId = (Get-Content "$work\sync-id.txt").Trim()
if ($myId -eq "PAIRED") {
  Say "Already paired with the main Mac."
} else {
  $code = Read-Host "    Pairing code from your iPhone (Chats -> ... -> Computers -> Add a computer)"
  try {
    $pair = Invoke-RestMethod "$HomeUrl/api/sync/pair" -Method Post -ContentType "application/json" `
      -Body (@{ id = $myId; name = $env:COMPUTERNAME; code = $code } | ConvertTo-Json)
  } catch {
    Say "Pairing didn't work: $($_.ErrorDetails.Message)"
    Say "Get a new code on your iPhone and run this again."
    return
  }
  wsl.exe -d $distro -e bash "$wslWork/wsl.sh" pair $pair.id
  Say "Paired. Your setup arrives from the main Mac within a minute or two."
}

Step "Start claude-chat whenever you log in"
$action = New-ScheduledTaskAction -Execute "conhost.exe" -Argument "--headless wsl.exe -d $distro -e bash -lc ~/.claude-chat/start.sh"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName "claude-chat" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName "claude-chat"
Start-Sleep -Seconds 6

Step "Publishing on your Tailscale network"
& $ts serve --bg 4477

Step "Done"
Say "This PC ($env:COMPUTERNAME) now shows on your iPhone: Chats -> ... -> Computers."
Say "Last step, once: log in to Claude Code and trust your project folder."
Say "Open 'Ubuntu' from the Start menu and paste:"
Say "    cd '$wslProjects' && claude"
Say "Log in, choose 'Yes, I trust this folder', then type /exit."

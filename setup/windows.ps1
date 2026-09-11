# Set up claude-chat on a Windows PC, so your iPhone can use Claude Code on it.
#
# First install Tailscale (https://tailscale.com/download/windows) and sign in — the same account on the
# PC and the iPhone. Then open PowerShell (no need for administrator) and paste one of these:
#
#   your first computer:     irm https://raw.githubusercontent.com/juslangit/claude-chat/main/setup/windows.ps1 | iex
#   adding another computer: irm __HOME_URL__/setup/windows | iex
#                            (your iPhone shows this line: Chats -> ... -> Computers -> Add a computer)
#
# claude-chat needs tmux, which only runs on Linux and Mac, so Claude Code runs inside WSL (Windows'
# built-in Linux). Your projects stay in a normal Windows folder — Desktop\project — so Unreal,
# Blender and other Windows apps open them directly. Safe to run again.

$ErrorActionPreference = "Stop"
$HomeUrl = "__HOME_URL__"   # filled in when this script is downloaded from one of your computers
$Repo = "https://github.com/juslangit/claude-chat.git"
$Raw = "https://raw.githubusercontent.com/juslangit/claude-chat/main/setup"
# Straight from GitHub, the address above is never filled in: this is your first computer, with nothing to
# join. (Checked by its shape — the line that fills it in replaces every copy of the placeholder.)
$First = -not ($HomeUrl -like "https://*")
function Step($t) { Write-Host "`n==> $t" -ForegroundColor Green }
function Say($t) { Write-Host "    $t" }
$ts = "C:\Program Files\Tailscale\tailscale.exe"
# Tailscale's own report on itself, or nothing. Read from its JSON rather than its exit code: Windows
# PowerShell turns anything a program prints as an error into a stop, with the preference set above.
function TailscaleStatus { try { & $ts status --json 2>$null | Out-String | ConvertFrom-Json } catch { $null } }

Step "Checking Tailscale"
if (-not (Test-Path $ts)) { Say "Install Tailscale, sign in with the same account as your iPhone, then run this again."; return }
if ($First) {
  if ((TailscaleStatus).BackendState -ne "Running") { Say "Tailscale isn't signed in on this PC yet. Sign in (the same account as on your iPhone), then run this again."; return }
  Say "Tailscale is on. This will be your first claude-chat computer."
} else {
  try { Invoke-RestMethod "$HomeUrl/api/whoami" -TimeoutSec 10 | Out-Null }
  catch { Say "Can't reach your other computer at $HomeUrl. Is Tailscale signed in here, and is that computer on?"; return }
  Say "Your other computer found."
}

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

Step "The Linux half: tools, Claude Code, claude-chat$(if (-not $First) { ', your projects, Syncthing' })"
$work = Join-Path $env:TEMP "claude-chat-setup"
New-Item -ItemType Directory -Force $work | Out-Null
if ($First) {
  Invoke-WebRequest "$Raw/wsl.sh" -OutFile "$work\wsl.sh" -UseBasicParsing
  # Nothing to copy from another computer yet: the only project is claude-chat itself.
  "claude-chat`t$Repo" | Set-Content "$work\projects.txt"
  $mode = "first"
} else {
  Invoke-WebRequest "$HomeUrl/setup/wsl" -OutFile "$work\wsl.sh" -UseBasicParsing
  # The project list comes from the other computer here on Windows, where Tailscale's names always work.
  (Invoke-RestMethod "$HomeUrl/api/projects") | Where-Object { $_.remote } | ForEach-Object { "$($_.name)`t$($_.remote)" } |
    Set-Content "$work\projects.txt"
  $mode = "join"
}
$wslWork = (wsl.exe -d $distro -e wslpath -a ($work -replace '\\', '/')).Trim()
wsl.exe -d $distro -e bash "$wslWork/wsl.sh" install "$wslProjects" "$wslWork" "$env:COMPUTERNAME" $mode
if ($LASTEXITCODE -ne 0) { Say "The Linux half stopped with an error (see above). Fix it, then run this again."; return }

if (-not $First) {
  Step "Your Claude setup: instructions, settings, keys, notes (Syncthing)"
  $myId = (Get-Content "$work\sync-id.txt").Trim()
  if ($myId -eq "PAIRED") {
    Say "Already paired with your other computer."
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
    Say "Paired. Your setup arrives from your other computer within a minute or two."
  }
}

Step "Start claude-chat whenever you log in"
$action = New-ScheduledTaskAction -Execute "conhost.exe" -Argument "--headless wsl.exe -d $distro -e bash -lc ~/.claude-chat/start.sh"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName "claude-chat" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName "claude-chat"
Start-Sleep -Seconds 6

Step "Publishing on your Tailscale network"
Say "The first time, Tailscale may show a link to switch on HTTPS for your network: open it, press Enable, and it carries on."
& $ts serve --bg 4477

Step "Done"
if ($First) {
  $address = "https://" + ((TailscaleStatus).Self.DNSName -replace '\.$', '')
  Say "Two last steps."
  Say ""
  Say "1. Once, log in to Claude Code and trust your project folder."
  Say "   Open 'Ubuntu' from the Start menu and paste:"
  Say "       cd '$wslProjects' && ~/.local/bin/claude"
  Say "   Log in, choose 'Yes, I trust this folder', then type /exit."
  Say ""
  Say "2. On your iPhone, open this address in Safari, then Share -> Add to Home Screen:"
  Say "       $address"
} else {
  Say "This PC ($env:COMPUTERNAME) now shows on your iPhone: Chats -> ... -> Computers."
  Say "Last step, once: log in to Claude Code and trust your project folder."
  Say "Open 'Ubuntu' from the Start menu and paste:"
  Say "    cd '$wslProjects' && ~/.local/bin/claude"
  Say "Log in, choose 'Yes, I trust this folder', then type /exit."
}

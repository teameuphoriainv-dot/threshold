#!/bin/zsh
# Launcher for the WHISPERS Warden as a persistent service (used by the launchd
# LaunchAgent so the adversary stays alive independent of any terminal/session).
export PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
cd "$HOME/threshold-audit/warden" || exit 1
exec npm start

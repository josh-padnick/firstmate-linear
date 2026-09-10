/** Runs copied upstream scripts with synthetic task data and a non-executing terminal. */
export const briefPrepare = String.raw`set -eu
root=$1
home=$2
task=$FM_LINEAR_PROBE_TASK
mkdir -p "$home/data" "$home/state" "$home/config" "$home/projects" "$home/fakebin" "$home/project" "$home/user"
printf manual > "$home/config/backlog-backend"
printf claude > "$home/config/crew-harness"
touch "$home/state/.last-watcher-beat"
export HOME="$home/user" FM_HOME="$home" FM_STATE_OVERRIDE="$home/state" FM_CONFIG_OVERRIDE="$home/config" FM_DATA_OVERRIDE="$home/data" FM_PROJECTS_OVERRIDE="$home/projects"
export FM_ROOT_OVERRIDE="$root" FM_SPAWN_NO_GUARD=1 FM_GATE_REFUSE_BYPASS=1 TMUX=fake,1,0
export GIT_AUTHOR_NAME=Fixture GIT_AUTHOR_EMAIL=fixture@example.invalid GIT_COMMITTER_NAME=Fixture GIT_COMMITTER_EMAIL=fixture@example.invalid
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
git init -q "$home/project"
git -C "$home/project" commit --allow-empty -qm initial
git -C "$home/project" worktree add -qb fixture "$home/worktree"
cat > "$home/fakebin/tmux" <<'SH'
#!/bin/sh
case "$*" in *'#{pane_current_path}'*) printf '%s\n' "$FM_FAKE_PANE_PATH"; exit 0;; esac
case "$1" in display-message) echo firstmate;; list-windows) :;; send-keys) printf '%s\n' "$*" >> "$FM_FAKE_LAUNCH_LOG";; esac
exit 0
SH
cat > "$home/fakebin/claude" <<'SH'
#!/bin/sh
printf 'forbidden-agent-launch\n' >> "$FM_FAKE_LAUNCH_LOG"
exit 90
SH
for tool in treehouse gh gh-axi; do printf '#!/bin/sh\nexit 0\n' > "$home/fakebin/$tool"; done
cat > "$home/fakebin/no-mistakes" <<'SH'
#!/bin/sh
if [ "$1" = --version ]; then echo 'no-mistakes version v1.46.0'; fi
exit 0
SH
chmod +x "$home/fakebin/"*
export PATH="$home/fakebin:$PATH" FM_FAKE_PANE_PATH="$home/worktree" FM_FAKE_LAUNCH_LOG="$home/launch.log"
"$root/bin/fm-brief.sh" $task project --mode local-only >/dev/null
# Fill the authored placeholders exactly as Firstmate does, then preserve the scaffold.
python3 - "$home/data/$task/brief.md" <<'PY'
import sys
p=sys.argv[1]
s=open(p).read().replace('{TASK}', 'Preserve captain intent.').replace('{FIRSTMATE_SPEC}', 'Complete the isolated fixture.')
open(p,'w').write(s)
PY
`;

export const briefLaunch = String.raw`set -eu
root=$1
home=$2
task=$FM_LINEAR_PROBE_TASK
export HOME="$home/user" FM_HOME="$home" FM_STATE_OVERRIDE="$home/state" FM_CONFIG_OVERRIDE="$home/config" FM_DATA_OVERRIDE="$home/data" FM_PROJECTS_OVERRIDE="$home/projects"
export FM_ROOT_OVERRIDE="$root" FM_SPAWN_NO_GUARD=1 FM_GATE_REFUSE_BYPASS=1 TMUX=fake,1,0
export GIT_AUTHOR_NAME=Fixture GIT_AUTHOR_EMAIL=fixture@example.invalid GIT_COMMITTER_NAME=Fixture GIT_COMMITTER_EMAIL=fixture@example.invalid
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export PATH="$home/fakebin:$PATH" FM_FAKE_PANE_PATH="$home/worktree" FM_FAKE_LAUNCH_LOG="$home/launch.log"
cp "$home/data/$task/brief.md" "$home/authored-before.md"
if "$root/bin/fm-brief.sh" $task project --mode local-only >/dev/null 2>&1; then exit 41; fi
cmp "$home/authored-before.md" "$home/data/$task/brief.md"
"$root/bin/fm-spawn.sh" $task "$home/project" --mode local-only --yolo off >/dev/null
cmp "$home/authored-before.md" "$home/data/$task/brief.md"
grep -q '^spawn_gen=' "$home/state/$task.meta"
if grep -q forbidden-agent-launch "$home/launch.log"; then exit 42; fi
printf 'brief-contract-passed\n'
`;

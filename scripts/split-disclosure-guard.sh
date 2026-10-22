#!/usr/bin/env bash
# Export packages/disclosure-guard as its own repository (Open Source mini challenge).
#
# Two modes. Neither one pushes, adds a remote or changes the current branch.
#
#   scripts/split-disclosure-guard.sh                 # history mode (default)
#       git subtree split --prefix=packages/disclosure-guard into a local branch
#       (default name: disclosure-guard-split, override with SPLIT_BRANCH=...).
#       Only committed changes are included; exits with an error if the package
#       has uncommitted or untracked files (set FORCE=1 to split anyway).
#
#   scripts/split-disclosure-guard.sh <target-dir>    # copy mode
#       Copies the package's tracked and untracked (not ignored) files into
#       <target-dir> and runs git init there. It does not commit.
#       <target-dir> must not exist or must be empty.
#
# Afterwards it prints the manual commands to create the GitHub repo and push.
set -euo pipefail

PREFIX="packages/disclosure-guard"
SPLIT_BRANCH="${SPLIT_BRANCH:-disclosure-guard-split}"
REPO_NAME="${REPO_NAME:-disclosure-guard}"

ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$ROOT"

[ -f "$PREFIX/package.json" ] || { echo "error: $PREFIX/package.json not found" >&2; exit 1; }

print_next_steps() {
  local where="$1"
  cat <<EOF

Next steps (manual; nothing has been pushed):

  1. Create an empty public repository named '$REPO_NAME' on GitHub
     (no README, no license, no .gitignore), for example:
       gh repo create $REPO_NAME --public --description "Code-level disclosure guard for LLM voice agents"
  2. Push:
$where
  3. Replace the <REPO_URL> and <STANDIN_REPO_URL> placeholders in package.json and README.md,
     commit, and push again. Check that the CI workflow passes on GitHub.
  4. Optional: npm publish --access public   (requires access to the @standin npm scope)
EOF
}

if [ "$#" -eq 0 ]; then
  if ! git diff --quiet HEAD -- "$PREFIX" || [ -n "$(git ls-files --others --exclude-standard -- "$PREFIX")" ]; then
    if [ "${FORCE:-}" = "1" ]; then
      echo "warning: $PREFIX has uncommitted or untracked files; FORCE=1, exporting committed files only." >&2
    else
      echo "error: $PREFIX has uncommitted or untracked files; history mode only exports committed files," >&2
      echo "       so the split repo could miss its standalone tsconfig, CI or lockfile." >&2
      echo "       Commit first, use copy mode ($0 <target-dir>), or set FORCE=1." >&2
      exit 1
    fi
  fi
  if git show-ref --verify --quiet "refs/heads/$SPLIT_BRANCH"; then
    echo "error: branch '$SPLIT_BRANCH' already exists. Delete it (git branch -D $SPLIT_BRANCH) or set SPLIT_BRANCH." >&2
    exit 1
  fi
  echo "Splitting $PREFIX history into local branch '$SPLIT_BRANCH' ..."
  git subtree split -q --prefix="$PREFIX" --branch "$SPLIT_BRANCH" >/dev/null
  echo "Done: $(git rev-list --count "$SPLIT_BRANCH") commit(s) on '$SPLIT_BRANCH' (tip $(git rev-parse --short "$SPLIT_BRANCH"))."
  echo "Files at the tip:"
  git ls-tree --name-only "$SPLIT_BRANCH" | sed 's/^/  /'
  print_next_steps "       git remote add $REPO_NAME <REPO_URL>.git
       git push $REPO_NAME $SPLIT_BRANCH:main"
  exit 0
fi

TARGET="$1"
if [ -e "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ]; then
  echo "error: $TARGET exists and is not empty" >&2
  exit 1
fi
mkdir -p "$TARGET"
TARGET="$(cd "$TARGET" && pwd)"

echo "Copying $PREFIX to $TARGET ..."
# Tracked plus untracked-but-not-ignored files: no node_modules, dist or .env.
git ls-files -z --cached --others --exclude-standard -- "$PREFIX" |
  while IFS= read -r -d '' f; do
    [ -f "$f" ] || continue # skip files deleted in the working tree
    rel="${f#"$PREFIX"/}"
    mkdir -p "$TARGET/$(dirname "$rel")"
    cp -p "$f" "$TARGET/$rel"
  done

git -C "$TARGET" init -q -b main
echo "Done: $(find "$TARGET" -type f -not -path '*/.git/*' | wc -l | tr -d ' ') files copied to $TARGET (git initialised, nothing committed)"
echo "Check it: cd \"$TARGET\" && npm install && npm run build && npm test"
print_next_steps "       cd \"$TARGET\"
       npm install            # creates package-lock.json if it is missing; commit it
       git add -A && git commit -m \"Initial import of disclosure-guard from Stand-In\"
       git remote add origin <REPO_URL>.git
       git push -u origin main"

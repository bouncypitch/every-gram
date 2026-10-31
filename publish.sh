#!/bin/zsh
# Publishes the current web/dist to https://bouncypitch.github.io/every-gram/
set -e
cd ~/Code/every-gram
(cd web && npm run build)
if ! git grep -qE 'sk-ant-|fc-[0-9a-f]{20,}' -- . ':!publish.sh' && ! grep -rqE 'sk-ant-|fc-[0-9a-f]{20,}' web/dist; then echo "secret scan clean"; else echo "SECRET FOUND, stopping"; exit 1; fi
git remote get-url origin >/dev/null 2>&1 || gh repo create bouncypitch/every-gram --public --source=. --remote=origin
git push -u origin main
P=$(mktemp -d); cp -R web/dist/. $P/; touch $P/.nojekyll
(cd $P && git init -q -b gh-pages && git add -A && git commit -q -m "Publish site" && git push -q -f https://github.com/bouncypitch/every-gram.git gh-pages)
gh api -X POST repos/bouncypitch/every-gram/pages -f 'source[branch]=gh-pages' -f 'source[path]=/' >/dev/null 2>&1 || true
echo "Published: https://bouncypitch.github.io/every-gram/ (allow about a minute)"

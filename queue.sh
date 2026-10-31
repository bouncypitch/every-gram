#!/bin/zsh
cd ~/Code/every-gram
while pgrep -f 'run_part.py|topo.py' >/dev/null; do sleep 20; done
{ for k in yoke foot arm hip; do for p in hollow honeycomb isogrid; do echo "patterns.py $k $p"; done; echo "materials.py $k"; done; } | \
 OMP_NUM_THREADS=2 xargs -P 4 -L 1 sh -c '.venv/bin/python "$0" "$@" > "out/q_$(echo "$0 $*" | tr " ./" "___").log" 2>&1'
echo queue done

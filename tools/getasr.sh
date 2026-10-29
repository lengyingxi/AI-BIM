#!/usr/bin/env bash
# 分段并行下载 vosk 中文小模型（单连接只有 ~8KB/s，多连接聚合 ~250KB/s）
set -u
cd "$(dirname "$0")"
URL="https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip"
TOTAL=43898754
N=24
DIR="asr/parts"
rm -rf "$DIR" asr/cn.zip
mkdir -p "$DIR"
STEP=$(( (TOTAL + N - 1) / N ))

fetch() {
  local i=$1 s=$2 e=$3 f="$DIR/p$1"
  for try in 1 2 3 4 5; do
    curl -s --max-time 240 -r "$s-$e" -o "$f" "$URL"
    local sz=$(stat -c %s "$f" 2>/dev/null || echo 0)
    local want=$(( e - s + 1 ))
    [ "$sz" -ge "$want" ] && return 0
    sleep 2
  done
  echo "PART $i FAILED"
  return 1
}

for ((i=0;i<N;i++)); do
  s=$(( i * STEP )); e=$(( s + STEP - 1 ))
  [ $e -ge $TOTAL ] && e=$(( TOTAL - 1 ))
  fetch $i $s $e &
done
wait

cat $(for ((i=0;i<N;i++)); do echo "$DIR/p$i"; done) > asr/cn.zip
SZ=$(stat -c %s asr/cn.zip)
echo "downloaded: $SZ / $TOTAL"
[ "$SZ" -eq "$TOTAL" ] && echo "SIZE OK" || echo "SIZE MISMATCH"

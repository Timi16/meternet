#!/usr/bin/env bash
# Makes MeterNet's own test content (once) and copies it to the public server's
# gateway folder, /srv/meternet/content. The gateway serves nothing else.
#
#   deploy/server/sync-content.sh
#
# files/  random test files (10 and 50 MB)
# video/  a 104 s synthetic test pattern (ffmpeg testsrc2 + a 440 Hz tone),
#         480p HLS in 13 s segments at a constant ~1.2 Mbit/s, so each is
#         ~2 MB and plays smoothly at the gateway's ~2 Mbit/s session pace
# Needs ffmpeg with libx264 on the machine running this. Content is not in git.
set -euo pipefail

SERVER=${SERVER:-meternet@162.35.126.18}
SSH_KEY=${SSH_KEY:-$HOME/.ssh/meternet}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT="$ROOT/content"

mkdir -p "$OUT/files" "$OUT/video"
for mb in 10 50; do
  f="$OUT/files/test-${mb}MB.bin"
  [ -f "$f" ] || head -c $((mb * 1024 * 1024)) /dev/urandom > "$f"
done
if [ ! -f "$OUT/video/index.m3u8" ]; then
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i testsrc2=size=854x480:rate=30 \
    -f lavfi -i sine=frequency=440:sample_rate=48000 \
    -t 104 \
    -c:v libx264 -preset veryfast -profile:v main -pix_fmt yuv420p \
    -b:v 1100k -minrate 1100k -maxrate 1100k -bufsize 1100k -x264-params nal-hrd=cbr \
    -g 390 -keyint_min 390 -sc_threshold 0 \
    -c:a aac -b:a 96k \
    -f hls -hls_time 13 -hls_playlist_type vod \
    -hls_segment_filename "$OUT/video/seg%03d.ts" "$OUT/video/index.m3u8"
fi
ls -l "$OUT/files" "$OUT/video" | awk 'NF > 5 {print $5, $NF}'

ssh -i "$SSH_KEY" -o ConnectTimeout=10 "$SERVER" 'sudo install -d -m 755 -o meternet -g meternet /srv/meternet/content'
rsync -az --delete -e "ssh -i $SSH_KEY -o ConnectTimeout=10" "$OUT/" "$SERVER:/srv/meternet/content/"
echo "content synced to $SERVER:/srv/meternet/content"

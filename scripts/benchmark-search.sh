#!/usr/bin/env bash
# Benchmark the exact call this plugin makes: GET /api/projects on the public
# AIGC Radar edge. 10 representative queries x 3 trials, reports p50/p95.
# Usage: scripts/benchmark-search.sh [base_url]
set -u

BASE="${1:-https://aigcnews.cn}"
QUERIES=(
  "RAG 评估" "MCP server" "vector database" "agent framework" "语音合成"
  "diffusion" "workflow 编排" "OCR" "fine-tuning" "爬虫"
)

times=()
for round in 1 2 3; do
  for q in "${QUERIES[@]}"; do
    ms=$(curl -s -o /dev/null -w "%{time_total}" --get "$BASE/api/projects" \
      --data-urlencode "q=$q" --data-urlencode "page_size=8" \
      | awk '{printf "%d", $1 * 1000}')
    times+=("$ms")
    printf "round%d  %-18s %5d ms\n" "$round" "$q" "$ms"
  done
done

printf "%s\n" "${times[@]}" | sort -n | awk '
  { a[NR] = $1 }
  END {
    p50 = a[int((NR + 1) / 2)]
    p95 = a[int(NR * 0.95 + 0.999)]
    printf "\nn=%d  p50=%d ms  p95=%d ms  min=%d ms  max=%d ms\n", NR, p50, p95, a[1], a[NR]
  }'

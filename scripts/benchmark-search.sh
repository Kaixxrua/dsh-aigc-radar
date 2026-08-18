#!/usr/bin/env bash
# Benchmark the exact call this plugin makes: POST /api/mcp tools/call
# (search_github_ai_projects) on the public AIGC Radar edge. 10 representative
# queries x 3 trials, reports p50/p95. Set AIGC_RADAR_MCP_TOKEN to benchmark
# the authenticated path. Usage: scripts/benchmark-search.sh [base_url]
set -u

BASE="${1:-https://aigcnews.cn}"
QUERIES=(
  "RAG 评估" "MCP server" "vector database" "agent framework" "语音合成"
  "diffusion" "workflow 编排" "OCR" "fine-tuning" "爬虫"
)

AUTH=()
if [ -n "${AIGC_RADAR_MCP_TOKEN:-}" ]; then
  AUTH=(-H "Authorization: Bearer $AIGC_RADAR_MCP_TOKEN")
fi

times=()
for round in 1 2 3; do
  for q in "${QUERIES[@]}"; do
    body=$(node -e 'console.log(JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"search_github_ai_projects",arguments:{q:process.argv[1],limit:8}}}))' "$q")
    ms=$(curl -s -o /dev/null -w "%{time_total}" -X POST "$BASE/api/mcp" \
      -H 'Content-Type: application/json' -H 'Accept: application/json' \
      -H 'MCP-Protocol-Version: 2025-06-18' "${AUTH[@]}" \
      --data "$body" \
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

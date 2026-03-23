#!/bin/bash
set -e

echo "Testing MCP server with MCP Inspector..."

cd "$(dirname "$0")"

echo "Running MCP Inspector test with MCP server..."
npx @modelcontextprotocol/inspector --cli --method "tools/list" chrome-mcp 
> [!WARNING]
> Ensure port 9223 is blocked from external traffic. execute_script allows execution of arbitrary JS code.

# Chrome MCP Controller

An MCP (Model Context Protocol) server that allows AI agents (like godex) to control Chrome tabs via a browser extension.

## Installation

### Quick Install (Linux/macOS)

```bash
curl -sSL https://raw.githubusercontent.com/cheikh2shift/chrome-mcp/main/install.sh | sh
```

Or install a specific version:
```bash
curl -sSL https://raw.githubusercontent.com/cheikh2shift/chrome-mcp/main/install.sh | sh -s v0.0.1
```

![Chrome MCP Controller](https://raw.githubusercontent.com/cheikh2shift/chrome-mcp/main/screen1.png)

![Demo](https://raw.githubusercontent.com/cheikh2shift/chrome-mcp/main/screen.gif)

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          MCP Mode (for godex)                                   │
│  ┌─────────────┐    stdio     ┌──────────────┐         ┌──────────────────────┐ │
│  │   godex     │◄────────────►│  chrome-mcp  │◄──WS─-─►│    Daemon Server     │ │
│  │  (AI Agent) │              │              │  /ws/mcp│    (port 9223)       │ │
│  └─────────────┘              └──────────────┘         └──────────┬───────────┘ │
└────────────────────────────────────────────────────────────┬──────┴─────────────┘
                                                    
┌───────────────────────────────────────────────────────────────────────────────┐
│                        Chrome Extension                                       │
│  ┌─────────────────────┐         WebSocket         ┌────────────────────────┐ │
│  │   background.js     │◄──────────────────────────│    Daemon Server       │ │
│  │   (service worker)  │   /ws/extension push      │    (port 9223)         │ │
│  └──────────┬──────────┘                           └───────────┬────────────┘ │
│             │ chrome.tabs.sendMessage                          │              │
│             ▼                                                  │              │
│  ┌─────────────────────┐                                       │              │
│  │     content.js      │◄──────────────────────────────────────┘              │
│  │  (page context)     │  DOM operations via content script                   │
│  └─────────────────────┘                                                      │
│             │                                                                 │
│             │ chrome.debugger.sendCommand (DevTools Protocol)                 │
│             ▼                                                                 │
│  ┌─────────────────────┐                                                      │
│  │    execute_script   │  JS execution via DevTools Protocol                  │
│  └─────────────────────┘                                                      │
└───────────────────────────────────────────────────────────────────────────────┘
```

## How It Works

1. **godex starts chrome-mcp** → Automatically starts daemon server in background
2. **Daemon** → HTTP + WebSocket server on port 9223
3. **MCP → Daemon** → Opens dedicated WebSocket connection (`/ws/mcp`)
4. **Extension → Daemon** → Opens WebSocket connection (`/ws/extension`) for push commands
5. **Command Flow** → Daemon pushes command to extension via WebSocket, extension executes and returns result directly back through the same WebSocket connection


### Manual Install

```bash
# Build from source
git clone https://github.com/cheikh2shift/chrome-mcp.git
cd chrome-mcp
go build -o chrome-mcp ./cmd/chrome-mcp
sudo mv chrome-mcp /usr/local/bin/
```

### Chrome Extension

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top right)
3. Click "Load unpacked"
4. Select the `extension/` folder from this repository

## Usage

### Start Daemon (Automatic)

When chrome-mcp runs in MCP mode (for godex), it automatically starts the daemon:

```bash
chrome-mcp --port 9223  # MCP mode, auto-starts daemon
chrome-mcp --server     # Run only HTTP server (no MCP)
chrome-mcp --kill       # Kill the daemon
```

### Chrome Extension

1. Click the Chrome MCP Controller extension icon
2. Navigate to tabs you want to control
3. Click "Connect" on each tab you want to control
4. Extension connects via WebSocket for instant command delivery

### Use with godex

Add to your `~/.godex/providers.yaml`:

```yaml
providers:
  - name: ollama
    type: ollama
    endpoint: http://localhost:11434
    model: minimax-m2.7:cloud
    description: Ollama with Chrome MCP
    mcp_servers:
      - name: chrome
        command: "/usr/local/bin/chrome-mcp"
        transport: "stdio"
        start: true

default_provider: ollama
```

## Available Tools

| Tool | Description |
|------|-------------|
| `list_connected_tabs` | List all tabs connected to the MCP server |
| `get_tab_info` | Get detailed information about a specific tab |
| `get_page_structure` | Get structured DOM overview (efficient for LLM context) |
| `extract_page_content` | Extract readable text, links, forms, images |
| `get_page_source` | Get raw HTML source (use sparingly) |
| `find_elements` | Find DOM elements using CSS/XPath selectors |
| `execute_script` | Execute JavaScript in the target tab |
| `get_element_details` | Get detailed element info (styles, bounding rect) |
| `wait_for_element` | Wait for element to appear |
| `take_screenshot` | Capture page screenshot |

## Example Usage

```bash
# List connected tabs
list_connected_tabs

# Get page structure
get_page_structure tab_id="tab_123456" max_depth=3

# Extract content from specific element
extract_page_content tab_id="tab_123456" selector="main"

# Execute JavaScript
execute_script tab_id="tab_123456" script="return document.title"

# Find elements
find_elements tab_id="tab_123456" selector="button.submit"

# Get element details
get_element_details tab_id="tab_123456" selector="#search-input"

# Wait for element
wait_for_element tab_id="tab_123456" selector=".loading" timeout_ms=5000

# Take screenshot
take_screenshot tab_id="tab_123456"
```

## Efficient Page Parsing

For long HTML pages, use these strategies:

1. **Use `get_page_structure`** with low `max_depth` (3-5) to understand layout
2. **Use `extract_page_content`** to get readable text without HTML noise
3. **Use `find_elements`** with specific selectors to locate elements
4. **Use `get_element_details`** for targeted element information

This approach prevents overwhelming the LLM context with raw HTML.

## JS Execution

JavaScript runs via the Chrome DevTools Protocol (not content script). Example scripts:

```javascript
// Click an element
document.querySelector('#submit-btn').click();

// Fill a form
document.querySelector('#email').value = 'test@example.com';

// Extract data
return Array.from(document.querySelectorAll('.item')).map(el => el.innerText);

// Interact with React/Vue
const input = document.querySelector('input[data-testid="search"]');
input.value = 'query';
input.dispatchEvent(new Event('input', { bubbles: true }));
```

## Configuration

Command line options:
- `--port 9223` - HTTP/WebSocket server port (default: 9223)
- `--debug` - Enable debug logging
- `--kill` - Kill the background daemon
- `--server` - Run only HTTP server (no MCP mode)

## License

MIT

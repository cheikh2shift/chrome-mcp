package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"

	chromedb "github.com/cheikh-seck/chrome-mcp/internal/db"
	"github.com/mark3labs/mcp-go/mcp"
	"github.com/mark3labs/mcp-go/server"
)

var (
	debugFlag   = flag.Bool("debug", false, "Enable debug logging")
	verboseFlag = flag.Bool("v", false, "Verbose logging (same as debug)")
	serverMode  = flag.Bool("server", false, "Run as HTTP server for Chrome extension")
	killFlag    = flag.Bool("kill", false, "Kill the background daemon server")
	port        = flag.Int("port", 9223, "HTTP server port")
)

type CommandResult struct {
	cmdID  string
	Status string
	Result string
	Error  string
}

type WSHub struct {
	extensionClients map[*websocket.Conn]bool
	mcpClients       map[*websocket.Conn]chan *CommandResult
	register         chan *websocket.Conn
	unregister       chan *websocket.Conn
	mu               sync.RWMutex
}

func newWSHub() *WSHub {
	return &WSHub{
		extensionClients: make(map[*websocket.Conn]bool),
		mcpClients:       make(map[*websocket.Conn]chan *CommandResult),
		register:         make(chan *websocket.Conn),
		unregister:       make(chan *websocket.Conn),
	}
}

func (h *WSHub) run() {
	for {
		select {
		case conn := <-h.register:
			h.mu.Lock()
			h.extensionClients[conn] = true
			h.mu.Unlock()

		case conn := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.extensionClients[conn]; ok {
				delete(h.extensionClients, conn)
				conn.Close()
			}
			if ch, ok := h.mcpClients[conn]; ok {
				delete(h.mcpClients, conn)
				close(ch)
			}
			h.mu.Unlock()
		}
	}
}

func (h *WSHub) BroadcastToExtensions(msg []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for client := range h.extensionClients {
		err := client.WriteMessage(websocket.TextMessage, msg)
		if err != nil {
			client.Close()
			delete(h.extensionClients, client)
		}
	}
}

func (h *WSHub) HandleMCPClient(conn *websocket.Conn, db *chromedb.SharedDB) {
	h.mu.Lock()
	resultChan := make(chan *CommandResult, 1)
	h.mcpClients[conn] = resultChan
	h.mu.Unlock()

	defer func() {
		h.mu.Lock()
		delete(h.mcpClients, conn)
		close(resultChan)
		h.mu.Unlock()
	}()

	go func() {
		for result := range resultChan {
			msg := map[string]interface{}{
				"type":   "result",
				"cmd_id": result.cmdID,
				"status": result.Status,
				"result": result.Result,
				"error":  result.Error,
			}
			if err := conn.WriteJSON(msg); err != nil {
				return
			}
		}
	}()

	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			break
		}

		var msg map[string]interface{}
		if err := json.Unmarshal(message, &msg); err != nil {
			continue
		}

		msgType, _ := msg["type"].(string)

		switch msgType {
		case "command":
			cmdID, _ := msg["cmd_id"].(string)
			tabID, _ := msg["tab_id"].(string)
			cmdType, _ := msg["cmd_type"].(string)
			params, _ := msg["params"].(string)

			cmd := &chromedb.Command{
				ID:        cmdID,
				TabID:     tabID,
				Type:      cmdType,
				Params:    params,
				CreatedAt: time.Now(),
			}
			db.AddCommand(cmd)

			var paramsObj map[string]interface{}
			json.Unmarshal([]byte(params), &paramsObj)
			if paramsObj == nil {
				paramsObj = make(map[string]interface{})
			}
			paramsObj["_type"] = cmdType
			paramsObj["_cmd_id"] = cmdID

			h.sendToTab(tabID, cmdID, "command", paramsObj)
			debugLog("Forwarded command %s to extension for tab %s", cmdID, tabID)

		case "command_complete", "command_failed":
			cmdID, _ := msg["cmd_id"].(string)
			var errMsg string
			var status string
			if msgType == "command_failed" {
				errMsg, _ = msg["error"].(string)
				status = "failed"
			} else {
				status = "completed"
			}
			result, _ := msg["result"]
			resultStr, _ := json.Marshal(result)
			h.BroadcastResult(&CommandResult{
				cmdID:  cmdID,
				Status: status,
				Result: string(resultStr),
				Error:  errMsg,
			})
		}
	}
}

func (h *WSHub) BroadcastResult(result *CommandResult) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for conn, ch := range h.mcpClients {
		select {
		case ch <- result:
		default:
			conn.Close()
			delete(h.mcpClients, conn)
		}
	}
}

func debugLog(format string, args ...interface{}) {
	if *debugFlag || *verboseFlag {
		fmt.Fprintf(os.Stderr, "[DEBUG] "+format+"\n", args...)
	}
}

var wsHub *WSHub
var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

func getPIDFile() string {
	homeDir, _ := os.UserHomeDir()
	return filepath.Join(homeDir, ".chrome-mcp", "daemon.pid")
}

func getLogFile() string {
	homeDir, _ := os.UserHomeDir()
	return filepath.Join(homeDir, ".chrome-mcp", "daemon.log")
}

func getDaemonPort() int {
	homeDir, _ := os.UserHomeDir()
	portFile := filepath.Join(homeDir, ".chrome-mcp", "daemon.port")
	data, err := os.ReadFile(portFile)
	if err != nil {
		return 9223
	}
	port, _ := strconv.Atoi(string(data))
	return port
}

func getDaemonURL() string {
	return fmt.Sprintf("http://localhost:%d", getDaemonPort())
}

func getWSURL() string {
	return fmt.Sprintf("ws://localhost:%d", getDaemonPort())
}

func killDaemon() bool {
	pidFile := getPIDFile()
	data, err := os.ReadFile(pidFile)
	if err != nil {
		fmt.Fprintf(os.Stderr, "No daemon running (pidfile not found)\n")
		return false
	}

	pid, err := strconv.Atoi(string(data))
	if err != nil {
		fmt.Fprintf(os.Stderr, "Invalid pidfile\n")
		os.Remove(pidFile)
		return false
	}

	proc, err := os.FindProcess(pid)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Cannot find process %d\n", pid)
		os.Remove(pidFile)
		return false
	}

	if err := proc.Kill(); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to kill daemon: %v\n", err)
		return false
	}

	os.Remove(pidFile)
	fmt.Println("Daemon killed")
	return true
}

func daemonize(port int, debug bool) error {
	homeDir, _ := os.UserHomeDir()
	if err := os.MkdirAll(filepath.Join(homeDir, ".chrome-mcp"), 0755); err != nil {
		return fmt.Errorf("failed to create .chrome-mcp dir: %w", err)
	}

	portFile := filepath.Join(homeDir, ".chrome-mcp", "daemon.port")
	os.WriteFile(portFile, []byte(strconv.Itoa(port)), 0644)

	args := []string{"--server", "--port", strconv.Itoa(port)}
	if debug {
		args = append(args, "--debug")
	}

	cmd := exec.Command(os.Args[0], args...)
	cmd.Stdout, _ = os.OpenFile(getLogFile(), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	cmd.Stderr = cmd.Stdout
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("failed to start daemon: %w", err)
	}

	os.WriteFile(getPIDFile(), []byte(strconv.Itoa(cmd.Process.Pid)), 0644)
	fmt.Printf("Daemon started on port %d (pid %d)\n", port, cmd.Process.Pid)
	return nil
}

func isDaemonRunning() bool {
	pidFile := getPIDFile()
	data, err := os.ReadFile(pidFile)
	if err != nil {
		return false
	}

	pid, err := strconv.Atoi(string(data))
	if err != nil {
		return false
	}

	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}

	if err := proc.Signal(syscall.Signal(0)); err != nil {
		return false
	}
	return true
}

func waitForDaemon(maxWait time.Duration) error {
	daemonURL := getDaemonURL()
	deadline := time.Now().Add(maxWait)
	client := &http.Client{Timeout: 1 * time.Second}

	for time.Now().Before(deadline) {
		resp, err := client.Get(daemonURL + "/health")
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("daemon not responding after %v", maxWait)
}

func main() {
	flag.Parse()

	debug := *debugFlag || *verboseFlag

	if *killFlag {
		killDaemon()
		return
	}

	if isDaemonRunning() {
		port := getDaemonPort()
		fmt.Printf("Daemon already running on port %d\n", port)
	} else if !*serverMode {
		if err := daemonize(*port, debug); err != nil {
			log.Fatalf("Failed to start daemon: %v", err)
		}
		if err := waitForDaemon(5 * time.Second); err != nil {
			log.Fatalf("Daemon failed to start: %v", err)
		}
	}

	if debug {
		debugLog("Starting chrome-mcp v1.0.0")
	}

	if *serverMode {
		db, err := chromedb.NewSharedDB(getDBPath())
		if err != nil {
			log.Fatalf("Failed to open database: %v", err)
		}
		defer db.Close()
		runHTTPServer(db, debug)
	} else {
		runMCPServer(debug)
	}
}

func getDBPath() string {
	homeDir, _ := os.UserHomeDir()
	return filepath.Join(homeDir, ".chrome-mcp", "state.db")
}

func runHTTPServer(db *chromedb.SharedDB, debug bool) {
	wsHub = newWSHub()
	go wsHub.run()

	mux := http.NewServeMux()

	mux.HandleFunc("/health", handleHealth)
	mux.HandleFunc("/tabs", handleTabs(db, debug))
	mux.HandleFunc("/register", handleRegister(db, wsHub, debug))
	mux.HandleFunc("/unregister", handleUnregister(db, wsHub, debug))
	mux.HandleFunc("/ws/extension", handleExtensionWebSocket(wsHub, db, debug))
	mux.HandleFunc("/ws/mcp", handleMCPWebSocket(wsHub, db, debug))

	addr := fmt.Sprintf("127.0.0.1:%d", *port)
	httpServer := &http.Server{
		Addr:         addr,
		Handler:      mux,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 30 * time.Second,
	}

	if debug {
		debugLog("HTTP server listening on %s", addr)
		debugLog("Extension WS: ws://localhost:%d/ws/extension", *port)
		debugLog("MCP WS: ws://localhost:%d/ws/mcp", *port)
	}

	if err := httpServer.ListenAndServe(); err != nil {
		log.Fatalf("HTTP server error: %v", err)
	}
}

func setCORS(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status": "ok",
	})
}

func handleTabs(db *chromedb.SharedDB, debug bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		setCORS(w)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}
		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		tabs, err := db.ListTabs()
		if err != nil {
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}

		json.NewEncoder(w).Encode(map[string]interface{}{
			"type":   "success",
			"result": tabs,
		})
	}
}

func handleRegister(db *chromedb.SharedDB, hub *WSHub, debug bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		setCORS(w)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		body, _ := io.ReadAll(r.Body)
		var data struct {
			TabID    int    `json:"tab_id"`
			Title    string `json:"title"`
			URL      string `json:"url"`
			WindowID int    `json:"windowId"`
		}
		json.Unmarshal(body, &data)

		tab := &chromedb.Tab{
			ID:       fmt.Sprintf("tab_%d", data.TabID),
			ChromeID: data.TabID,
			WindowID: data.WindowID,
			Title:    data.Title,
			URL:      data.URL,
		}

		if err := db.AddTab(tab); err != nil {
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}

		hub.sendToTab(tab.ID, "", "tab_registered", map[string]interface{}{
			"id":            tab.ID,
			"chrome_tab_id": tab.ChromeID,
			"window_id":     tab.WindowID,
			"title":         tab.Title,
			"url":           tab.URL,
		})

		if debug {
			debugLog("Registered tab: %s (chrome_id=%d)", tab.ID, tab.ChromeID)
		}

		json.NewEncoder(w).Encode(map[string]interface{}{
			"type":   "success",
			"result": map[string]string{"id": tab.ID},
		})
	}
}

func handleUnregister(db *chromedb.SharedDB, hub *WSHub, debug bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		setCORS(w)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		body, _ := io.ReadAll(r.Body)
		var data struct {
			ID string `json:"id"`
		}
		json.Unmarshal(body, &data)

		if err := db.RemoveTab(data.ID); err != nil {
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}

		if debug {
			debugLog("Unregistered tab: %s", data.ID)
		}

		json.NewEncoder(w).Encode(map[string]interface{}{
			"type":   "success",
			"result": map[string]bool{"removed": true},
		})
	}
}

func (h *WSHub) sendToTab(tabID string, cmdID string, msgType string, data interface{}) {
	msg := map[string]interface{}{
		"type":   msgType,
		"tab_id": tabID,
		"cmd_id": cmdID,
		"data":   data,
	}
	msgBytes, _ := json.Marshal(msg)
	h.BroadcastToExtensions(msgBytes)
}

func handleExtensionWebSocket(hub *WSHub, db *chromedb.SharedDB, debug bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			if debug {
				debugLog("Extension WebSocket upgrade failed: %v", err)
			}
			return
		}
		defer conn.Close()

		hub.register <- conn
		if debug {
			debugLog("Extension connected via WebSocket")
		}

		defer func() {
			hub.unregister <- conn
			if debug {
				debugLog("Extension disconnected from WebSocket")
			}
		}()

		for {
			_, message, err := conn.ReadMessage()
			if err != nil {
				break
			}

			var msg map[string]interface{}
			if err := json.Unmarshal(message, &msg); err != nil {
				continue
			}

			msgType, _ := msg["type"].(string)

			switch msgType {
			case "command_complete":
				cmdID, _ := msg["cmd_id"].(string)
				result, _ := msg["result"]
				resultStr, _ := json.Marshal(result)
				db.CompleteCommand(cmdID, string(resultStr))
				hub.BroadcastResult(&CommandResult{
					cmdID:  cmdID,
					Status: "completed",
					Result: string(resultStr),
				})
				if debug {
					debugLog("Command completed: %s", cmdID)
				}

			case "command_failed":
				cmdID, _ := msg["cmd_id"].(string)
				errMsg, _ := msg["error"].(string)
				db.FailCommand(cmdID, errMsg)
				hub.BroadcastResult(&CommandResult{
					cmdID:  cmdID,
					Status: "failed",
					Error:  errMsg,
				})
				if debug {
					debugLog("Command failed: %s - %s", cmdID, errMsg)
				}
			}
		}
	}
}

func handleMCPWebSocket(hub *WSHub, db *chromedb.SharedDB, debug bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()

		hub.HandleMCPClient(conn, db)
	}
}

func runMCPServer(debug bool) {
	mcpServer := server.NewMCPServer(
		"chrome-mcp",
		"1.0.0",
		server.WithToolCapabilities(true),
	)

	getTabID := func(request mcp.CallToolRequest) string {
		if tabID := request.GetString("tab_id", ""); tabID != "" {
			return tabID
		}
		if tabID := request.GetString("tabId", ""); tabID != "" {
			return tabID
		}
		return request.GetString("TabId", "")
	}

	mcpServer.AddTool(
		mcp.NewTool(
			"list_connected_tabs",
			mcp.WithDescription("List all tabs connected via Chrome extension. IMPORTANT: If you don't know any tab IDs, call this first to see available tabs."),
		),
		func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			tabs, err := getTabsFromDaemon(debug)
			if err != nil {
				return mcp.NewToolResultError(err.Error()), nil
			}

			if len(tabs) == 0 {
				return mcp.NewToolResultText("No tabs connected. Open Chrome and click 'Connect' on tabs you want to control."), nil
			}

			result := fmt.Sprintf("Connected Tabs (%d):\n\n", len(tabs))
			for _, tab := range tabs {
				result += fmt.Sprintf("ID: %s\n  Title: %s\n  URL: %s\n\n", tab["id"], tab["title"], tab["url"])
			}

			return mcp.NewToolResultText(result), nil
		},
	)

	mcpServer.AddTool(
		mcp.NewTool(
			"get_tab_info",
			mcp.WithDescription("Get info about a connected tab. If you don't know tab IDs, call list_connected_tabs first."),
			mcp.WithString("tab_id", mcp.Required(), mcp.Description("Tab ID")),
		),
		func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			tabID := getTabID(request)
			if tabID == "" {
				return mcp.NewToolResultError("tab_id is required"), nil
			}
			tab, err := getTabFromDaemon(tabID, debug)
			if err != nil {
				return mcp.NewToolResultError(fmt.Sprintf("Tab not found: %s", tabID)), nil
			}

			result := fmt.Sprintf("ID: %v\nChrome Tab ID: %v\nTitle: %v\nURL: %v",
				tab["id"], tab["chrome_tab_id"], tab["title"], tab["url"])
			return mcp.NewToolResultText(result), nil
		},
	)

	mcpServer.AddTool(
		mcp.NewTool(
			"execute_script",
			mcp.WithDescription("Execute JavaScript in a connected tab. If you don't know tab IDs, call list_connected_tabs first."),
			mcp.WithString("tab_id", mcp.Required(), mcp.Description("Tab ID")),
			mcp.WithString("script", mcp.Required(), mcp.Description("JavaScript code to execute")),
			mcp.WithNumber("timeout_ms", mcp.DefaultNumber(30000), mcp.Description("Timeout in milliseconds")),
		),
		func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			tabID := getTabID(request)
			if tabID == "" {
				return mcp.NewToolResultError("tab_id is required"), nil
			}
			script, _ := request.RequireString("script")
			timeout := request.GetInt("timeout_ms", 30000)
			cmdID := fmt.Sprintf("cmd_%d", time.Now().UnixNano())
			return executeViaWebSocket(cmdID, tabID, "execute_script", script, timeout, debug)
		},
	)

	mcpServer.AddTool(
		mcp.NewTool(
			"get_page_structure",
			mcp.WithDescription("Get structured DOM overview of the page. If you don't know tab IDs, call list_connected_tabs first."),
			mcp.WithString("tab_id", mcp.Required(), mcp.Description("Tab ID")),
			mcp.WithNumber("max_depth", mcp.DefaultNumber(3), mcp.Description("Maximum depth to traverse")),
			mcp.WithNumber("timeout_ms", mcp.DefaultNumber(15000), mcp.Description("Timeout in milliseconds")),
		),
		func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			tabID := getTabID(request)
			if tabID == "" {
				return mcp.NewToolResultError("tab_id is required"), nil
			}
			maxDepth := request.GetInt("max_depth", 3)
			timeout := request.GetInt("timeout_ms", 15000)
			cmdID := fmt.Sprintf("cmd_%d", time.Now().UnixNano())
			params := fmt.Sprintf(`{"max_depth":%d}`, maxDepth)
			return executeViaWebSocket(cmdID, tabID, "get_page_structure", params, timeout, debug)
		},
	)

	mcpServer.AddTool(
		mcp.NewTool(
			"extract_page_content",
			mcp.WithDescription("Extract readable text, links, forms, images from page. If you don't know tab IDs, call list_connected_tabs first."),
			mcp.WithString("tab_id", mcp.Required(), mcp.Description("Tab ID")),
			mcp.WithString("selector", mcp.DefaultString(""), mcp.Description("Optional CSS selector")),
			mcp.WithNumber("timeout_ms", mcp.DefaultNumber(15000), mcp.Description("Timeout in milliseconds")),
		),
		func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			tabID := getTabID(request)
			if tabID == "" {
				return mcp.NewToolResultError("tab_id is required"), nil
			}
			selector := request.GetString("selector", "")
			timeout := request.GetInt("timeout_ms", 15000)
			cmdID := fmt.Sprintf("cmd_%d", time.Now().UnixNano())
			params := fmt.Sprintf(`{"selector":"%s"}`, selector)
			return executeViaWebSocket(cmdID, tabID, "extract_page_content", params, timeout, debug)
		},
	)

	mcpServer.AddTool(
		mcp.NewTool(
			"get_page_source",
			mcp.WithDescription("Get raw HTML source. If you don't know tab IDs, call list_connected_tabs first."),
			mcp.WithString("tab_id", mcp.Required(), mcp.Description("Tab ID")),
			mcp.WithNumber("max_length", mcp.DefaultNumber(50000), mcp.Description("Max characters")),
			mcp.WithNumber("timeout_ms", mcp.DefaultNumber(15000), mcp.Description("Timeout in milliseconds")),
		),
		func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			tabID := getTabID(request)
			if tabID == "" {
				return mcp.NewToolResultError("tab_id is required"), nil
			}
			maxLength := request.GetInt("max_length", 50000)
			timeout := request.GetInt("timeout_ms", 15000)
			cmdID := fmt.Sprintf("cmd_%d", time.Now().UnixNano())
			params := fmt.Sprintf(`{"max_length":%d}`, maxLength)
			return executeViaWebSocket(cmdID, tabID, "get_page_source", params, timeout, debug)
		},
	)

	mcpServer.AddTool(
		mcp.NewTool(
			"find_elements",
			mcp.WithDescription("Find DOM elements using CSS/XPath. If you don't know tab IDs, call list_connected_tabs first."),
			mcp.WithString("tab_id", mcp.Required(), mcp.Description("Tab ID")),
			mcp.WithString("selector", mcp.Required(), mcp.Description("CSS or XPath selector")),
			mcp.WithString("selector_type", mcp.DefaultString("css"), mcp.Description("'css' or 'xpath'")),
			mcp.WithNumber("timeout_ms", mcp.DefaultNumber(15000), mcp.Description("Timeout in milliseconds")),
		),
		func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			tabID := getTabID(request)
			if tabID == "" {
				return mcp.NewToolResultError("tab_id is required"), nil
			}
			selector, _ := request.RequireString("selector")
			selectorType := request.GetString("selector_type", "css")
			timeout := request.GetInt("timeout_ms", 15000)
			cmdID := fmt.Sprintf("cmd_%d", time.Now().UnixNano())
			params := fmt.Sprintf(`{"selector":"%s","selector_type":"%s"}`, selector, selectorType)
			return executeViaWebSocket(cmdID, tabID, "find_elements", params, timeout, debug)
		},
	)

	mcpServer.AddTool(
		mcp.NewTool(
			"get_element_details",
			mcp.WithDescription("Get detailed element info. If you don't know tab IDs, call list_connected_tabs first."),
			mcp.WithString("tab_id", mcp.Required(), mcp.Description("Tab ID")),
			mcp.WithString("selector", mcp.Required(), mcp.Description("CSS selector")),
			mcp.WithNumber("timeout_ms", mcp.DefaultNumber(15000), mcp.Description("Timeout in milliseconds")),
		),
		func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			tabID := getTabID(request)
			if tabID == "" {
				return mcp.NewToolResultError("tab_id is required"), nil
			}
			selector, _ := request.RequireString("selector")
			timeout := request.GetInt("timeout_ms", 15000)
			cmdID := fmt.Sprintf("cmd_%d", time.Now().UnixNano())
			params := fmt.Sprintf(`{"selector":"%s"}`, selector)
			return executeViaWebSocket(cmdID, tabID, "get_element_details", params, timeout, debug)
		},
	)

	mcpServer.AddTool(
		mcp.NewTool(
			"wait_for_element",
			mcp.WithDescription("Wait for element to appear. If you don't know tab IDs, call list_connected_tabs first."),
			mcp.WithString("tab_id", mcp.Required(), mcp.Description("Tab ID")),
			mcp.WithString("selector", mcp.Required(), mcp.Description("CSS selector")),
			mcp.WithNumber("timeout_ms", mcp.DefaultNumber(10000), mcp.Description("Timeout in milliseconds")),
		),
		func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			tabID := getTabID(request)
			if tabID == "" {
				return mcp.NewToolResultError("tab_id is required"), nil
			}
			selector, _ := request.RequireString("selector")
			timeout := request.GetInt("timeout_ms", 10000)
			cmdID := fmt.Sprintf("cmd_%d", time.Now().UnixNano())
			params := fmt.Sprintf(`{"selector":"%s","timeout_ms":%d}`, selector, timeout)
			return executeViaWebSocket(cmdID, tabID, "wait_for_element", params, timeout+5000, debug)
		},
	)

	mcpServer.AddTool(
		mcp.NewTool(
			"take_screenshot",
			mcp.WithDescription("Capture page screenshot. If you don't know tab IDs, call list_connected_tabs first."),
			mcp.WithString("tab_id", mcp.Required(), mcp.Description("Tab ID")),
			mcp.WithNumber("timeout_ms", mcp.DefaultNumber(15000), mcp.Description("Timeout in milliseconds")),
		),
		func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			tabID := getTabID(request)
			if tabID == "" {
				return mcp.NewToolResultError("tab_id is required"), nil
			}
			timeout := request.GetInt("timeout_ms", 15000)
			cmdID := fmt.Sprintf("cmd_%d", time.Now().UnixNano())
			return executeViaWebSocket(cmdID, tabID, "take_screenshot", "{}", timeout, debug)
		},
	)

	if debug {
		debugLog("Starting MCP stdio server")
	}

	if err := server.ServeStdio(mcpServer); err != nil {
		log.Fatalf("MCP server error: %v", err)
	}
}

func executeViaWebSocket(cmdID, tabID, cmdType, params string, timeoutMs int, debug bool) (*mcp.CallToolResult, error) {
	daemonWSURL := fmt.Sprintf("ws://localhost:%d/ws/mcp", getDaemonPort())

	conn, _, err := websocket.DefaultDialer.Dial(daemonWSURL, nil)
	if err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("Failed to connect to daemon: %v", err)), nil
	}
	defer conn.Close()

	resultChan := make(chan *CommandResult, 1)
	done := make(chan struct{})

	go func() {
		for {
			_, message, err := conn.ReadMessage()
			if err != nil {
				close(done)
				return
			}

			var msg map[string]interface{}
			if err := json.Unmarshal(message, &msg); err != nil {
				continue
			}

			msgType, _ := msg["type"].(string)
			debugLog("MCP WS received: type=%s, msg=%s", msgType, string(message))

			if msgType == "result" || msgType == "completed" || msgType == "command_complete" || msgType == "command_failed" {
				resultCmdID, _ := msg["cmd_id"].(string)
				status, _ := msg["status"].(string)
				result, _ := msg["result"]
				errMsg, _ := msg["error"].(string)
				resultStr, _ := json.Marshal(result)

				cmdResult := &CommandResult{
					cmdID:  resultCmdID,
					Status: status,
					Result: string(resultStr),
					Error:  errMsg,
				}

				select {
				case resultChan <- cmdResult:
				default:
				}
				return
			}
		}
	}()

	command := map[string]interface{}{
		"type":     "command",
		"cmd_type": cmdType,
		"tab_id":   tabID,
		"cmd_id":   cmdID,
		"params":   params,
	}
	if err := conn.WriteJSON(command); err != nil {
		return mcp.NewToolResultError(fmt.Sprintf("Failed to send command: %v", err)), nil
	}

	debugLog("%s: %s (tab=%s) -> sent command, waiting for result", cmdType, cmdID, tabID)

	select {
	case result := <-resultChan:
		debugLog("MCP WS got result: status=%s, cmdID=%s", result.Status, result.cmdID)
		if result.Status == "completed" || result.Status == "success" {
			return mcp.NewToolResultText(result.Result), nil
		}
		return mcp.NewToolResultError(result.Error), nil
	case <-done:
		return mcp.NewToolResultError("connection closed"), nil
	case <-time.After(time.Duration(timeoutMs) * time.Millisecond):
		return mcp.NewToolResultError("timeout waiting for result"), nil
	}
}

func getTabsFromDaemon(debug bool) ([]map[string]interface{}, error) {
	daemonURL := getDaemonURL()
	resp, err := http.Get(daemonURL + "/tabs")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var result map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}

	if result["type"] != "success" {
		return nil, fmt.Errorf("API error")
	}

	resultList, ok := result["result"].([]interface{})
	if !ok {
		return nil, fmt.Errorf("invalid response")
	}

	tabs := make([]map[string]interface{}, 0, len(resultList))
	for _, item := range resultList {
		if tab, ok := item.(map[string]interface{}); ok {
			tabs = append(tabs, tab)
		}
	}

	return tabs, nil
}

func getTabFromDaemon(tabID string, debug bool) (map[string]interface{}, error) {
	tabs, err := getTabsFromDaemon(debug)
	if err != nil {
		return nil, err
	}

	for _, tab := range tabs {
		if id, ok := tab["id"].(string); ok && id == tabID {
			return tab, nil
		}
	}

	return nil, fmt.Errorf("Tab not found: %s", tabID)
}

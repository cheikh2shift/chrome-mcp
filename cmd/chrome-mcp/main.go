package main

import (
	"context"
	"database/sql"
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
	versionFlag = flag.Bool("version", false, "Print version")
)

var (
	version = "dev"
	commit  = "unknown"
	date    = "unknown"
)

type CommandResult struct {
	cmdID  string
	Status string
	Result string
	Error  string
}

type CommandMeta struct {
	CmdType   string
	TabID     string
	StartedAt time.Time
}

type WSHub struct {
	extensionClients map[*websocket.Conn]bool
	mcpClients       map[*websocket.Conn]chan *CommandResult
	pendingCmdOwner  map[string]*websocket.Conn
	cmdsByConn       map[*websocket.Conn]map[string]struct{}
	commandMeta      map[string]CommandMeta
	register         chan *websocket.Conn
	unregister       chan *websocket.Conn
	mu               sync.RWMutex
}

func newWSHub() *WSHub {
	return &WSHub{
		extensionClients: make(map[*websocket.Conn]bool),
		mcpClients:       make(map[*websocket.Conn]chan *CommandResult),
		pendingCmdOwner:  make(map[string]*websocket.Conn),
		cmdsByConn:       make(map[*websocket.Conn]map[string]struct{}),
		commandMeta:      make(map[string]CommandMeta),
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
			if cmdSet, ok := h.cmdsByConn[conn]; ok {
				for cmdID := range cmdSet {
					delete(h.pendingCmdOwner, cmdID)
					delete(h.commandMeta, cmdID)
				}
				delete(h.cmdsByConn, conn)
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
	clients := make([]*websocket.Conn, 0, len(h.extensionClients))
	for client := range h.extensionClients {
		clients = append(clients, client)
	}
	h.mu.RUnlock()

	debugLog("BroadcastToExtensions: broadcasting to %d extension clients, msgLen=%d", len(clients), len(msg))

	var stale []*websocket.Conn
	for _, client := range clients {
		_ = client.SetWriteDeadline(time.Now().Add(2 * time.Second))
		err := client.WriteMessage(websocket.TextMessage, msg)
		_ = client.SetWriteDeadline(time.Time{})
		if err != nil {
			client.Close()
			stale = append(stale, client)
		}
	}

	if len(stale) == 0 {
		return
	}
	h.mu.Lock()
	for _, client := range stale {
		delete(h.extensionClients, client)
	}
	h.mu.Unlock()
}

func (h *WSHub) HandleMCPClient(conn *websocket.Conn, db *chromedb.SharedDB) {
	h.mu.Lock()
	resultChan := make(chan *CommandResult, 1)
	h.mcpClients[conn] = resultChan
	h.cmdsByConn[conn] = make(map[string]struct{})
	h.mu.Unlock()

	defer func() {
		h.mu.Lock()
		if cmdSet, ok := h.cmdsByConn[conn]; ok {
			for cmdID := range cmdSet {
				delete(h.pendingCmdOwner, cmdID)
				delete(h.commandMeta, cmdID)
			}
			delete(h.cmdsByConn, conn)
		}
		delete(h.mcpClients, conn)
		close(resultChan)
		h.mu.Unlock()
	}()

	go func() {
		for result := range resultChan {
			var resultPayload interface{}
			if result.Result != "" {
				if err := json.Unmarshal([]byte(result.Result), &resultPayload); err != nil {
					resultPayload = result.Result
				}
			}
			msg := map[string]interface{}{
				"type":   "result",
				"cmd_id": result.cmdID,
				"status": result.Status,
				"result": resultPayload,
				"error":  result.Error,
			}
			_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
			if err := conn.WriteJSON(msg); err != nil {
				debugLog("MCP write failed for cmdID=%s: %v", result.cmdID, err)
				_ = conn.Close()
				return
			}
			_ = conn.SetWriteDeadline(time.Time{})
			debugLog("MCP write succeeded for cmdID=%s", result.cmdID)
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
			debugLog("Daemon received command: cmdID=%s, tabID=%s, cmdType=%s, params=%s", cmdID, tabID, cmdType, params)
			if cmdID == "" {
				continue
			}
			now := time.Now()

			cmd := &chromedb.Command{
				ID:        cmdID,
				TabID:     tabID,
				Type:      cmdType,
				Params:    params,
				CreatedAt: now,
			}
			db.AddCommand(cmd)

			var paramsObj map[string]interface{}
			json.Unmarshal([]byte(params), &paramsObj)
			if paramsObj == nil {
				paramsObj = make(map[string]interface{})
			}
			paramsObj["_type"] = cmdType
			paramsObj["_cmd_id"] = cmdID

			h.mu.Lock()
			h.pendingCmdOwner[cmdID] = conn
			if _, ok := h.cmdsByConn[conn]; !ok {
				h.cmdsByConn[conn] = make(map[string]struct{})
			}
			h.cmdsByConn[conn][cmdID] = struct{}{}
			h.commandMeta[cmdID] = CommandMeta{
				CmdType:   cmdType,
				TabID:     tabID,
				StartedAt: now,
			}
			h.mu.Unlock()

			h.sendToTab(tabID, cmdID, "command", paramsObj)
			debugLog("Forwarded command %s (%s) to extension for tab %s", cmdID, cmdType, tabID)

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
			debugLog("Received command result for cmdID=%s, broadcasting to waiting clients", cmdID)
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
	cleanupSeenResults()
	if isResultSeen(result.cmdID) {
		debugLog("BroadcastResult: skipping duplicate result for cmdID=%s", result.cmdID)
		return
	}

	h.mu.Lock()
	ownerConn, hasOwner := h.pendingCmdOwner[result.cmdID]
	if hasOwner {
		ch, ok := h.mcpClients[ownerConn]
		delete(h.pendingCmdOwner, result.cmdID)
		if cmdSet, hasSet := h.cmdsByConn[ownerConn]; hasSet {
			delete(cmdSet, result.cmdID)
		}
		if ok {
			select {
			case ch <- result:
				debugLog("Delivered result cmdID=%s to owner MCP client", result.cmdID)
				h.mu.Unlock()
				return
			default:
				ownerConn.Close()
				delete(h.mcpClients, ownerConn)
				if chSet, exists := h.cmdsByConn[ownerConn]; exists {
					for cmdID := range chSet {
						delete(h.pendingCmdOwner, cmdID)
						delete(h.commandMeta, cmdID)
					}
					delete(h.cmdsByConn, ownerConn)
				}
				h.mu.Unlock()
				debugLog("Dropped result for cmdID=%s due backpressure on owner MCP socket", result.cmdID)
				return
			}
		}
		debugLog("Owner MCP client missing for cmdID=%s during delivery", result.cmdID)
	}

	type mcpTarget struct {
		conn *websocket.Conn
		ch   chan *CommandResult
	}
	targets := make([]mcpTarget, 0, len(h.mcpClients))
	for conn, ch := range h.mcpClients {
		targets = append(targets, mcpTarget{conn: conn, ch: ch})
	}
	if !hasOwner {
		debugLog("No owner for cmdID=%s, falling back to broadcast across %d MCP clients", result.cmdID, len(targets))
	}
	h.mu.Unlock()

	var stale []mcpTarget
	for _, target := range targets {
		select {
		case target.ch <- result:
		default:
			target.conn.Close()
			stale = append(stale, target)
		}
	}

	if len(stale) == 0 {
		return
	}
	h.mu.Lock()
	for _, target := range stale {
		if cmdSet, ok := h.cmdsByConn[target.conn]; ok {
			for cmdID := range cmdSet {
				delete(h.pendingCmdOwner, cmdID)
				delete(h.commandMeta, cmdID)
			}
			delete(h.cmdsByConn, target.conn)
		}
		delete(h.mcpClients, target.conn)
	}
	h.mu.Unlock()
}

func (h *WSHub) popCommandMeta(cmdID string) (CommandMeta, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	meta, ok := h.commandMeta[cmdID]
	if ok {
		delete(h.commandMeta, cmdID)
	}
	return meta, ok
}

func debugLog(format string, args ...interface{}) {
	if *debugFlag || *verboseFlag {
		fmt.Fprintf(os.Stderr, "[DEBUG] "+format+"\n", args...)
	}
}

func escapeJSON(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}

func commandResultFromDB(db *chromedb.SharedDB, cmdID string) (*CommandResult, bool) {
	cmd, err := db.GetCommand(cmdID)
	if err != nil {
		if err != sql.ErrNoRows {
			debugLog("DB poll read failed for cmdID=%s: %v", cmdID, err)
		}
		return nil, false
	}
	switch cmd.Status {
	case "completed":
		return &CommandResult{
			cmdID:  cmdID,
			Status: "completed",
			Result: cmd.Result,
		}, true
	case "failed":
		return &CommandResult{
			cmdID:  cmdID,
			Status: "failed",
			Error:  cmd.Result,
		}, true
	default:
		return nil, false
	}
}

var wsHub *WSHub
var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

var (
	seenResults   = make(map[string]time.Time)
	seenResultsMu sync.Mutex
)

func cleanupSeenResults() {
	seenResultsMu.Lock()
	defer seenResultsMu.Unlock()
	cutoff := time.Now().Add(-30 * time.Second)
	for id, t := range seenResults {
		if t.Before(cutoff) {
			delete(seenResults, id)
		}
	}
}

func isResultSeen(id string) bool {
	seenResultsMu.Lock()
	defer seenResultsMu.Unlock()
	_, exists := seenResults[id]
	if !exists {
		seenResults[id] = time.Now()
	}
	return exists
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
	setupDaemonCommand(cmd)

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

	if *versionFlag {
		fmt.Printf("chrome-mcp version %s (commit: %s, date: %s)\n", version, commit, date)
		return
	}

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
			if debug {
				debugLog("Extension WS received: type=%s, msgLen=%d", msgType, len(message))
			}

			switch msgType {
			case "command_complete":
				cmdID, _ := msg["cmd_id"].(string)
				result, _ := msg["result"]
				resultStr, _ := json.Marshal(result)
				hub.BroadcastResult(&CommandResult{
					cmdID:  cmdID,
					Status: "completed",
					Result: string(resultStr),
				})
				if err := db.CompleteCommand(cmdID, string(resultStr)); err != nil && debug {
					debugLog("Failed to persist command completion %s: %v", cmdID, err)
				}
				if debug {
					if meta, ok := hub.popCommandMeta(cmdID); ok {
						debugLog("Command completed: %s (%s) tab=%s duration_ms=%d", cmdID, meta.CmdType, meta.TabID, time.Since(meta.StartedAt).Milliseconds())
					} else {
						debugLog("Command completed: %s", cmdID)
					}
				}

			case "command_failed":
				cmdID, _ := msg["cmd_id"].(string)
				errMsg, _ := msg["error"].(string)
				hub.BroadcastResult(&CommandResult{
					cmdID:  cmdID,
					Status: "failed",
					Error:  errMsg,
				})
				if err := db.FailCommand(cmdID, errMsg); err != nil && debug {
					debugLog("Failed to persist command failure %s: %v", cmdID, err)
				}
				if debug {
					if meta, ok := hub.popCommandMeta(cmdID); ok {
						debugLog("Command failed: %s (%s) tab=%s duration_ms=%d - %s", cmdID, meta.CmdType, meta.TabID, time.Since(meta.StartedAt).Milliseconds(), errMsg)
					} else {
						debugLog("Command failed: %s - %s", cmdID, errMsg)
					}
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
	toolMiddleware := server.ToolHandlerMiddleware(func(next server.ToolHandlerFunc) server.ToolHandlerFunc {
		return func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			toolName := request.Params.Name
			args := request.GetArguments()
			debugLog("MCP Tool called: name=%s, args=%v", toolName, args)
			result, err := next(ctx, request)
			if err != nil {
				debugLog("MCP Tool error: name=%s, err=%v", toolName, err)
			}
			return result, err
		}
	})

	mcpServer := server.NewMCPServer(
		"chrome-mcp",
		"1.0.0",
		server.WithToolCapabilities(true),
		server.WithLogging(),
		server.WithRecovery(),
		server.WithToolHandlerMiddleware(toolMiddleware),
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
			mcp.WithNumber("timeout_ms", mcp.DefaultNumber(10000), mcp.Description("Timeout in milliseconds")),
		),
		func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			tabID := getTabID(request)
			if tabID == "" {
				return mcp.NewToolResultError("tab_id is required"), nil
			}
			script := request.GetString("script", "")
			if script == "" {
				return mcp.NewToolResultError("script is required for execute_script"), nil
			}
			timeout := request.GetInt("timeout_ms", 10000)
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
			mcp.WithNumber("timeout_ms", mcp.DefaultNumber(8000), mcp.Description("Timeout in milliseconds")),
		),
		func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			tabID := getTabID(request)
			if tabID == "" {
				return mcp.NewToolResultError("tab_id is required"), nil
			}
			maxDepth := request.GetInt("max_depth", 3)
			timeout := request.GetInt("timeout_ms", 8000)
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
			mcp.WithNumber("offset", mcp.DefaultNumber(0), mcp.Description("Offset for pagination")),
			mcp.WithNumber("limit", mcp.DefaultNumber(500), mcp.Description("Limit text characters returned")),
			mcp.WithNumber("timeout_ms", mcp.DefaultNumber(8000), mcp.Description("Timeout in milliseconds")),
		),
		func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			tabID := getTabID(request)
			if tabID == "" {
				return mcp.NewToolResultError("tab_id is required"), nil
			}
			selector := request.GetString("selector", "")
			offset := request.GetInt("offset", 0)
			limit := request.GetInt("limit", 500)
			timeout := request.GetInt("timeout_ms", 8000)
			cmdID := fmt.Sprintf("cmd_%d", time.Now().UnixNano())
			params := fmt.Sprintf(`{"selector":"%s","offset":%d,"limit":%d}`, selector, offset, limit)
			return executeViaWebSocket(cmdID, tabID, "extract_page_content", params, timeout, debug)
		},
	)

	mcpServer.AddTool(
		mcp.NewTool(
			"get_page_source",
			mcp.WithDescription("Get raw HTML source. If you don't know tab IDs, call list_connected_tabs first."),
			mcp.WithString("tab_id", mcp.Required(), mcp.Description("Tab ID")),
			mcp.WithNumber("offset", mcp.DefaultNumber(0), mcp.Description("Start position")),
			mcp.WithNumber("limit", mcp.DefaultNumber(500), mcp.Description("Max characters to return")),
			mcp.WithNumber("timeout_ms", mcp.DefaultNumber(8000), mcp.Description("Timeout in milliseconds")),
		),
		func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			tabID := getTabID(request)
			if tabID == "" {
				return mcp.NewToolResultError("tab_id is required"), nil
			}
			offset := request.GetInt("offset", 0)
			limit := request.GetInt("limit", 500)
			timeout := request.GetInt("timeout_ms", 8000)
			cmdID := fmt.Sprintf("cmd_%d", time.Now().UnixNano())
			params := fmt.Sprintf(`{"offset":%d,"limit":%d}`, offset, limit)
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
			mcp.WithNumber("offset", mcp.DefaultNumber(0), mcp.Description("Offset for pagination")),
			mcp.WithNumber("limit", mcp.DefaultNumber(20), mcp.Description("Maximum elements to return (max 50)")),
			mcp.WithNumber("timeout_ms", mcp.DefaultNumber(8000), mcp.Description("Timeout in milliseconds")),
		),
		func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			tabID := getTabID(request)
			if tabID == "" {
				return mcp.NewToolResultError("tab_id is required"), nil
			}
			selector := request.GetString("selector", "")
			if selector == "" {
				return mcp.NewToolResultError("selector is required for find_elements"), nil
			}
			selectorType := request.GetString("selector_type", "css")
			offset := request.GetInt("offset", 0)
			limit := request.GetInt("limit", 20)
			if limit > 50 {
				limit = 50
			}
			timeout := request.GetInt("timeout_ms", 8000)
			cmdID := fmt.Sprintf("cmd_%d", time.Now().UnixNano())
			paramsObj := map[string]interface{}{
				"selector":      selector,
				"selector_type": selectorType,
				"offset":        offset,
				"limit":         limit,
			}
			paramsBytes, _ := json.Marshal(paramsObj)
			params := string(paramsBytes)
			return executeViaWebSocket(cmdID, tabID, "find_elements", params, timeout, debug)
		},
	)

	mcpServer.AddTool(
		mcp.NewTool(
			"get_visible_elements",
			mcp.WithDescription("Get all visible elements with text content. Great for extracting page content quickly."),
			mcp.WithString("tab_id", mcp.Required(), mcp.Description("Tab ID")),
			mcp.WithNumber("max_elements", mcp.DefaultNumber(20), mcp.Description("Maximum elements to return (max 100)")),
			mcp.WithNumber("offset", mcp.DefaultNumber(0), mcp.Description("Offset for pagination")),
			mcp.WithNumber("limit", mcp.DefaultNumber(20), mcp.Description("Maximum elements to return")),
			mcp.WithNumber("min_text_length", mcp.DefaultNumber(1), mcp.Description("Minimum text length")),
			mcp.WithString("include_headings", mcp.DefaultString("true"), mcp.Description("Include headings: 'true' or 'false'")),
			mcp.WithString("include_links", mcp.DefaultString("true"), mcp.Description("Include links: 'true' or 'false'")),
			mcp.WithString("include_buttons", mcp.DefaultString("true"), mcp.Description("Include buttons: 'true' or 'false'")),
			mcp.WithString("include_inputs", mcp.DefaultString("true"), mcp.Description("Include inputs: 'true' or 'false'")),
			mcp.WithString("include_images", mcp.DefaultString("true"), mcp.Description("Include images: 'true' or 'false'")),
			mcp.WithNumber("timeout_ms", mcp.DefaultNumber(8000), mcp.Description("Timeout in milliseconds")),
		),
		func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			tabID := getTabID(request)
			if tabID == "" {
				return mcp.NewToolResultError("tab_id is required"), nil
			}
			limit := request.GetInt("max_elements", 20)
			limit = request.GetInt("limit", limit)
			if limit > 100 {
				limit = 100
			}
			offset := request.GetInt("offset", 0)
			minTextLength := request.GetInt("min_text_length", 1)
			includeHeadings := request.GetString("include_headings", "true") == "true"
			includeLinks := request.GetString("include_links", "true") == "true"
			includeButtons := request.GetString("include_buttons", "true") == "true"
			includeInputs := request.GetString("include_inputs", "true") == "true"
			includeImages := request.GetString("include_images", "true") == "true"
			timeout := request.GetInt("timeout_ms", 8000)
			cmdID := fmt.Sprintf("cmd_%d", time.Now().UnixNano())
			params := fmt.Sprintf(`{"offset":%d,"limit":%d,"max_elements":%d,"min_text_length":%d,"include_headings":%v,"include_links":%v,"include_buttons":%v,"include_inputs":%v,"include_images":%v}`,
				offset, limit, limit, minTextLength, includeHeadings, includeLinks, includeButtons, includeInputs, includeImages)
			return executeViaWebSocket(cmdID, tabID, "get_visible_elements", params, timeout, debug)
		},
	)

	mcpServer.AddTool(
		mcp.NewTool(
			"get_element_details",
			mcp.WithDescription("Get detailed element info. If you don't know tab IDs, call list_connected_tabs first."),
			mcp.WithString("tab_id", mcp.Required(), mcp.Description("Tab ID")),
			mcp.WithString("selector", mcp.Required(), mcp.Description("CSS selector")),
			mcp.WithNumber("timeout_ms", mcp.DefaultNumber(8000), mcp.Description("Timeout in milliseconds")),
		),
		func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			tabID := getTabID(request)
			if tabID == "" {
				return mcp.NewToolResultError("tab_id is required"), nil
			}
			selector := request.GetString("selector", "")
			if selector == "" {
				return mcp.NewToolResultError("selector is required for get_element_details"), nil
			}
			timeout := request.GetInt("timeout_ms", 8000)
			cmdID := fmt.Sprintf("cmd_%d", time.Now().UnixNano())
			paramsObj := map[string]interface{}{
				"selector": selector,
			}
			paramsBytes, _ := json.Marshal(paramsObj)
			params := string(paramsBytes)
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
			paramsObj := map[string]interface{}{
				"selector":   selector,
				"timeout_ms": timeout,
			}
			paramsBytes, _ := json.Marshal(paramsObj)
			params := string(paramsBytes)
			return executeViaWebSocket(cmdID, tabID, "wait_for_element", params, timeout+5000, debug)
		},
	)

	mcpServer.AddTool(
		mcp.NewTool(
			"search_text",
			mcp.WithDescription("Search for text within visible page elements like grep. Returns matches with context snippets."),
			mcp.WithString("tab_id", mcp.Required(), mcp.Description("Tab ID")),
			mcp.WithString("pattern", mcp.Required(), mcp.Description("Text or pattern to search for")),
			mcp.WithString("text", mcp.Description("Alias for pattern")),
			mcp.WithString("query", mcp.Description("Alias for pattern")),
			mcp.WithString("search_term", mcp.Description("Alias for pattern")),
			mcp.WithString("search_query", mcp.Description("Alias for pattern")),
			mcp.WithString("search_string", mcp.Description("Alias for pattern")),
			mcp.WithString("match", mcp.Description("Alias for pattern")),
			mcp.WithString("case_sensitive", mcp.DefaultString("false"), mcp.Description("Case sensitive search: 'true' or 'false'")),
			mcp.WithString("whole_word", mcp.DefaultString("false"), mcp.Description("Match whole words only: 'true' or 'false'")),
			mcp.WithString("regex", mcp.DefaultString("false"), mcp.Description("Treat pattern as regex: 'true' or 'false'")),
			mcp.WithNumber("max_results", mcp.DefaultNumber(20), mcp.Description("Maximum number of results to collect")),
			mcp.WithNumber("offset", mcp.DefaultNumber(0), mcp.Description("Offset for pagination")),
			mcp.WithNumber("limit", mcp.DefaultNumber(20), mcp.Description("Limit results returned")),
			mcp.WithNumber("timeout_ms", mcp.DefaultNumber(8000), mcp.Description("Timeout in milliseconds")),
		),
		func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			tabID := getTabID(request)
			if tabID == "" {
				return mcp.NewToolResultError("tab_id is required"), nil
			}
			pattern := request.GetString("pattern", "")
			if pattern == "" {
				pattern = request.GetString("text", "")
			}
			if pattern == "" {
				pattern = request.GetString("query", "")
			}
			if pattern == "" {
				pattern = request.GetString("search_term", "")
			}
			if pattern == "" {
				pattern = request.GetString("search_query", "")
			}
			if pattern == "" {
				pattern = request.GetString("search_string", "")
			}
			if pattern == "" {
				pattern = request.GetString("match", "")
			}
			if pattern == "" {
				return mcp.NewToolResultError("pattern is required"), nil
			}
			caseSens := request.GetString("case_sensitive", "false") == "true"
			wholeWord := request.GetString("whole_word", "false") == "true"
			isRegex := request.GetString("regex", "false") == "true"
			maxResults := request.GetInt("max_results", 20)
			offset := request.GetInt("offset", 0)
			limit := request.GetInt("limit", 20)
			paramsObj := map[string]interface{}{
				"pattern":        pattern,
				"case_sensitive": caseSens,
				"whole_word":     wholeWord,
				"regex":          isRegex,
				"max_results":    maxResults,
				"offset":         offset,
				"limit":          limit,
			}
			paramsBytes, _ := json.Marshal(paramsObj)
			params := string(paramsBytes)
			timeout := request.GetInt("timeout_ms", 8000)
			cmdID := fmt.Sprintf("cmd_%d", time.Now().UnixNano())
			return executeViaWebSocket(cmdID, tabID, "search_text", params, timeout, debug)
		},
	)

	mcpServer.AddTool(
		mcp.NewTool(
			"click_element",
			mcp.WithDescription("Click an element on the page using CSS selector."),
			mcp.WithString("tab_id", mcp.Required(), mcp.Description("Tab ID")),
			mcp.WithString("selector", mcp.Required(), mcp.Description("CSS selector")),
			mcp.WithNumber("index", mcp.DefaultNumber(0), mcp.Description("Index if multiple elements match (default 0)")),
			mcp.WithNumber("timeout_ms", mcp.DefaultNumber(8000), mcp.Description("Timeout in milliseconds")),
		),
		func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			tabID := getTabID(request)
			selector := request.GetString("selector", "")
			textParam := request.GetString("text", "")
			debugLog("click_element: tabID=%s, selector=%s, text=%s", tabID, selector, textParam)
			if tabID == "" {
				return mcp.NewToolResultError("tab_id is required"), nil
			}
			if selector == "" && textParam != "" {
				selector = fmt.Sprintf("*:contains('%s')", textParam)
				debugLog("click_element: built selector from text: %s", selector)
			}
			if selector == "" {
				return mcp.NewToolResultError("selector is required"), nil
			}
			index := request.GetInt("index", 0)
			timeout := request.GetInt("timeout_ms", 8000)
			cmdID := fmt.Sprintf("cmd_%d", time.Now().UnixNano())
			paramsObj := map[string]interface{}{
				"selector": selector,
				"index":    index,
			}
			paramsBytes, _ := json.Marshal(paramsObj)
			params := string(paramsBytes)
			debugLog("click_element: cmdID=%s, params=%s", cmdID, params)
			return executeViaWebSocket(cmdID, tabID, "click_element", params, timeout, debug)
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
	pollTicker := time.NewTicker(100 * time.Millisecond)
	defer pollTicker.Stop()

	pollDB, err := chromedb.NewSharedDB(getDBPath())
	if err != nil {
		debugLog("DB poll unavailable for cmdID=%s: %v", cmdID, err)
	} else {
		defer pollDB.Close()
	}

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

				if resultCmdID != cmdID {
					debugLog("Ignoring result for cmdID=%s (waiting for %s)", resultCmdID, cmdID)
					continue
				}

				var status string
				var resultBytes []byte
				var errMsg string
				if msgType == "command_failed" {
					status = "failed"
					errMsg, _ = msg["error"].(string)
				} else {
					status = "completed"
					if msgType == "result" {
						if wsStatus, ok := msg["status"].(string); ok && wsStatus != "" {
							status = wsStatus
						}
						if status == "failed" {
							errMsg, _ = msg["error"].(string)
						}
					}
					var result interface{}
					result, _ = msg["result"]
					switch v := result.(type) {
					case string:
						resultBytes = []byte(v)
					default:
						resultBytes, _ = json.Marshal(result)
					}
				}

				cmdResult := &CommandResult{
					cmdID:  resultCmdID,
					Status: status,
					Result: string(resultBytes),
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

	timeoutTimer := time.NewTimer(time.Duration(timeoutMs) * time.Millisecond)
	defer timeoutTimer.Stop()
	doneCh := done

	for {
		select {
		case result := <-resultChan:
			debugLog("MCP WS got result: status=%s, cmdID=%s", result.Status, result.cmdID)
			if result.Status == "completed" || result.Status == "success" {
				return mcp.NewToolResultText(result.Result), nil
			}
			return mcp.NewToolResultError(result.Error), nil
		case <-doneCh:
			if pollDB == nil {
				return mcp.NewToolResultError("connection closed"), nil
			}
			debugLog("MCP WS closed for cmdID=%s, continuing with DB poll fallback", cmdID)
			doneCh = nil
		case <-pollTicker.C:
			if pollDB != nil {
				if dbResult, ok := commandResultFromDB(pollDB, cmdID); ok {
					debugLog("Resolved result via DB poll: cmdID=%s status=%s", cmdID, dbResult.Status)
					if dbResult.Status == "completed" || dbResult.Status == "success" {
						return mcp.NewToolResultText(dbResult.Result), nil
					}
					return mcp.NewToolResultError(dbResult.Error), nil
				}
			}
		case <-timeoutTimer.C:
			return mcp.NewToolResultError(fmt.Sprintf("timeout after %dms waiting for result", timeoutMs)), nil
		}
	}
}

func getTabsFromDaemon(debug bool) ([]map[string]interface{}, error) {
	daemonURL := getDaemonURL()

	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(daemonURL + "/tabs")
	if err != nil {
		return nil, fmt.Errorf("daemon connection failed: %v", err)
	}
	defer resp.Body.Close()

	var result map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("invalid response: %v", err)
	}

	if result["type"] != "success" {
		return nil, fmt.Errorf("API error")
	}

	resultList, ok := result["result"].([]interface{})
	if !ok {
		return nil, fmt.Errorf("invalid response format")
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

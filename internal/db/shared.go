package db

import (
	"database/sql"
	"fmt"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

type Tab struct {
	ID        string    `json:"id"`
	ChromeID  int       `json:"chrome_tab_id"`
	WindowID  int       `json:"window_id"`
	Title     string    `json:"title"`
	URL       string    `json:"url"`
	IsActive  bool      `json:"is_active"`
	CreatedAt time.Time `json:"created_at"`
}

type SharedDB struct {
	db  *sql.DB
	mu  sync.RWMutex
	dsn string
}

func NewSharedDB(path string) (*SharedDB, error) {
	db, err := sql.Open("sqlite", path+"?mode=rwc&_journal_mode=WAL")
	if err != nil {
		return nil, fmt.Errorf("failed to open database: %w", err)
	}

	if err := db.Ping(); err != nil {
		db.Close()
		// Create new database if it doesn't exist
		db, err = sql.Open("sqlite", path+"?mode=rwc&_journal_mode=WAL")
		if err != nil {
			return nil, fmt.Errorf("failed to create database: %w", err)
		}
	}

	shared := &SharedDB{
		db:  db,
		dsn: path,
	}

	if err := shared.initSchema(); err != nil {
		db.Close()
		return nil, fmt.Errorf("failed to init schema: %w", err)
	}

	return shared, nil
}

func (s *SharedDB) initSchema() error {
	schema := `
	CREATE TABLE IF NOT EXISTS tabs (
		id TEXT PRIMARY KEY,
		chrome_id INTEGER NOT NULL,
		window_id INTEGER DEFAULT 0,
		title TEXT,
		url TEXT,
		is_active INTEGER DEFAULT 0,
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP
	);
	CREATE INDEX IF NOT EXISTS idx_tabs_chrome_id ON tabs(chrome_id);

	CREATE TABLE IF NOT EXISTS commands (
		id TEXT PRIMARY KEY,
		tab_id TEXT NOT NULL,
		type TEXT NOT NULL,
		params TEXT,
		result TEXT,
		status TEXT DEFAULT 'pending',
		created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
		completed_at DATETIME
	);
	CREATE INDEX IF NOT EXISTS idx_commands_status ON commands(status);
	CREATE INDEX IF NOT EXISTS idx_commands_tab ON commands(tab_id);
	`
	_, err := s.db.Exec(schema)
	return err
}

type Command struct {
	ID          string     `json:"id"`
	TabID       string     `json:"tab_id"`
	Type        string     `json:"type"`
	Params      string     `json:"params"`
	Result      string     `json:"result"`
	Status      string     `json:"status"`
	CreatedAt   time.Time  `json:"created_at"`
	CompletedAt *time.Time `json:"completed_at,omitempty"`
}

func (s *SharedDB) AddCommand(cmd *Command) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(`
		INSERT INTO commands (id, tab_id, type, params, status, created_at)
		VALUES (?, ?, ?, ?, 'pending', ?)
	`, cmd.ID, cmd.TabID, cmd.Type, cmd.Params, cmd.CreatedAt)
	return err
}

func (s *SharedDB) GetCommand(id string) (*Command, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	cmd := &Command{}
	var completedAt sql.NullTime
	err := s.db.QueryRow(`
		SELECT id, tab_id, type, params, result, status, created_at, completed_at
		FROM commands WHERE id = ?
	`, id).Scan(&cmd.ID, &cmd.TabID, &cmd.Type, &cmd.Params, &cmd.Result, &cmd.Status, &cmd.CreatedAt, &completedAt)
	if err != nil {
		return nil, err
	}
	if completedAt.Valid {
		cmd.CompletedAt = &completedAt.Time
	}
	return cmd, nil
}

func (s *SharedDB) ListPendingCommands() ([]*Command, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	rows, err := s.db.Query(`
		SELECT id, tab_id, type, params, result, status, created_at, completed_at
		FROM commands
		WHERE status = 'pending'
		ORDER BY created_at ASC
		LIMIT 10
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var cmds []*Command
	for rows.Next() {
		cmd := &Command{}
		var completedAt sql.NullTime
		err := rows.Scan(&cmd.ID, &cmd.TabID, &cmd.Type, &cmd.Params, &cmd.Result, &cmd.Status, &cmd.CreatedAt, &completedAt)
		if err != nil {
			return nil, err
		}
		if completedAt.Valid {
			cmd.CompletedAt = &completedAt.Time
		}
		cmds = append(cmds, cmd)
	}
	return cmds, rows.Err()
}

func (s *SharedDB) CompleteCommand(id, result string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(`
		UPDATE commands SET status = 'completed', result = ?, completed_at = ?
		WHERE id = ?
	`, result, time.Now(), id)
	return err
}

func (s *SharedDB) FailCommand(id, errMsg string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(`
		UPDATE commands SET status = 'failed', result = ?, completed_at = ?
		WHERE id = ?
	`, errMsg, time.Now(), id)
	return err
}

func (s *SharedDB) DeleteCommand(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec("DELETE FROM commands WHERE id = ?", id)
	return err
}

func (s *SharedDB) AddTab(tab *Tab) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec(`
		INSERT OR REPLACE INTO tabs (id, chrome_id, window_id, title, url, is_active, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`, tab.ID, tab.ChromeID, tab.WindowID, tab.Title, tab.URL, tab.IsActive, tab.CreatedAt)
	return err
}

func (s *SharedDB) RemoveTab(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	_, err := s.db.Exec("DELETE FROM tabs WHERE id = ?", id)
	return err
}

func (s *SharedDB) ListTabs() ([]*Tab, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	rows, err := s.db.Query(`
		SELECT id, chrome_id, window_id, title, url, is_active, created_at 
		FROM tabs 
		ORDER BY created_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var tabs []*Tab
	for rows.Next() {
		tab := &Tab{}
		err := rows.Scan(&tab.ID, &tab.ChromeID, &tab.WindowID, &tab.Title, &tab.URL, &tab.IsActive, &tab.CreatedAt)
		if err != nil {
			return nil, err
		}
		tabs = append(tabs, tab)
	}

	return tabs, rows.Err()
}

func (s *SharedDB) GetTab(id string) (*Tab, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	tab := &Tab{}
	err := s.db.QueryRow(`
		SELECT id, chrome_id, title, url, is_active, created_at 
		FROM tabs 
		WHERE id = ?
	`, id).Scan(&tab.ID, &tab.ChromeID, &tab.Title, &tab.URL, &tab.IsActive, &tab.CreatedAt)
	if err != nil {
		return nil, err
	}
	return tab, nil
}

func (s *SharedDB) Close() error {
	return s.db.Close()
}
